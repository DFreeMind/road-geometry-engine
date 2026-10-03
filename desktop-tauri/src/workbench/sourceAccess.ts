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
