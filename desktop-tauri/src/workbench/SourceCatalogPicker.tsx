import { useEffect, useMemo, useState } from "react";
import {
  availableCatalogLayers,
  catalogLayerKey,
  isRouteCatalogLayer,
  type CatalogLayer,
  type SourceCatalog,
} from "./connectionFlow";
import { schemaDatabase, type SourceKind } from "./connections";
import "./SourceCatalogPicker.css";

type SourceCatalogPickerProps = {
  catalog: SourceCatalog | undefined;
  kind: SourceKind;
  defaultSchema?: string;
  onAdd: (layer: CatalogLayer) => void;
};

export function SourceCatalogPicker({
  catalog,
  kind,
  defaultSchema,
  onAdd,
}: SourceCatalogPickerProps) {
  const hasSchemaPicker = schemaDatabase(kind);
  const [schema, setSchema] = useState("");
  const [selectedKey, setSelectedKey] = useState("");

  useEffect(() => {
    const preferredSchema =
      hasSchemaPicker &&
      defaultSchema &&
      catalog?.schemas.includes(defaultSchema)
        ? defaultSchema
        : "";
    setSchema(preferredSchema);
    setSelectedKey("");
  }, [catalog, defaultSchema, hasSchemaPicker]);

  const layers = useMemo(() => {
    if (!catalog) return [];
    return availableCatalogLayers(catalog).filter(
      (layer) =>
        isRouteCatalogLayer(layer) &&
        (!hasSchemaPicker || (schema !== "" && layer.schema === schema)),
    );
  }, [catalog, hasSchemaPicker, schema]);

  const selectedLayer = layers.find(
    (layer) => catalogLayerKey(layer) === selectedKey,
  );

  if (!catalog) return null;

  const emptyCatalog = catalog.layers.length === 0;
  const hasSchema = !hasSchemaPicker || schema !== "";
  const showNoLayers = !emptyCatalog && hasSchema && layers.length === 0;

  return (
    <section className="source-catalog-picker" aria-label="选择路线空间表">
      <div className="source-catalog-picker__heading">
        <strong>从目录添加路线图层</strong>
        <span>{layers.length} 个可选图层</span>
      </div>

      {hasSchemaPicker && (
        <label>
          Schema
          <select
            aria-label="选择 Schema"
            value={schema}
            onChange={(event) => {
              setSchema(event.target.value);
              setSelectedKey("");
            }}
          >
            <option value="">请选择 Schema</option>
            {catalog.schemas.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        {kind === "wfs" ? "要素类型" : "空间表"}
        <select
          aria-label={kind === "wfs" ? "选择要素类型" : "选择空间表"}
          value={selectedKey}
          disabled={!hasSchema || layers.length === 0}
          onChange={(event) => setSelectedKey(event.target.value)}
        >
          <option value="">
            {hasSchema
              ? kind === "wfs"
                ? "请选择要素类型"
                : "请选择空间表"
              : "请先选择 Schema"}
          </option>
          {layers.map((layer) => (
            <option key={catalogLayerKey(layer)} value={catalogLayerKey(layer)}>
              {kind === "wfs" ? layer.type_name : layer.table}
              {layer.schema ? ` · ${layer.schema}` : ""}
              {layer.geometry_column ? ` · ${layer.geometry_column}` : ""}
              {layer.geometry_type
                ? ` · ${layer.geometry_type}`
                : " · 类型待校验"}
            </option>
          ))}
        </select>
      </label>

      {emptyCatalog ? (
        <p className="source-catalog-picker__message" role="status">
          目录中没有发现空间表或要素类型。请检查连接权限、服务范围或数据源内容。
        </p>
      ) : hasSchemaPicker && catalog.schemas.length === 0 ? (
        <p className="source-catalog-picker__message" role="status">
          目录未返回可选 Schema。
        </p>
      ) : showNoLayers ? (
        <p className="source-catalog-picker__message" role="status">
          当前范围没有可作为路线的线图层或类型未确定的空间图层。
        </p>
      ) : null}

      <p className="source-catalog-picker__note">
        选择线图层作为路线；类型未确定的图层将在读取时校验。添加后再读取路线数据。
      </p>

      <button
        type="button"
        className="source-catalog-picker__add"
        disabled={!selectedLayer}
        onClick={() => {
          if (selectedLayer) onAdd(selectedLayer);
        }}
      >
        添加所选路线图层
      </button>
    </section>
  );
}
