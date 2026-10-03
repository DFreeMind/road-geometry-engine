import { useMemo, useState } from "react";
import type { Feature, LineString, MultiLineString } from "geojson";
import "./RouteFeatureSelector.css";

export type RouteFeature = Feature<LineString | MultiLineString>;

export function filterRouteFeatures(
  features: RouteFeature[],
  field: string,
  query: string,
): number[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return features.map((_, index) => index);
  return features.flatMap((feature, index) => {
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const value =
      field === "*"
        ? JSON.stringify(properties)
        : JSON.stringify(properties[field] ?? null);
    return value?.toLocaleLowerCase().includes(normalized) ? [index] : [];
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

export function RouteFeatureSelector({
  features,
  fields: sourceFields = [],
  onRead,
  onCancel,
}: {
  features: RouteFeature[];
  fields?: Array<string | { name: string }>;
  onRead: (features: RouteFeature[]) => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState("*");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const pageSize = 50;

  const fieldNames = useMemo(() => {
    const names = new Set<string>();
    sourceFields.forEach((field) =>
      names.add(typeof field === "string" ? field : field.name),
    );
    features.forEach((feature) =>
      Object.keys(
        (feature.properties ?? {}) as Record<string, unknown>,
      ).forEach((name) => names.add(name)),
    );
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [features, sourceFields]);
  const filtered = useMemo(
    () => filterRouteFeatures(features, field, query),
    [features, field, query],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageIndexes = routeFeaturePage(filtered, page, pageSize);
  const selectedFeatures = [...selected]
    .sort((a, b) => a - b)
    .map((index) => features[index])
    .filter((feature): feature is RouteFeature => Boolean(feature));

  function changeFilter(nextField: string, nextQuery: string) {
    setField(nextField);
    setQuery(nextQuery);
    setPage(0);
  }

  function toggle(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleFiltered() {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = filtered.every((index) => next.has(index));
      filtered.forEach((index) =>
        allSelected ? next.delete(index) : next.add(index),
      );
      return next;
    });
  }

  return (
    <section className="route-feature-selector" aria-label="路线要素选择器">
      <p className="route-feature-selector__intro">
        搜索字段和值，勾选要素后读取。字段预览保留源数据的完整结构。
      </p>
      <div className="route-feature-selector__filters">
        <label>
          <span>字段</span>
          <select
            aria-label="筛选字段"
            value={field}
            onChange={(event) => changeFilter(event.target.value, query)}
          >
            <option value="*">全部字段</option>
            {fieldNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="route-feature-selector__query">
          <span>值</span>
          <input
            aria-label="搜索字段值"
            value={query}
            onChange={(event) => changeFilter(field, event.target.value)}
            placeholder="输入字段名或字段值"
          />
        </label>
      </div>
      <div className="route-feature-selector__toolbar">
        <span>
          显示 {filtered.length} / {features.length} 条 · 已选 {selected.size}{" "}
          条
        </span>
        <button
          type="button"
          className="button outline"
          disabled={!filtered.length}
          onClick={toggleFiltered}
        >
          {filtered.length > 0 && filtered.every((index) => selected.has(index))
            ? "取消全选筛选结果"
            : "全选筛选结果"}
        </button>
      </div>
      <div className="route-feature-selector__list">
        {pageIndexes.map((index) => {
          const feature = features[index];
          const properties = (feature.properties ?? {}) as Record<
            string,
            unknown
          >;
          const label = String(
            properties.name ??
              properties.route_id ??
              feature.id ??
              `线要素 ${index + 1}`,
          );
          return (
            <article
              className="route-feature-selector__item"
              key={`${index}-${String(feature.id ?? "")}`}
            >
              <label className="route-feature-selector__item-head">
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  onChange={() => toggle(index)}
                  aria-label={`选择 ${label}`}
                />
                <span>
                  <strong>
                    {index + 1}. {label}
                  </strong>
                  <small>{feature.geometry.type}</small>
                </span>
              </label>
              <details>
                <summary>
                  查看全部字段（{Object.keys(properties).length}）
                </summary>
                <pre>{JSON.stringify(properties, null, 2)}</pre>
              </details>
            </article>
          );
        })}
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
          第 {page + 1} / {pageCount} 页
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
          disabled={!selectedFeatures.length}
          onClick={() => onRead(selectedFeatures)}
        >
          读取已选要素（{selectedFeatures.length}）
        </button>
      </div>
    </section>
  );
}
