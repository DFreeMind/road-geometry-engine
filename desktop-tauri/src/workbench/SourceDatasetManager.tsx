import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  FilePlus2,
  LocateFixed,
  MapPinned,
  Pencil,
  Play,
  Plus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import type { Feature } from "geojson";
import type { SourceDataset } from "./sourceBatch";
import "./SourceDatasetManager.css";

type DatasetField = {
  name: string;
  type?: string;
  comment?: string | null;
  description?: string | null;
};

type DatasetFeature = Feature & {
  properties: Record<string, unknown> | null;
  geometry: {
    type: string;
    coordinates: unknown;
  } | null;
};

type SourceDatasetManagerProps = {
  datasets: SourceDataset[];
  working: boolean;
  progress?: {
    completed: number;
    total: number;
    succeeded: number;
    failed: number;
  };
  generatedCounts?: Record<string, number>;
  onAppend: () => void;
  onGenerate: () => void;
  onRemoveDataset: (id: string) => void;
  onRemoveFeatures: (id: string, keys: string[]) => void;
  onSetIncluded: (id: string, keys: string[], included: boolean) => void;
  onEditFeature: (id: string, key: string) => void;
  onConfigureMapping: (id: string) => void;
  onLocateDataset: (id: string) => void;
  onCancel: () => void;
};

const PAGE_SIZE = 50;

function readField(field: unknown): DatasetField | null {
  if (typeof field === "string") return { name: field };
  if (!field || typeof field !== "object" || !("name" in field)) return null;
  const candidate = field as DatasetField;
  return typeof candidate.name === "string" ? candidate : null;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[无法显示]";
    }
  }
  return String(value);
}

function geometryParts(feature: DatasetFeature): number {
  const geometry = feature.geometry;
  if (!geometry) return 0;
  if (geometry.type === "LineString") return 1;
  if (
    geometry.type === "MultiLineString" &&
    Array.isArray(geometry.coordinates)
  )
    return geometry.coordinates.length;
  return 0;
}

function datasetFeatures(dataset: SourceDataset): DatasetFeature[] {
  const collection = dataset.collection as { features?: DatasetFeature[] };
  return Array.isArray(collection?.features) ? collection.features : [];
}

export function SourceDatasetManager({
  datasets,
  working,
  progress,
  generatedCounts,
  onAppend,
  onGenerate,
  onRemoveDataset,
  onRemoveFeatures,
  onSetIncluded,
  onEditFeature,
  onConfigureMapping,
  onLocateDataset,
  onCancel,
}: SourceDatasetManagerProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const [shownColumns, setShownColumns] = useState<Record<string, Set<string>>>(
    {},
  );

  const participatingCount = useMemo(
    () =>
      datasets.reduce((total, dataset) => {
        const keys = dataset.feature_keys ?? [];
        const excluded = new Set(dataset.excluded_keys ?? []);
        return total + keys.filter((key) => !excluded.has(key)).length;
      }, 0),
    [datasets],
  );
  const importedCount = useMemo(
    () =>
      datasets.reduce(
        (total, dataset) => total + datasetFeatures(dataset).length,
        0,
      ),
    [datasets],
  );

  function updateSelected(datasetId: string, next: Set<string>) {
    setSelected((current) => ({ ...current, [datasetId]: next }));
  }

  return (
    <section className="source-dataset-manager" aria-label="来源数据管理">
      <header className="source-dataset-manager__header">
        <div className="source-dataset-manager__heading">
          <div>
            <span className="source-dataset-manager__eyebrow">工程数据</span>
            <h2>参与生成的数据</h2>
          </div>
          <span className="source-dataset-manager__dataset-count">
            {datasets.length} 个来源
          </span>
        </div>
        <div className="source-dataset-manager__overview" aria-live="polite">
          <span>
            已导入 {importedCount} 条 · {datasets.length} 个来源
          </span>
          <span>参与生成 {participatingCount} 条</span>
          <span>
            {generatedCounts
              ? `有效成果 ${Object.values(generatedCounts).reduce((sum, count) => sum + count, 0)} 个线部件`
              : "尚未生成成果"}
          </span>
        </div>
        <div className="source-dataset-manager__primary-actions">
          <button
            type="button"
            className="source-dataset-manager__generate"
            disabled={working || participatingCount === 0}
            onClick={onGenerate}
          >
            <Play size={15} aria-hidden="true" />
            生成全部参与路线
          </button>
          <button
            type="button"
            className="source-dataset-manager__append"
            disabled={working}
            onClick={onAppend}
          >
            <Plus size={15} aria-hidden="true" />
            追加导入
          </button>
        </div>
        {working && (
          <div className="source-dataset-manager__progress" role="status">
            <div className="source-dataset-manager__progress-copy">
              <span>
                {progress
                  ? `正在生成 ${progress.completed}/${progress.total}`
                  : "正在校验或生成当前路线…"}
              </span>
              <span>
                成功 {progress?.succeeded ?? 0} · 失败 {progress?.failed ?? 0}
              </span>
            </div>
            <progress
              max={Math.max(1, progress?.total ?? 1)}
              value={progress?.completed ?? 0}
              aria-label="生成进度"
            />
            <button type="button" onClick={onCancel} aria-label="取消生成">
              <X size={14} aria-hidden="true" />
              取消
            </button>
          </div>
        )}
      </header>

      {datasets.length === 0 ? (
        <div className="source-dataset-manager__empty">
          <FilePlus2 size={21} aria-hidden="true" />
          <strong>工程中还没有已导入的来源</strong>
          <span>追加导入会返回来源入口；不会自动查询整个数据库。</span>
        </div>
      ) : (
        <div className="source-dataset-manager__list">
          {datasets.map((dataset) => {
            const features = datasetFeatures(dataset);
            const keys = dataset.feature_keys ?? [];
            const excluded = new Set(dataset.excluded_keys ?? []);
            const includedCount = keys.filter(
              (key) => !excluded.has(key),
            ).length;
            const generatedCount = generatedCounts?.[dataset.id] ?? 0;
            const fields = (dataset.fields ?? [])
              .map(readField)
              .filter((field): field is DatasetField => Boolean(field));
            const columns: DatasetField[] = fields.length
              ? fields
              : Array.from(
                  new Set(
                    features.flatMap((feature) =>
                      Object.keys(feature.properties ?? {}),
                    ),
                  ),
                ).map((name) => ({ name }));
            const visibleColumns =
              shownColumns[dataset.id] ??
              new Set(columns.map(({ name }) => name));
            const activeColumns = columns.filter((field) =>
              visibleColumns.has(field.name),
            );
            const query = (filters[dataset.id] ?? "")
              .trim()
              .toLocaleLowerCase();
            const filteredRows = features.flatMap((feature, index) => {
              const key = keys[index];
              if (!key) return [];
              if (!query) return [{ feature, key, index }];
              const searchable = activeColumns
                .map((field) => valueText(feature.properties?.[field.name]))
                .join(" ")
                .toLocaleLowerCase();
              return searchable.includes(query)
                ? [{ feature, key, index }]
                : [];
            });
            const pageCount = Math.max(
              1,
              Math.ceil(filteredRows.length / PAGE_SIZE),
            );
            const page = Math.min(pages[dataset.id] ?? 0, pageCount - 1);
            const pageRows = filteredRows.slice(
              page * PAGE_SIZE,
              (page + 1) * PAGE_SIZE,
            );
            const selectedKeys = selected[dataset.id] ?? new Set<string>();
            const pageSelected =
              pageRows.length > 0 &&
              pageRows.every(({ key }) => selectedKeys.has(key));

            return (
              <article className="source-dataset" key={dataset.id}>
                <div className="source-dataset__summary">
                  <button
                    type="button"
                    className="source-dataset__expand"
                    aria-expanded={Boolean(expanded[dataset.id])}
                    aria-controls={`dataset-content-${dataset.id}`}
                    aria-label={`${expanded[dataset.id] ? "收起" : "展开"}${dataset.label}属性表`}
                    onClick={() =>
                      setExpanded((current) => ({
                        ...current,
                        [dataset.id]: !current[dataset.id],
                      }))
                    }
                  >
                    <ChevronDown
                      size={16}
                      aria-hidden="true"
                      className={expanded[dataset.id] ? "is-expanded" : ""}
                    />
                  </button>
                  <div className="source-dataset__title">
                    <strong title={dataset.label}>{dataset.label}</strong>
                    <span>{dataset.source_label}</span>
                  </div>
                  <div className="source-dataset__counts">
                    <span>{features.length} 行</span>
                    <span>{includedCount} 条参与</span>
                    <span>
                      {generatedCounts
                        ? generatedCount > 0
                          ? `${generatedCount} 个有效线部件`
                          : "尚无有效成果"
                        : "尚未生成"}
                    </span>
                  </div>
                  <details className="source-dataset__more">
                    <summary aria-label={`${dataset.label}更多操作`}>
                      <Settings2 size={16} aria-hidden="true" />
                      <span>更多</span>
                    </summary>
                    <div className="source-dataset__more-menu">
                      <button
                        type="button"
                        onClick={(event) => {
                          const menu = event.currentTarget.closest("details");
                          if (menu) menu.open = false;
                          onConfigureMapping(dataset.id);
                        }}
                      >
                        <Settings2 size={14} aria-hidden="true" /> 字段映射
                      </button>
                      <button
                        type="button"
                        onClick={() => onLocateDataset(dataset.id)}
                      >
                        <MapPinned size={14} aria-hidden="true" /> 定位来源
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => onRemoveDataset(dataset.id)}
                      >
                        <Trash2 size={14} aria-hidden="true" /> 从工程移除来源
                      </button>
                      <p>仅移除工程中的来源数据，不删除数据库中的数据。</p>
                    </div>
                  </details>
                </div>

                {expanded[dataset.id] && (
                  <div
                    className="source-dataset__content"
                    id={`dataset-content-${dataset.id}`}
                  >
                    <div className="source-dataset__tools">
                      <label className="source-dataset__filter">
                        <span>筛选已导入数据</span>
                        <input
                          type="search"
                          value={filters[dataset.id] ?? ""}
                          placeholder="搜索当前工程已导入的属性值"
                          aria-label={`筛选${dataset.label}当前已导入数据`}
                          onChange={(event) => {
                            setFilters((current) => ({
                              ...current,
                              [dataset.id]: event.currentTarget.value,
                            }));
                            setPages((current) => ({
                              ...current,
                              [dataset.id]: 0,
                            }));
                          }}
                        />
                      </label>
                      <details className="source-dataset__columns">
                        <summary>
                          <Columns3 size={14} aria-hidden="true" />
                          显示列
                        </summary>
                        <div className="source-dataset__column-menu">
                          {columns.map((field) => (
                            <label
                              key={field.name}
                              title={
                                field.comment ?? field.description ?? undefined
                              }
                            >
                              <input
                                type="checkbox"
                                checked={visibleColumns.has(field.name)}
                                onChange={(event) => {
                                  setShownColumns((current) => {
                                    const next = new Set(
                                      current[dataset.id] ??
                                        columns.map(({ name }) => name),
                                    );
                                    if (event.currentTarget.checked)
                                      next.add(field.name);
                                    else next.delete(field.name);
                                    return { ...current, [dataset.id]: next };
                                  });
                                }}
                              />
                              <span>{field.name}</span>
                              {(field.comment || field.description) && (
                                <span className="source-dataset__field-note">
                                  {field.comment ?? field.description}
                                </span>
                              )}
                            </label>
                          ))}
                          {columns.length === 0 && (
                            <span>没有可显示的业务字段</span>
                          )}
                        </div>
                      </details>
                    </div>

                    {selectedKeys.size > 0 && (
                      <div
                        className="source-dataset__selection-actions"
                        aria-live="polite"
                      >
                        <span>已选 {selectedKeys.size} 条（用于批量管理）</span>
                        <button
                          type="button"
                          onClick={() =>
                            onSetIncluded(dataset.id, [...selectedKeys], true)
                          }
                        >
                          <Check size={14} aria-hidden="true" /> 设为参与
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onSetIncluded(dataset.id, [...selectedKeys], false)
                          }
                        >
                          排除生成
                        </button>
                        <button
                          type="button"
                          className="is-danger"
                          onClick={() => {
                            onRemoveFeatures(dataset.id, [...selectedKeys]);
                            updateSelected(dataset.id, new Set());
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />{" "}
                          从工程移除选中项
                        </button>
                        <button
                          type="button"
                          aria-label="清除行选择"
                          onClick={() => updateSelected(dataset.id, new Set())}
                        >
                          <X size={14} aria-hidden="true" /> 清除选择
                        </button>
                      </div>
                    )}

                    <p className="source-dataset__scope-note">
                      筛选范围是当前已导入到工程的数据，不会查询来源数据库的全表。
                    </p>
                    <div
                      className="source-dataset__table-scroll"
                      role="region"
                      aria-label={`${dataset.label}属性表，可横向滚动`}
                      tabIndex={0}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th className="source-dataset__select-col">
                              <input
                                type="checkbox"
                                aria-label="选择当前页全部行"
                                checked={pageSelected}
                                onChange={(event) => {
                                  const next = new Set(selectedKeys);
                                  for (const { key } of pageRows) {
                                    if (event.currentTarget.checked)
                                      next.add(key);
                                    else next.delete(key);
                                  }
                                  updateSelected(dataset.id, next);
                                }}
                              />
                            </th>
                            <th>参与生成</th>
                            <th>几何部件</th>
                            {activeColumns.map((field) => (
                              <th
                                key={field.name}
                                title={
                                  field.comment ??
                                  field.description ??
                                  undefined
                                }
                              >
                                <span>{field.name}</span>
                                {(field.comment || field.description) && (
                                  <small>
                                    {field.comment ?? field.description}
                                  </small>
                                )}
                              </th>
                            ))}
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map(({ feature, key, index }) => {
                            const included = !excluded.has(key);
                            const properties = feature.properties ?? {};
                            return (
                              <tr key={key}>
                                <td className="source-dataset__select-col">
                                  <input
                                    type="checkbox"
                                    aria-label={`选择第 ${index + 1} 行进行批量管理`}
                                    checked={selectedKeys.has(key)}
                                    onChange={(event) => {
                                      const next = new Set(selectedKeys);
                                      if (event.currentTarget.checked)
                                        next.add(key);
                                      else next.delete(key);
                                      updateSelected(dataset.id, next);
                                    }}
                                  />
                                </td>
                                <td>
                                  <label className="source-dataset__included">
                                    <input
                                      type="checkbox"
                                      aria-label={`第 ${index + 1} 行参与生成`}
                                      checked={included}
                                      onChange={() =>
                                        onSetIncluded(
                                          dataset.id,
                                          [key],
                                          !included,
                                        )
                                      }
                                    />
                                    <span>{included ? "参与" : "排除"}</span>
                                  </label>
                                </td>
                                <td>{geometryParts(feature)} 个部件</td>
                                {activeColumns.map((field) => (
                                  <td
                                    key={field.name}
                                    title={valueText(properties[field.name])}
                                  >
                                    {valueText(properties[field.name])}
                                  </td>
                                ))}
                                <td>
                                  <div className="source-dataset__row-actions">
                                    <button
                                      type="button"
                                      aria-label={`编辑第 ${index + 1} 行`}
                                      title="编辑这条路线"
                                      onClick={() =>
                                        onEditFeature(dataset.id, key)
                                      }
                                    >
                                      <Pencil size={14} aria-hidden="true" />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={`定位第 ${index + 1} 行`}
                                      title="定位这条路线"
                                      onClick={() =>
                                        onLocateDataset(dataset.id)
                                      }
                                    >
                                      <LocateFixed
                                        size={14}
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          {pageRows.length === 0 && (
                            <tr>
                              <td
                                colSpan={activeColumns.length + 4}
                                className="source-dataset__no-rows"
                              >
                                {features.length === 0
                                  ? "该来源没有已导入的数据行。"
                                  : "没有匹配的已导入数据。"}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <footer className="source-dataset__pagination">
                      <span>
                        {filteredRows.length === 0
                          ? "0 条"
                          : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, filteredRows.length)} / ${filteredRows.length} 条`}
                      </span>
                      <div>
                        <button
                          type="button"
                          aria-label="上一页"
                          disabled={page <= 0}
                          onClick={() =>
                            setPages((current) => ({
                              ...current,
                              [dataset.id]: page - 1,
                            }))
                          }
                        >
                          <ChevronLeft size={15} aria-hidden="true" />
                        </button>
                        <span>
                          第 {page + 1}/{pageCount} 页 · 每页 50 条
                        </span>
                        <button
                          type="button"
                          aria-label="下一页"
                          disabled={page >= pageCount - 1}
                          onClick={() =>
                            setPages((current) => ({
                              ...current,
                              [dataset.id]: page + 1,
                            }))
                          }
                        >
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </footer>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
