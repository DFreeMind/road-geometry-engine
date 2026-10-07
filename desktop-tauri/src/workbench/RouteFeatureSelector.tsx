import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, LineString, MultiLineString } from "geojson";
import type { SourceCapabilities } from "./sourceAccess";
import { streamSourcePages } from "./sourceAccess";
import { compileRouteFilter } from "./routeFilterExpression";
import { defaultRouteColumnSelection } from "./routeColumnSelection";
import { isImeComposing } from "./imeKeyboard";
import "./RouteFeatureSelector.css";

export type RouteFeature = Feature<LineString | MultiLineString>;
export type RoutePageLoad = (options: {
  expression: string;
  offset: number;
  limit: number;
}) => Promise<any>;
type PageInfo = {
  offset: number;
  limit: number;
  hasMore: boolean;
  expression: string;
  warning?: string;
};
type SourceField =
  | string
  | {
      name: string;
      type?: string;
      comment?: string | null;
      description?: string | null;
    };
type ReadProgress = {
  pages: number;
  loaded: number;
  nextOffset: number;
  hasMore: boolean;
  cancelled?: boolean;
  failed?: boolean;
};

export function filterRouteFeatures(
  features: RouteFeature[],
  field: string,
  query: string,
): number[] {
  const normalized = query.trim().toLocaleLowerCase();
  return features.flatMap((feature, index) => {
    const properties = feature.properties ?? {};
    const value =
      field === "*"
        ? JSON.stringify(properties)
        : JSON.stringify(properties[field] ?? null);
    return !normalized || value?.toLocaleLowerCase().includes(normalized)
      ? [index]
      : [];
  });
}

export function routeFeaturePage(
  indexes: number[],
  page: number,
  pageSize: number,
): number[] {
  const start = Math.max(0, page) * Math.max(1, pageSize);
  return indexes.slice(start, start + Math.max(1, pageSize));
}

function cellValue(value: unknown): string {
  if (value == null) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function routeFeatures(features: RouteFeature[]): RouteFeature[] {
  return features.filter((feature) =>
    ["LineString", "MultiLineString"].includes(feature.geometry?.type),
  );
}

export function RouteFeatureSelector({
  features: initialFeatures,
  fields: sourceFields = [],
  sourceLabel = "当前数据源",
  capabilities,
  onRead,
  onReadBatch,
  onCancel,
  loadPage,
  pageInfo,
}: {
  features: RouteFeature[];
  fields?: SourceField[];
  onRead: (features: RouteFeature[]) => void;
  onReadBatch?: (features: RouteFeature[], final: boolean) => Promise<void>;
  onCancel: () => void;
  loadPage?: RoutePageLoad;
  pageInfo?: PageInfo;
  sourceLabel?: string;
  capabilities?: SourceCapabilities;
}) {
  const [batch, setBatch] = useState(() => ({
    features: routeFeatures(initialFeatures),
    ...(pageInfo ?? {
      offset: 0,
      limit: initialFeatures.length,
      hasMore: false,
      expression: "",
    }),
  }));
  const features = batch.features;
  // 文件来源只显示文件名与图层名，完整路径保留在提示中，避免挤占读取状态。
  const displaySourceLabel = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(sourceLabel)
    ? sourceLabel.slice(
        Math.max(sourceLabel.lastIndexOf("/"), sourceLabel.lastIndexOf("\\")) +
          1,
      )
    : sourceLabel;
  const [serverDraft, setServerDraft] = useState(batch.expression);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [serverError, setServerError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const alive = useRef(true);
  const allReadRef = useRef<{ cancelled: boolean } | null>(null);
  const requestInFlight = useRef(false);
  const [allReadProgress, setAllReadProgress] = useState<ReadProgress>(() => ({
    pages: 0,
    loaded: routeFeatures(initialFeatures).length,
    nextOffset: (pageInfo?.offset ?? 0) + (pageInfo?.limit ?? 0),
    hasMore: pageInfo?.hasMore ?? false,
  }));
  const [capabilitiesOverride, setCapabilitiesOverride] =
    useState<SourceCapabilities>();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (allReadRef.current) allReadRef.current.cancelled = true;
    };
  }, []);

  const [field, setField] = useState("*");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"simple" | "expression">("simple");
  const [draft, setDraft] = useState("");
  const [expression, setExpression] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [onlySelected, setOnlySelected] = useState(false);
  const [selectedRows, setSelectedRows] = useState(
    new Map<number, RouteFeature>(),
  );
  const selected = useMemo(
    () =>
      new Set(
        features.flatMap((_, index) =>
          selectedRows.has(index) ? [index] : [],
        ),
      ),
    [features, selectedRows],
  );
  function setSelected(
    recipe: Set<number> | ((current: Set<number>) => Set<number>),
  ) {
    const next = typeof recipe === "function" ? recipe(selected) : recipe;
    const rows = new Map(selectedRows);
    features.forEach((feature, index) => {
      if (next.has(index)) rows.set(index, feature);
      else rows.delete(index);
    });
    setSelectedRows(rows);
  }

  const [columnSearch, setColumnSearch] = useState("");
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [localFilterOpen, setLocalFilterOpen] = useState(false);
  const [sourceFilterOpen, setSourceFilterOpen] = useState(false);
  const columnsTrigger = useRef<HTMLButtonElement>(null);
  const columnsSearch = useRef<HTMLInputElement>(null);
  const columnsPanelRef = useRef<HTMLDivElement>(null);
  const expressionInput = useRef<HTMLTextAreaElement>(null);
  const effectiveCapabilities =
    capabilitiesOverride ??
    capabilities ??
    (loadPage
      ? {
          query_scope: "source" as const,
          pagination: true,
          attribute_filter: true,
          spatial_filter: false,
          native_dialect: null,
          stable_order: true,
        }
      : {
          query_scope: "snapshot" as const,
          pagination: false,
          attribute_filter: false,
          spatial_filter: false,
          native_dialect: null,
          stable_order: false,
        });
  const canQuerySource = Boolean(
    loadPage &&
      effectiveCapabilities.query_scope === "source" &&
      effectiveCapabilities.attribute_filter,
  );
  const canPageSource = Boolean(
    loadPage &&
      effectiveCapabilities.query_scope === "source" &&
      effectiveCapabilities.pagination,
  );

  const fields = useMemo(() => {
    const entries = new Map(
      sourceFields.map((item) => {
        const descriptor = typeof item === "string" ? { name: item } : item;
        return [descriptor.name, descriptor] as const;
      }),
    );
    features.forEach((feature) =>
      Object.keys(feature.properties ?? {}).forEach((name) => {
        if (!entries.has(name)) entries.set(name, { name });
      }),
    );
    return [...entries.values()];
  }, [features, sourceFields]);
  const names = useMemo(() => fields.map((item) => item.name), [fields]);
  const deferredQuery = useDeferredValue(query);
  const searchText = useMemo(
    () =>
      features.map((feature) =>
        JSON.stringify(feature.properties ?? {}).toLocaleLowerCase(),
      ),
    [features],
  );
  const [visible, setVisible] = useState<Set<string>>(() =>
    defaultRouteColumnSelection(fields),
  );
  const columns = fields.filter((item) => visible.has(item.name));
  const matchingColumns = fields.filter((item) =>
    `${item.name} ${item.comment ?? ""} ${item.description ?? ""} ${item.type ?? ""}`
      .toLocaleLowerCase()
      .includes(columnSearch.trim().toLocaleLowerCase()),
  );

  useEffect(() => {
    if (!columnsOpen) return;
    columnsSearch.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setColumnsOpen(false);
      requestAnimationFrame(() => columnsTrigger.current?.focus());
    }
    function onPointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !columnsPanelRef.current?.contains(event.target) &&
        !columnsTrigger.current?.contains(event.target)
      )
        setColumnsOpen(false);
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [columnsOpen]);

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    const predicate = expression ? compileRouteFilter(expression, names) : null;
    const indexes = features.flatMap((feature, index) => {
      const matchesSearch =
        !needle ||
        (field === "*"
          ? searchText[index].includes(needle)
          : cellValue(feature.properties?.[field])
              .toLocaleLowerCase()
              .includes(needle));
      if (!matchesSearch) return [];
      return !predicate || predicate(feature.properties ?? {}) ? [index] : [];
    });
    return onlySelected
      ? indexes.filter((index) => selected.has(index))
      : indexes;
  }, [
    features,
    field,
    deferredQuery,
    searchText,
    mode,
    expression,
    names,
    onlySelected,
    selected,
  ]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageIndexes = routeFeaturePage(filtered, safePage, pageSize);
  const selectedFeatures = [...selectedRows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, feature]) => feature);
  const pageSelected =
    pageIndexes.length > 0 && pageIndexes.every((index) => selected.has(index));
  const somePageSelected = pageIndexes.some((index) => selected.has(index));
  const readState = loading
    ? "loading"
    : allReadProgress.hasMore || !canPageSource
      ? "partial"
      : "complete";

  async function readRemaining(
    startOffset: number,
    startLoaded: number,
    readExpression = batch.expression,
    readCapabilities = effectiveCapabilities,
  ) {
    if (
      !loadPage ||
      readCapabilities.query_scope !== "source" ||
      !readCapabilities.pagination ||
      requestInFlight.current
    )
      return;
    const read = { cancelled: false };
    allReadRef.current = read;
    requestInFlight.current = true;
    setLoading(true);
    setStopRequested(false);
    setServerError("");
    setAllReadProgress((progress) => ({
      ...progress,
      pages: 0,
      loaded: startLoaded,
      nextOffset: startOffset,
      hasMore: true,
      cancelled: false,
      failed: false,
    }));
    try {
      const result = await streamSourcePages<RouteFeature>({
        loadPage,
        capabilities: readCapabilities,
        expression: readExpression,
        limit: 2000,
        startOffset,
        isCancelled: () => read.cancelled || !alive.current,
        onBatch: (incoming) => {
          const routes = routeFeatures(incoming);
          if (!routes.length) return;
          setBatch((current) => ({
            ...current,
            features: current.features.concat(routes),
          }));
        },
        onProgress: (progress) => {
          if (alive.current && allReadRef.current === read)
            setAllReadProgress({
              ...progress,
              loaded: startLoaded + progress.loaded,
            });
        },
      });
      if (alive.current && allReadRef.current === read) {
        setAllReadProgress((progress) => ({
          ...progress,
          pages: progress.pages,
          loaded: startLoaded + result.loaded,
          nextOffset: result.nextOffset,
          hasMore: result.hasMore,
          cancelled: result.cancelled,
        }));
      }
    } catch (reason) {
      if (alive.current) {
        setServerError(
          reason instanceof Error ? reason.message : String(reason),
        );
        setAllReadProgress((progress) => ({ ...progress, failed: true }));
      }
    } finally {
      if (allReadRef.current === read) allReadRef.current = null;
      requestInFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!canPageSource) return;
    let timer = 0;
    if (batch.hasMore) {
      const startOffset = batch.offset + batch.limit;
      timer = window.setTimeout(() => {
        if (alive.current)
          void readRemaining(startOffset, batch.features.length);
      }, 0);
    } else {
      setAllReadProgress((progress) => ({
        ...progress,
        loaded: batch.features.length,
        nextOffset: batch.offset + batch.limit,
        hasMore: false,
      }));
    }
    // 仅在选择器初次打开时自动读取后续来源页。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => window.clearTimeout(timer);
  }, []);

  function stopReading() {
    if (allReadRef.current) {
      allReadRef.current.cancelled = true;
      setStopRequested(true);
    }
  }

  async function querySource(nextExpression = serverDraft) {
    if (!loadPage || !canQuerySource || requestInFlight.current) return;
    const requestedExpression = nextExpression.trim();
    requestInFlight.current = true;
    setLoading(true);
    setServerError("");
    try {
      const result = await loadPage({
        offset: 0,
        expression: requestedExpression,
        limit: 2000,
      });
      if (!alive.current) return;
      const resultCapabilities = result.capabilities as
        | SourceCapabilities
        | undefined;
      if (resultCapabilities) setCapabilitiesOverride(resultCapabilities);
      const routes = routeFeatures(result.collection?.features ?? []);
      const nextBatch = {
        features: routes,
        offset: result.offset ?? 0,
        limit: result.page_size ?? 2000,
        hasMore: Boolean(result.has_more ?? result.truncated ?? false),
        expression: requestedExpression,
        warning: result.pagination_warning,
      };
      setBatch(nextBatch);
      setSelectedRows(new Map());
      setServerDraft(requestedExpression);
      setPage(0);
      setQuery("");
      setExpression("");
      setDraft("");
      setError("");
      setOnlySelected(false);
      const nextOffset = nextBatch.offset + nextBatch.limit;
      setAllReadProgress({
        pages: 1,
        loaded: routes.length,
        nextOffset,
        hasMore: nextBatch.hasMore,
      });
      requestInFlight.current = false;
      setLoading(false);
      if (
        nextBatch.hasMore &&
        resultCapabilities?.query_scope !== "snapshot" &&
        resultCapabilities?.pagination !== false
      )
        void readRemaining(
          nextOffset,
          routes.length,
          requestedExpression,
          resultCapabilities ?? effectiveCapabilities,
        );
    } catch (reason) {
      if (alive.current)
        setServerError(
          reason instanceof Error ? reason.message : String(reason),
        );
      requestInFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }

  function applyExpression() {
    try {
      const predicate = compileRouteFilter(draft, names);
      features.forEach((feature) => predicate(feature.properties ?? {}));
      setExpression(draft);
      setError("");
      setPage(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function insertExpression(text: string) {
    const input = expressionInput.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + text + draft.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function toggle(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function confirmSelection() {
    if (!selectedFeatures.length || loading || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    let committedCount = 0;
    try {
      if (onReadBatch && selectedFeatures.length > 2000) {
        for (let start = 0; start < selectedFeatures.length; start += 2000) {
          if (!alive.current) break;
          const chunk = selectedFeatures.slice(start, start + 2000);
          await onReadBatch(
            chunk,
            start + chunk.length === selectedFeatures.length,
          );
          committedCount += chunk.length;
        }
      } else {
        onRead(selectedFeatures);
        committedCount = selectedFeatures.length;
      }
    } catch (reason) {
      setSubmitError(
        committedCount
          ? `加载失败，已提交 ${committedCount} 条路线；请检查地图后再决定是否重试。${reason instanceof Error ? ` ${reason.message}` : ` ${String(reason)}`}`
          : `加载失败，尚未确认任何路线已提交。${reason instanceof Error ? ` ${reason.message}` : ` ${String(reason)}`}`,
      );
    } finally {
      if (alive.current) setSubmitting(false);
    }
  }

  const allReadUnavailable = !canPageSource
    ? "此来源只提供有界快照，无法确认未读取的来源记录。"
    : batch.expression.trim() && !effectiveCapabilities.attribute_filter
      ? "此来源不支持来源级条件查询。"
      : "";
  const localFilterLabel =
    mode === "expression"
      ? expression
        ? `表达式：${expression}`
        : "表达式筛选"
      : query.trim()
        ? `${field === "*" ? "全部字段" : field} 包含“${query.trim()}”`
        : "未设置";

  function selectMatchingColumns(checked: boolean) {
    setVisible((current) => {
      const next = new Set(current);
      matchingColumns.forEach((item) => {
        if (checked) next.add(item.name);
        else next.delete(item.name);
      });
      return next;
    });
  }
  function restoreCommonColumns() {
    setVisible(defaultRouteColumnSelection(fields));
  }

  return (
    <section
      className="route-feature-selector"
      aria-label="路线要素选择器"
      data-read-state={readState}
    >
      <header className="route-feature-selector__header">
        <div className="route-feature-selector__source-summary">
          <strong title={sourceLabel}>{displaySourceLabel}</strong>
          <span
            className={`route-feature-selector__read-status is-${readState}`}
            role="status"
          >
            {loading
              ? `正在读取来源 · 已载入 ${allReadProgress.loaded} 条`
              : readState === "complete"
                ? `全部读取完成 · ${features.length} 条`
                : canPageSource
                  ? `已载入 ${features.length} 条 · 来源尚未完整读取`
                  : `已载入快照 ${features.length} 条 · 来源可用范围受限`}
          </span>
          {effectiveCapabilities.stable_order === false && canPageSource && (
            <small>
              来源排序未确认稳定，读取期间源数据变化可能影响分页结果。
            </small>
          )}
        </div>
        <div className="route-feature-selector__read-actions">
          {loading ? (
            <button
              type="button"
              className="button outline"
              onClick={stopReading}
            >
              停止读取
            </button>
          ) : canPageSource && allReadProgress.hasMore ? (
            <button
              type="button"
              className="button outline"
              onClick={() =>
                void readRemaining(allReadProgress.nextOffset, features.length)
              }
            >
              {allReadProgress.failed ? "重试读取" : "继续读取"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="route-feature-selector__toolbar">
        <label className="route-feature-selector__search">
          <span>搜索</span>
          <select
            aria-label="筛选字段"
            value={field}
            onChange={(event) => {
              setField(event.target.value);
              setPage(0);
            }}
          >
            <option value="*">全部字段</option>
            {fields.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          <input
            aria-label="搜索字段值"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder="搜索已载入路线"
          />
        </label>
        <button
          type="button"
          className="button outline"
          aria-expanded={localFilterOpen}
          onClick={() => {
            setLocalFilterOpen((open) => !open);
            setSourceFilterOpen(false);
          }}
        >
          高级筛选{expression ? " · 已应用" : ""}
        </button>
        {loadPage && (
          <button
            type="button"
            className="button outline"
            aria-expanded={sourceFilterOpen}
            onClick={() => {
              setSourceFilterOpen((open) => !open);
              setLocalFilterOpen(false);
            }}
          >
            来源条件
          </button>
        )}
        <label className="route-feature-selector__only-selected">
          <input
            type="checkbox"
            aria-label="只看已选"
            checked={onlySelected}
            onChange={(event) => {
              setOnlySelected(event.target.checked);
              setPage(0);
            }}
          />
          只看已选
        </label>
        <span className="route-feature-selector__match-count">
          匹配 {filtered.length} / {features.length} · 已选 {selectedRows.size}
        </span>
        <button
          ref={columnsTrigger}
          type="button"
          className="button outline"
          aria-haspopup="dialog"
          aria-expanded={columnsOpen}
          aria-controls="route-feature-column-panel"
          onClick={() => setColumnsOpen((open) => !open)}
        >
          显示字段 {columns.length}/{fields.length}
        </button>
      </div>

      {canQuerySource && sourceFilterOpen && (
        <div className="route-feature-selector__remote route-feature-selector__panel">
          <div className="route-feature-selector__remote-heading">
            <strong>来源条件查询</strong>
            <small>查询整个数据源，成功后从所有匹配路线中继续自动读取。</small>
          </div>
          <div className="route-feature-selector__remote-controls">
            <input
              aria-label="数据源筛选条件"
              value={serverDraft}
              onChange={(event) => setServerDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isImeComposing(event.nativeEvent))
                  void querySource();
              }}
              placeholder={"例如 left(\"路线编号\", 3) = 'G10'"}
              disabled={loading}
            />
            <button
              type="button"
              className="button outline"
              disabled={loading}
              onClick={() => void querySource()}
            >
              查询整个来源
            </button>
          </div>
          <small>当前来源条件：{batch.expression || "无条件"}</small>
        </div>
      )}
      {!canPageSource && (
        <p className="route-feature-selector__snapshot-note" role="status">
          {allReadUnavailable} 当前显示 {features.length}{" "}
          条已载入快照；本地筛选只覆盖这些记录。
        </p>
      )}
      {batch.warning && (
        <p className="route-feature-selector__warning">{batch.warning}</p>
      )}
      {serverError && (
        <p role="alert" className="route-feature-selector__error">
          {serverError}；当前表格与选择保持不变。
        </p>
      )}

      {localFilterOpen && (
        <div className="route-feature-selector__local-filter route-feature-selector__panel">
          <div className="route-feature-selector__filter-heading">
            <div>
              <strong>已载入数据筛选</strong>
              <small>{localFilterLabel}</small>
            </div>
            <div
              className="route-feature-selector__mode"
              role="group"
              aria-label="本批筛选方式"
            >
              <button
                type="button"
                aria-pressed={mode === "simple"}
                onClick={() => {
                  setMode("simple");
                  setPage(0);
                }}
              >
                快速筛选
              </button>
              <button
                type="button"
                aria-pressed={mode === "expression"}
                onClick={() => {
                  setMode("expression");
                  setPage(0);
                }}
              >
                表达式
              </button>
            </div>
          </div>
          {mode === "expression" && (
            <div className="route-feature-selector__expression">
              <label htmlFor="route-filter-condition">本地表达式条件</label>
              <div className="route-feature-selector__filters">
                <select
                  aria-label="插入条件字段"
                  value=""
                  onChange={(event) =>
                    insertExpression(
                      '"' + event.target.value.replaceAll('"', '""') + '"',
                    )
                  }
                >
                  <option value="" disabled>
                    插入字段…
                  </option>
                  {fields.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="插入条件函数"
                  value=""
                  onChange={(event) => insertExpression(event.target.value)}
                >
                  <option value="" disabled>
                    插入函数示例…
                  </option>
                  <option value={'left("字段", 3)'}>left · 取左侧字符</option>
                  <option value={'right("字段", 2)'}>right · 取右侧字符</option>
                  <option value={'lower("字段")'}>lower · 转小写</option>
                  <option value={'coalesce("字段", 0)'}>
                    coalesce · 空值替代
                  </option>
                </select>
              </div>
              <textarea
                ref={expressionInput}
                id="route-filter-condition"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby="route-filter-help"
                placeholder={`left("路线编号", 3) = 'G10' AND "车道数" >= 2`}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter" &&
                    !isImeComposing(event.nativeEvent)
                  ) {
                    event.preventDefault();
                    applyExpression();
                  }
                }}
              />
              <div className="route-feature-selector__expression-actions">
                <button
                  type="button"
                  className="button primary"
                  onClick={applyExpression}
                >
                  应用条件
                </button>
                <button
                  type="button"
                  className="button outline"
                  onClick={() => {
                    setDraft("");
                    setExpression("");
                    setError("");
                    setPage(0);
                  }}
                >
                  清除条件
                </button>
                <span>Ctrl+Enter 应用 · 仅筛选当前已载入记录</span>
              </div>
              {error && (
                <p role="alert" className="route-feature-selector__error">
                  {error}；仍显示上次有效条件的结果。
                </p>
              )}
              <details id="route-filter-help">
                <summary>表达式语法帮助</summary>
                <p>
                  支持
                  left、right、lower、upper、trim、length、coalesce；比较、AND /
                  OR / NOT、LIKE / ILIKE、IN、IS NULL。
                </p>
                <code>{`left("路线编号", 3) = 'G10' AND right("路线编号", 2) IN ('01', '02')`}</code>
              </details>
              {expression && (
                <div className="route-feature-selector__active">
                  已应用：<code>{expression}</code>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {columnsOpen && (
        <div
          ref={columnsPanelRef}
          id="route-feature-column-panel"
          className="route-feature-selector__column-popover"
          role="dialog"
          aria-label="显示字段"
        >
          <div className="route-feature-selector__column-heading">
            <strong>选择显示字段</strong>
            <button
              type="button"
              className="button outline"
              aria-label="关闭显示字段面板"
              onClick={() => {
                setColumnsOpen(false);
                columnsTrigger.current?.focus();
              }}
            >
              关闭
            </button>
          </div>
          <input
            ref={columnsSearch}
            aria-label="搜索显示字段"
            placeholder="搜索字段名称或注释"
            value={columnSearch}
            onChange={(event) => setColumnSearch(event.target.value)}
          />
          <div className="route-feature-selector__column-actions">
            <button
              type="button"
              className="button outline"
              onClick={() => selectMatchingColumns(true)}
            >
              全选匹配
            </button>
            <button
              type="button"
              className="button outline"
              onClick={() => selectMatchingColumns(false)}
            >
              清空匹配
            </button>
            <button
              type="button"
              className="button outline"
              onClick={restoreCommonColumns}
            >
              恢复常用
            </button>
            <button
              type="button"
              className="button outline"
              onClick={() => setVisible(new Set(names))}
            >
              显示全部
            </button>
          </div>
          <small className="route-feature-selector__column-count">
            已显示 {columns.length} 项 · 匹配 {matchingColumns.length} 项
          </small>
          <div className="route-feature-selector__column-list">
            {matchingColumns.map((item) => (
              <label key={item.name}>
                <input
                  type="checkbox"
                  checked={visible.has(item.name)}
                  onChange={() =>
                    setVisible((current) => {
                      const next = new Set(current);
                      if (next.has(item.name)) next.delete(item.name);
                      else next.add(item.name);
                      return next;
                    })
                  }
                />
                <span>
                  {item.name}
                  <small>
                    {item.comment || item.description || item.type || ""}
                  </small>
                </span>
              </label>
            ))}
            {!matchingColumns.length && <p>没有匹配的字段。</p>}
          </div>
          <small>按 Esc 或点击面板外关闭；表头保留字段注释。</small>
        </div>
      )}

      {sourceFilterOpen && !canQuerySource && (
        <div className="route-feature-selector__remote route-feature-selector__panel">
          <strong>来源条件查询不可用</strong>
          <small>
            {effectiveCapabilities.query_scope === "snapshot"
              ? "此来源仅提供有界快照，无法查询全部来源。"
              : "此来源不支持属性条件查询。"}
          </small>
        </div>
      )}

      <div
        className="route-feature-selector__table-scroll"
        tabIndex={0}
        aria-label="路线属性表，可横向滚动"
      >
        <table
          className="route-feature-selector__table"
          style={{ minWidth: 246 + columns.length * 120 }}
        >
          <colgroup>
            <col style={{ width: 42 }} />
            <col style={{ width: 64 }} />
            <col style={{ width: 140 }} />
            {columns.map((item) => (
              <col key={item.name} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="route-feature-selector__check">
                <input
                  type="checkbox"
                  aria-label="选择当前页"
                  checked={pageSelected}
                  ref={(element) => {
                    if (element)
                      element.indeterminate = somePageSelected && !pageSelected;
                  }}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      pageIndexes.forEach((index) =>
                        pageSelected ? next.delete(index) : next.add(index),
                      );
                      return next;
                    })
                  }
                />
              </th>
              <th className="route-feature-selector__row-number">序号</th>
              <th>几何类型</th>
              {columns.map((item) => (
                <th
                  key={item.name}
                  title={`${item.name} · ${item.type ?? ""} · ${item.comment || item.description || ""}`}
                >
                  <span>{item.name}</span>
                  {(item.comment || item.description) && (
                    <small>{item.comment || item.description}</small>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageIndexes.map((index) => (
              <tr
                key={index}
                className={selected.has(index) ? "is-selected" : ""}
                onClick={(event) => {
                  if (
                    (event.target as HTMLElement).closest(
                      "button,input,select,a",
                    )
                  )
                    return;
                  toggle(index);
                }}
              >
                <td className="route-feature-selector__check">
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={() => toggle(index)}
                    aria-label={`选择第 ${index + 1} 条路线`}
                  />
                </td>
                <td className="route-feature-selector__row-number">
                  {index + 1}
                </td>
                <td>{features[index].geometry.type}</td>
                {columns.map((item) => {
                  const value = features[index].properties?.[item.name];
                  const text = cellValue(value);
                  return (
                    <td
                      key={item.name}
                      title={text}
                      className={value == null ? "is-null" : ""}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="route-feature-selector__empty">没有匹配的线要素。</p>
        )}
      </div>

      <div className="route-feature-selector__table-footer">
        <button
          type="button"
          className="button outline"
          disabled={!filtered.length || loading}
          onClick={() =>
            setSelected((current) => {
              const next = new Set(current);
              const allFilteredSelected = filtered.every((index) =>
                selected.has(index),
              );
              filtered.forEach((index) =>
                allFilteredSelected ? next.delete(index) : next.add(index),
              );
              return next;
            })
          }
        >
          {filtered.length > 0 && filtered.every((index) => selected.has(index))
            ? "取消全选筛选结果"
            : "全选筛选结果"}
        </button>
        <button
          type="button"
          className="button outline"
          disabled={!selectedRows.size || loading || submitting}
          onClick={() => {
            setSelectedRows(new Map());
            setOnlySelected(false);
          }}
        >
          清空选择
        </button>
        <label className="route-feature-selector__page-size">
          每页
          <select
            aria-label="每页显示条数"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(0);
            }}
          >
            {[50, 100, 200].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          条
        </label>
        <div className="route-feature-selector__pagination" aria-label="分页">
          <button
            type="button"
            className="button outline"
            disabled={safePage <= 0}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            上一页
          </button>
          <label>
            第{" "}
            <input
              aria-label="跳转页码"
              type="number"
              min={1}
              max={pageCount}
              value={safePage + 1}
              onChange={(event) => {
                const nextPage = Number(event.target.value);
                if (Number.isFinite(nextPage))
                  setPage(Math.max(0, Math.min(pageCount - 1, nextPage - 1)));
              }}
            />{" "}
            / {pageCount} 页
          </label>
          <button
            type="button"
            className="button outline"
            disabled={safePage + 1 >= pageCount}
            onClick={() =>
              setPage((value) => Math.min(pageCount - 1, value + 1))
            }
          >
            下一页
          </button>
        </div>
      </div>

      <div className="route-feature-selector__bottom">
        <div
          className="route-feature-selector__bottom-status"
          aria-live="polite"
        >
          {loading
            ? stopRequested
              ? `正在停止读取；已保留 ${features.length} 条。`
              : `正在读取来源：已读取 ${allReadProgress.loaded} 条，可停止后保留并继续。`
            : allReadProgress.cancelled
              ? `已停止；保留已读 ${features.length} 条，下一位置 ${allReadProgress.nextOffset}。`
              : allReadProgress.failed
                ? `读取中断；保留已读 ${features.length} 条，下一位置 ${allReadProgress.nextOffset}。`
                : readState === "complete"
                  ? `来源读取完成，共 ${features.length} 条。`
                  : `当前为部分来源数据，已读 ${features.length} 条。`}
          {submitError && <span role="alert">{submitError}</span>}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button outline"
            disabled={submitting}
            onClick={() => {
              stopReading();
              onCancel();
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="button primary"
            aria-describedby={
              !selectedFeatures.length || loading || submitting
                ? "route-feature-confirm-reason"
                : undefined
            }
            disabled={!selectedFeatures.length || loading || submitting}
            onClick={() => void confirmSelection()}
          >
            {submitting
              ? "正在加载到地图…"
              : `加载到地图（${selectedFeatures.length}）`}
          </button>
          {(!selectedFeatures.length || loading || submitting) && (
            <span id="route-feature-confirm-reason" className="sr-only">
              {!selectedFeatures.length
                ? "请至少选择一条路线后再加载到地图。"
                : loading
                  ? "来源读取期间不能加载到地图。"
                  : "正在加载到地图，请稍候。"}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
