import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, LineString, MultiLineString } from "geojson";
import type { SourceCapabilities } from "./sourceAccess";
import { compileRouteFilter } from "./routeFilterExpression";
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
export function RouteFeatureSelector({
  features: initialFeatures,
  fields: sourceFields = [],
  sourceLabel = "当前数据源",
  capabilities,
  onRead,
  onCancel,
  loadPage,
  pageInfo,
}: {
  features: RouteFeature[];
  fields?: SourceField[];
  onRead: (features: RouteFeature[]) => void;
  onCancel: () => void;
  loadPage?: RoutePageLoad;
  pageInfo?: PageInfo;
  sourceLabel?: string;
  capabilities?: SourceCapabilities;
}) {
  const [batch, setBatch] = useState(() => ({
    features: initialFeatures,
    ...(pageInfo ?? {
      offset: 0,
      limit: initialFeatures.length,
      hasMore: false,
      expression: "",
    }),
  }));
  const features = batch.features;
  const [serverDraft, setServerDraft] = useState(batch.expression);
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState("");
  const alive = useRef(true);
  const requestId = useRef(0);
  const requestInFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requestId.current++;
    };
  }, []);
  const [field, setField] = useState("*");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"simple" | "expression">("simple");
  const [draft, setDraft] = useState("");
  const [expression, setExpression] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [selectedRows, setSelectedRows] = useState(
    new Map<number, RouteFeature>(),
  );
  const selected = useMemo(
    () =>
      new Set(
        features.flatMap((_, index) =>
          selectedRows.has(batch.offset + index) ? [index] : [],
        ),
      ),
    [features, batch.offset, selectedRows],
  );
  function setSelected(
    recipe: Set<number> | ((current: Set<number>) => Set<number>),
  ) {
    const next = typeof recipe === "function" ? recipe(selected) : recipe;
    const rows = new Map(selectedRows);
    features.forEach((feature, index) => {
      const key = batch.offset + index;
      if (next.has(index)) rows.set(key, feature);
      else rows.delete(key);
    });
    if (rows.size > 10000) {
      setServerError(
        "单次最多选择 10,000 条路线，请缩小数据源读取范围或分层加载。",
      );
      return;
    }
    setSelectedRows(rows);
  }
  const [columnSearch, setColumnSearch] = useState("");
  const expressionInput = useRef<HTMLTextAreaElement>(null);
  const effectiveCapabilities =
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
  const [visible, setVisible] = useState<Set<string>>(() => new Set(names));
  const columns = fields.filter((item) => visible.has(item.name));
  const filtered = useMemo(() => {
    if (mode === "simple") {
      const needle = deferredQuery.trim().toLocaleLowerCase();
      if (field === "*")
        return features.flatMap((_, index) =>
          !needle || searchText[index].includes(needle) ? [index] : [],
        );
      return filterRouteFeatures(features, field, deferredQuery);
    }
    const predicate = compileRouteFilter(expression, names);
    return features.flatMap((feature, index) =>
      predicate(feature.properties ?? {}) ? [index] : [],
    );
  }, [features, field, deferredQuery, searchText, mode, expression, names]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const pageIndexes = routeFeaturePage(
    filtered,
    Math.min(page, pageCount - 1),
    50,
  );
  const selectedFeatures = [...selectedRows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, feature]) => feature);
  const allSelected =
    filtered.length > 0 && filtered.every((index) => selected.has(index));
  async function fetchBatch(offset: number, expression = batch.expression) {
    if (!loadPage || requestInFlight.current) return;
    requestInFlight.current = true;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setServerError("");
    try {
      const result = await loadPage({ offset, expression, limit: batch.limit });
      if (!alive.current || currentRequest !== requestId.current) return;
      const incoming = (result.collection?.features ?? []).filter(
        (feature: RouteFeature) =>
          ["LineString", "MultiLineString"].includes(feature.geometry?.type),
      );
      if (expression !== batch.expression) setSelectedRows(new Map());
      setBatch({
        features: incoming,
        offset: result.offset ?? offset,
        limit: result.page_size ?? batch.limit,
        hasMore:
          canPageSource && (result.has_more ?? result.truncated ?? false),
        expression,
        warning: result.pagination_warning,
      });
      setPage(0);
      setQuery("");
      setExpression("");
      setDraft("");
      setError("");
    } catch (reason) {
      if (alive.current && currentRequest === requestId.current)
        setServerError(
          reason instanceof Error ? reason.message : String(reason),
        );
    } finally {
      if (currentRequest === requestId.current) requestInFlight.current = false;
      if (alive.current && currentRequest === requestId.current)
        setLoading(false);
    }
  }
  function applyExpression() {
    try {
      const predicate = compileRouteFilter(draft, names);
      // 应用前验证当前数据，避免执行错误影响已生效的筛选。
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
  return (
    <section className="route-feature-selector" aria-label="路线要素选择器">
      <div className="route-feature-selector__top-controls">
        {loadPage && (
          <div className="route-feature-selector__source">
            <details
              className="route-feature-selector__remote"
              open={!canQuerySource || batch.hasMore || Boolean(serverError)}
            >
              <summary>
                {sourceLabel} · 本批 {features.length} 条
                {effectiveCapabilities.query_scope === "snapshot"
                  ? " · 当前载入快照"
                  : canQuerySource
                    ? " · 可查询来源"
                    : " · 来源条件筛选不可用"}
              </summary>
              {canQuerySource ? (
                <>
                  <div className="route-feature-selector__remote-controls">
                    <input
                      aria-label="数据源筛选条件"
                      value={serverDraft}
                      onChange={(event) => setServerDraft(event.target.value)}
                      placeholder={
                        "安全表达式筛选来源，例如 left(\"路线编号\", 3) = 'G10'"
                      }
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="button outline"
                      disabled={loading}
                      onClick={() => void fetchBatch(0, serverDraft)}
                    >
                      查询数据源
                    </button>
                  </div>
                  <small>
                    下方筛选只作用于本批；跨批选择会保留，更改数据源条件会清空选择。
                  </small>
                </>
              ) : (
                <small>
                  {effectiveCapabilities.query_scope === "snapshot"
                    ? `此来源当前仅提供已载入快照，不能按来源条件筛选或读取下一批；下方筛选仅作用于这 ${features.length} 条已载入要素。`
                    : "此来源不支持属性条件查询；下方筛选仅作用于当前已载入批次。"}
                </small>
              )}
              {batch.warning && (
                <p className="route-feature-selector__warning">
                  {batch.warning}
                </p>
              )}
              {serverError && (
                <p role="alert" className="route-feature-selector__error">
                  {serverError}
                </p>
              )}
            </details>
          </div>
        )}
        {!loadPage && capabilities?.query_scope === "snapshot" && (
          <p className="route-feature-selector__snapshot-note">
            {sourceLabel}仅提供当前载入快照；下方筛选仅覆盖已载入的{" "}
            {features.length} 条要素。
          </p>
        )}
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
            本批快速筛选
          </button>
          <button
            type="button"
            aria-pressed={mode === "expression"}
            onClick={() => {
              setMode("expression");
              setPage(0);
            }}
          >
            表达式筛选
          </button>
        </div>
        {mode === "simple" ? (
          <div className="route-feature-selector__filters">
            <label>
              筛选字段
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
                    {item.comment || item.description
                      ? " · " + (item.comment || item.description)
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              包含值
              <input
                aria-label="搜索字段值"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder="输入要查找的文本"
              />
            </label>
          </div>
        ) : (
          <div className="route-feature-selector__expression">
            <label htmlFor="route-filter-condition">本批表达式条件</label>
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
                    {item.comment || item.description
                      ? " · " + (item.comment || item.description)
                      : ""}
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
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
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
              <span>Ctrl+Enter 应用</span>
            </div>
            {error && (
              <p role="alert" className="route-feature-selector__error">
                {error}；仍显示上次有效条件的结果。
              </p>
            )}
            <details id="route-filter-help">
              <summary>函数与语法示例</summary>
              <p>
                支持
                left、right、lower、upper、trim、length、coalesce；比较、AND /
                OR / NOT、LIKE / ILIKE、IN、IS
                NULL。字段名可用双引号，文本值用单引号。
              </p>
              <code>{`left("路线编号", 3) = 'G10' AND right("路线编号", 2) IN ('01', '02')`}</code>
              <p>
                这里的条件只筛选当前已载入批次；来源查询能力由数据源类型决定。
              </p>
            </details>
            {expression && (
              <div className="route-feature-selector__active">
                已应用：<code>{expression}</code>
              </div>
            )}
          </div>
        )}
        <details className="route-feature-selector__columns">
          <summary>
            显示字段（{columns.length} / {fields.length}）
          </summary>
          <div className="route-feature-selector__column-actions">
            <input
              aria-label="搜索显示字段"
              placeholder="搜索字段名称或注释"
              value={columnSearch}
              onChange={(event) => setColumnSearch(event.target.value)}
            />
            <button
              type="button"
              className="button outline"
              onClick={() => setVisible(new Set(names))}
            >
              显示全部
            </button>
            <button
              type="button"
              className="button outline"
              onClick={() => setVisible(new Set())}
            >
              隐藏全部
            </button>
          </div>
          <div className="route-feature-selector__column-list">
            {fields
              .filter((item) =>
                (item.name + " " + (item.comment ?? item.description ?? ""))
                  .toLocaleLowerCase()
                  .includes(columnSearch.toLocaleLowerCase()),
              )
              .map((item) => (
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
          </div>
        </details>
      </div>
      {canPageSource && (
        <div
          className="route-feature-selector__source-pager"
          aria-label="数据源批次"
        >
          <button
            type="button"
            className="button outline"
            disabled={loading || batch.offset === 0}
            onClick={() =>
              void fetchBatch(Math.max(0, batch.offset - batch.limit))
            }
          >
            上一批
          </button>
          <span>
            偏移 {batch.offset} · 每批 {batch.limit} 条
            {!effectiveCapabilities.stable_order ? " · 顺序可能变化" : ""}
            {loading ? " · 读取中…" : ""}
          </span>
          <button
            type="button"
            className="button outline"
            disabled={loading || !batch.hasMore}
            onClick={() => void fetchBatch(batch.offset + batch.limit)}
          >
            下一批
          </button>
        </div>
      )}
      <div className="route-feature-selector__toolbar">
        <span>
          本批匹配 {filtered.length} / {features.length} 条 · 已选{" "}
          {selectedRows.size} 条
        </span>
        <div>
          <button
            type="button"
            className="button outline"
            disabled={!filtered.length || loading}
            onClick={() =>
              setSelected((current) => {
                const next = new Set(current);
                filtered.forEach((index) =>
                  allSelected ? next.delete(index) : next.add(index),
                );
                return next;
              })
            }
          >
            {allSelected ? "取消全选筛选结果" : "全选筛选结果"}
          </button>
          <button
            type="button"
            className="button outline"
            disabled={!selectedRows.size || loading}
            onClick={() => setSelectedRows(new Map())}
          >
            清空选择
          </button>
        </div>
      </div>
      <div
        className="route-feature-selector__table-scroll"
        tabIndex={0}
        aria-label="路线属性表，可横向滚动"
      >
        <table className="route-feature-selector__table">
          <thead>
            <tr>
              <th className="route-feature-selector__check">选择</th>
              <th>序号</th>
              <th>几何类型</th>
              {columns.map((item) => (
                <th
                  key={item.name}
                  title={
                    item.name +
                    " · " +
                    (item.type ?? "") +
                    " · " +
                    (item.comment || item.description || "")
                  }
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
              >
                <td className="route-feature-selector__check">
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={() => toggle(index)}
                    aria-label={
                      "选择第 " + (batch.offset + index + 1) + " 条路线"
                    }
                  />
                </td>
                <td>{batch.offset + index + 1}</td>
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
      <div className="route-feature-selector__pagination" aria-label="分页">
        <button
          type="button"
          className="button outline"
          disabled={page <= 0}
          onClick={() => setPage((value) => Math.max(0, value - 1))}
        >
          上一页
        </button>
        <span>
          第 {Math.min(page + 1, pageCount)} / {pageCount} 页 · 每页 50 条
        </span>
        <button
          type="button"
          className="button outline"
          disabled={page + 1 >= pageCount}
          onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
        >
          下一页
        </button>
      </div>
      <div className="dialog-actions">
        <button type="button" className="button outline" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!selectedFeatures.length || loading}
          onClick={() => onRead(selectedFeatures)}
        >
          加载到地图（{selectedFeatures.length}）
        </button>
      </div>
    </section>
  );
}
