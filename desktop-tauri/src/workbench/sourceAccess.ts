import { invoke } from "@tauri-apps/api/core";

export type RouteDataSource =
  | { type: "file"; path: string; layer_name?: string }
  | { type: "connection"; connection: Record<string, unknown> };

export type SourceCapabilities = {
  query_scope: "source" | "snapshot";
  pagination: boolean;
  attribute_filter: boolean;
  spatial_filter: boolean;
  native_dialect: string | null;
  stable_order: boolean;
};

export type SourceQuery = {
  expression: string;
  offset: number;
  limit: number;
  bbox?: [number, number, number, number];
};

export type NativeInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type SourcePage = Record<string, unknown> & {
  capabilities: SourceCapabilities;
};

export type SourcePageProgress = {
  pages: number;
  loaded: number;
  nextOffset: number;
  hasMore: boolean;
};

export type StreamSourcePagesOptions<TFeature = unknown> = {
  loadPage: (query: SourceQuery) => Promise<SourcePage>;
  capabilities: SourceCapabilities;
  expression: string;
  limit: number;
  /** 从上次返回的 nextOffset 继续；loaded/pages 仍只统计本次运行。 */
  startOffset?: number;
  isCancelled?: () => boolean;
  onBatch: (features: TFeature[], final: boolean) => Promise<void> | void;
  onProgress?: (progress: SourcePageProgress) => void;
};

export type StreamSourcePagesResult = SourcePageProgress & {
  cancelled: boolean;
};

const invokeNative: NativeInvoke = (command, args) =>
  invoke<unknown>(command, args);

function isQueryableSource(source: RouteDataSource) {
  if (source.type === "file") return true;
  const kind = source.connection.kind;
  return kind === "gpkg" || kind === "sqlite" || kind === "postgis";
}

function nativeDialect(source: RouteDataSource): string | null {
  if (source.type === "file") {
    return /\.(?:gpkg|sqlite|db)$/i.test(source.path) ? "sqlite" : null;
  }
  if (source.connection.kind === "postgis") return "postgres";
  if (source.connection.kind === "gpkg" || source.connection.kind === "sqlite")
    return "sqlite";
  return null;
}

/** 静态保守能力声明；未知连接只按有界快照处理。 */
export function sourceCapabilities(
  source: RouteDataSource,
): SourceCapabilities {
  if (!isQueryableSource(source))
    return {
      query_scope: "snapshot",
      pagination: false,
      attribute_filter: false,
      spatial_filter: false,
      native_dialect: null,
      stable_order: false,
    };
  return {
    query_scope: "source",
    pagination: true,
    attribute_filter: true,
    spatial_filter: true,
    native_dialect: nativeDialect(source),
    // 稳定顺序依赖真实主键/驱动，由原生端在读取时确认。
    stable_order: false,
  };
}

export function isPageable(capabilities: SourceCapabilities) {
  return capabilities.query_scope === "source" && capabilities.pagination;
}

/** 逐页流式读取来源查询结果；仅短暂持有当前页，不汇总全源要素。 */
export async function streamSourcePages<TFeature = unknown>(
  options: StreamSourcePagesOptions<TFeature>,
): Promise<StreamSourcePagesResult> {
  if (!isPageable(options.capabilities))
    throw new Error("此数据源只支持有界快照，无法加载全部筛选结果。");
  if (options.expression.trim() && !options.capabilities.attribute_filter)
    throw new Error("此数据源不支持来源级属性筛选，无法加载全部筛选结果。");
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 10_000
  )
    throw new Error("每批读取数量必须是 1 到 10000 之间的整数。");
  const startOffset = options.startOffset ?? 0;
  if (!Number.isSafeInteger(startOffset) || startOffset < 0)
    throw new Error("继续读取位置必须是非负安全整数。");

  let offset = startOffset;
  let pages = 0;
  let loaded = 0;
  let hasMore = true;
  const seenOffsets = new Set<number>();
  while (hasMore) {
    if (options.isCancelled?.())
      return { pages, loaded, nextOffset: offset, hasMore, cancelled: true };
    if (seenOffsets.has(offset))
      throw new Error(`来源分页位置 ${offset} 重复，已停止以避免重复读取。`);
    seenOffsets.add(offset);

    const result = await options.loadPage({
      expression: options.expression.trim(),
      offset,
      limit: options.limit,
    });
    if (options.isCancelled?.())
      return { pages, loaded, nextOffset: offset, hasMore, cancelled: true };
    if (!isPageable(result.capabilities))
      throw new Error("数据源返回了有界快照，无法继续来源分页读取。");

    const reportedOffset = result.offset;
    if (
      reportedOffset !== undefined &&
      (!Number.isSafeInteger(reportedOffset) || reportedOffset !== offset)
    )
      throw new Error(
        `来源分页位置异常：请求 ${offset}，数据源返回 ${String(reportedOffset)}。`,
      );
    const collection = result.collection as { features?: unknown } | undefined;
    if (!collection || !Array.isArray(collection.features))
      throw new Error(
        `来源分页 ${offset} 未返回有效要素集合，已保留此前已加载批次。`,
      );
    const features = collection.features as TFeature[];
    if (features.length > options.limit)
      throw new Error(
        `来源分页 ${offset} 返回超过每批上限的要素，已停止读取。`,
      );

    const more = result.has_more ?? result.truncated;
    if (typeof more !== "boolean")
      throw new Error(
        `来源分页 ${offset} 缺少 has_more 状态，无法确认是否已完整读取。`,
      );
    if (more && features.length === 0)
      throw new Error(
        `来源分页 ${offset} 返回空批次但仍报告有后续数据，已停止读取。`,
      );
    const pageSize = result.page_size ?? options.limit;
    if (
      !Number.isSafeInteger(pageSize) ||
      (pageSize as number) < 1 ||
      (pageSize as number) > options.limit
    )
      throw new Error(`来源分页 ${offset} 返回了无效批次长度。`);

    hasMore = more;
    await options.onBatch(features, !hasMore);
    pages++;
    loaded += features.length;
    const nextOffset = offset + (pageSize as number);
    if (hasMore && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset))
      throw new Error(`来源分页位置 ${offset} 未前进，已停止读取。`);
    offset = nextOffset;
    options.onProgress?.({ pages, loaded, nextOffset: offset, hasMore });
  }
  return { pages, loaded, nextOffset: offset, hasMore, cancelled: false };
}

export function buildSourceQuery(options: SourceQuery) {
  if (!Number.isSafeInteger(options.offset) || options.offset < 0)
    throw new Error("读取位置必须是非负整数。");
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 10_000
  )
    throw new Error("每批读取数量必须是 1 到 10000 之间的整数。");
  const query: Record<string, unknown> = {
    expression: options.expression.trim(),
    offset: options.offset,
    limit: options.limit,
  };
  if (options.bbox) {
    if (
      options.bbox.length !== 4 ||
      !options.bbox.every(Number.isFinite) ||
      options.bbox[0] < -180 ||
      options.bbox[0] > 180 ||
      options.bbox[2] < -180 ||
      options.bbox[2] > 180 ||
      options.bbox[1] < -90 ||
      options.bbox[1] > 90 ||
      options.bbox[3] < -90 ||
      options.bbox[3] > 90 ||
      options.bbox[0] >= options.bbox[2] ||
      options.bbox[1] >= options.bbox[3]
    )
      throw new Error("地图范围无效。");
    query.bbox = [...options.bbox];
  }
  return query;
}

/** 读取单批来源数据；凭据只随原始 source 传给本地原生命令，不写入日志或标签。 */
export async function readSourcePage(
  source: RouteDataSource,
  options: SourceQuery,
  invoke: NativeInvoke = invokeNative,
): Promise<SourcePage> {
  const capabilities = sourceCapabilities(source);
  if (
    capabilities.query_scope === "snapshot" &&
    (options.expression.trim() || options.offset !== 0 || options.bbox)
  )
    throw new Error(
      "此数据源只支持有界快照读取，无法筛选、限定地图范围或翻页。",
    );
  const result = (await invoke("query_vector_data", {
    source,
    query: buildSourceQuery(options),
  })) as Record<string, unknown>;
  const nativeCapabilities = result.capabilities;
  const resolvedCapabilities = isSourceCapabilities(nativeCapabilities)
    ? nativeCapabilities
    : capabilities;
  return { ...result, capabilities: resolvedCapabilities };
}

function isSourceCapabilities(value: unknown): value is SourceCapabilities {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SourceCapabilities>;
  return (
    (candidate.query_scope === "source" ||
      candidate.query_scope === "snapshot") &&
    typeof candidate.pagination === "boolean" &&
    typeof candidate.attribute_filter === "boolean" &&
    typeof candidate.spatial_filter === "boolean" &&
    (typeof candidate.native_dialect === "string" ||
      candidate.native_dialect === null) &&
    typeof candidate.stable_order === "boolean"
  );
}
