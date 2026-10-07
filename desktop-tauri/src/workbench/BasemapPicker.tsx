import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileUp, Search, X } from "./Iconfont";
import {
  BASEMAP_GROUPS,
  BASEMAP_PRESETS,
  AUTHENTICATED_BASEMAP_PRESETS,
  createPresetConfig,
  createWmsBasemap,
  createXyzBasemap,
  type BasemapConfig,
} from "./basemaps";
import "./BasemapPicker.css";
import { isImeComposing } from "./imeKeyboard";

export type { BasemapConfig } from "./basemaps";

type BasemapPickerProps = {
  onSelect: (config: BasemapConfig) => void;
  onImportLocal: () => void;
  onClose: () => void;
  activeId?: string;
  position?: { top: number; right: number; maxHeight: number };
};

export function BasemapPicker({
  onSelect,
  onImportLocal,
  onClose,
  activeId,
  position,
}: BasemapPickerProps) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"catalog" | "custom">("catalog");
  const [customType, setCustomType] = useState<"xyz" | "wms">("xyz");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [layers, setLayers] = useState("");
  const [attribution, setAttribution] = useState("");
  const [maxZoom, setMaxZoom] = useState("19");
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState("");
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLInputElement>("input")?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Element;
      if (
        !root.current?.contains(target) &&
        !target.closest('[aria-label="选择地图底图"],[aria-label="底图设置"]')
      ) {
        close.current();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
      if (
        root.current?.contains(document.activeElement) ||
        document.activeElement === document.body
      ) {
        previous?.focus({ preventScroll: true });
      }
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return BASEMAP_PRESETS.filter(
      (item) =>
        !needle ||
        `${item.label} ${item.group} ${item.note} ${item.coverage ?? ""} ${item.updateInfo ?? ""} ${item.detail ?? ""}`
          .toLocaleLowerCase()
          .includes(needle),
    );
  }, [search]);

  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [search]);

  const selectPreset = (id: string) => {
    try {
      onSelect(createPresetConfig(id, token));
      setFormError("");
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "底图配置无效。");
    }
  };

  const addCustom = () => {
    try {
      const zoom = Number(maxZoom);
      const config =
        customType === "xyz"
          ? createXyzBasemap({ label, url, attribution, maxZoom: zoom })
          : createWmsBasemap({
              label,
              endpoint: url,
              layers,
              attribution,
              maxZoom: zoom,
            });
      onSelect(config);
      setFormError("");
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "底图配置无效。");
    }
  };

  return (
    <section
      ref={root}
      id="workbench-basemap-picker"
      className="basemap-picker"
      aria-label="选择底图"
      style={
        position ? { ...position, left: "auto", bottom: "auto" } : undefined
      }
    >
      <header className="basemap-picker__header">
        <strong>底图</strong>
        <div
          className="basemap-picker__tabs"
          role="tablist"
          aria-label="底图来源类型"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "catalog"}
            onClick={() => {
              setFormError("");
              setMode("catalog");
            }}
          >
            在线底图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "custom"}
            onClick={() => {
              setFormError("");
              setMode("custom");
            }}
          >
            XYZ / WMS
          </button>
        </div>{" "}
        <button
          className="basemap-picker__icon"
          type="button"
          onClick={onClose}
          aria-label="关闭底图选择器"
        >
          <X size={15} />
        </button>
      </header>

      {mode === "catalog" ? (
        <>
          <label className="basemap-picker__search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索底图"
              aria-label="搜索底图"
            />
          </label>
          <div className="basemap-picker__local-actions">
            <button
              className={`basemap-picker__local${activeId === "none" ? " is-active" : ""}`}
              type="button"
              onClick={() => {
                onSelect({
                  id: "none",
                  label: "无在线底图",
                  url: "",
                  attribution: "",
                  maxZoom: 22,
                  displayCrs: "WGS84",
                });
                onClose();
              }}
            >
              <span>
                <strong>离线画布</strong>
              </span>
              {activeId === "none" && <Check size={15} />}
            </button>
            <button
              className="basemap-picker__local"
              type="button"
              onClick={onImportLocal}
            >
              <FileUp size={15} />
              <span>
                <strong>本地影像</strong>
              </span>
            </button>
          </div>
          <div className="basemap-picker__list" ref={list}>
            <p className="basemap-picker__catalog-hint">
              OSM 显示路网；查看地表请选卫星与航空影像。
            </p>
            {BASEMAP_GROUPS.map((group) => {
              const options = filtered.filter((item) => item.group === group);
              if (!options.length) return null;
              return (
                <div className="basemap-picker__group" key={group}>
                  <h3>{group}</h3>
                  {options.map((item) => (
                    <button
                      className={`basemap-picker__option${activeId === item.id ? " is-active" : ""}`}
                      key={item.id}
                      data-basemap-id={item.id}
                      type="button"
                      onClick={() => selectPreset(item.id)}
                      title={[
                        item.note,
                        item.coverage,
                        item.updateInfo ?? "影像／数据日期未知，以供方为准",
                        item.detail,
                      ]
                        .filter(Boolean)
                        .join("\n")}
                    >
                      <span className="basemap-picker__option-copy">
                        <strong>{item.label}</strong>
                        <small>{item.coverage ?? "全球开放数据覆盖区"}</small>
                        <small className="basemap-picker__detail">
                          {item.detail ?? item.note}
                        </small>
                      </span>
                      {activeId === item.id && (
                        <Check size={15} aria-label="当前底图" />
                      )}
                    </button>
                  ))}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="basemap-picker__empty">没有匹配的底图。</p>
            )}
          </div>
        </>
      ) : (
        <div className="basemap-picker__form">
          <div
            className="basemap-picker__segmented"
            role="group"
            aria-label="自定义服务类型"
          >
            <button
              type="button"
              className={customType === "xyz" ? "is-active" : ""}
              onClick={() => setCustomType("xyz")}
            >
              XYZ 瓦片
            </button>
            <button
              type="button"
              className={customType === "wms" ? "is-active" : ""}
              onClick={() => setCustomType("wms")}
            >
              WMS GetMap
            </button>
          </div>
          <label className="basemap-picker__field">
            <span>显示名称</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="例如：单位影像服务"
            />
          </label>
          <label className="basemap-picker__field">
            <span>{customType === "xyz" ? "瓦片 URL" : "WMS GetMap 端点"}</span>
            <textarea
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                customType === "xyz"
                  ? "https://tiles.example.com/{z}/{x}/{y}.png"
                  : "https://maps.example.com/wms"
              }
              rows={2}
              spellCheck={false}
            />
          </label>
          {customType === "wms" && (
            <label className="basemap-picker__field">
              <span>图层名（LAYERS）</span>
              <input
                value={layers}
                onChange={(event) => setLayers(event.target.value)}
                placeholder="例如：imagery"
              />
            </label>
          )}
          <div className="basemap-picker__form-row">
            <label className="basemap-picker__field">
              <span>最大缩放</span>
              <input
                type="number"
                min="0"
                max="22"
                value={maxZoom}
                onChange={(event) => setMaxZoom(event.target.value)}
              />
            </label>
            <label className="basemap-picker__field">
              <span>署名</span>
              <input
                value={attribution}
                onChange={(event) => setAttribution(event.target.value)}
                placeholder="© 数据提供方"
              />
            </label>
          </div>
          <p className="basemap-picker__hint">
            {customType === "xyz"
              ? "模板须包含 {z}、{x}、{y}；仅接受 HTTPS 或本机回环 HTTP。"
              : "自动补齐 PNG GetMap 参数及 {bbox-epsg-3857}，服务坐标固定为 EPSG:3857。"}
          </p>
          <button
            className="basemap-picker__submit"
            type="button"
            onClick={addCustom}
          >
            应用底图
          </button>
          {AUTHENTICATED_BASEMAP_PRESETS.some(
            (item) => item.id === "esri-token",
          ) && (
            <details
              className="basemap-picker__disclosure basemap-picker__authorized"
              data-testid="basemap-authorized-services"
            >
              <summary>授权影像（ArcGIS）</summary>
              <p>
                使用你在 ArcGIS 获得的影像访问令牌。令牌仅保留在本次会话中。
              </p>
              <label className="basemap-picker__field">
                <span>ArcGIS 访问令牌</span>
                <input
                  aria-label="ArcGIS 访问令牌"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="粘贴 ArcGIS 访问令牌"
                />
              </label>
              <button
                type="button"
                className="basemap-picker__submit"
                aria-label="应用 ArcGIS 影像"
                onClick={() => selectPreset("esri-token")}
              >
                应用 ArcGIS 影像
              </button>
            </details>
          )}
        </div>
      )}
      {formError && (
        <p className="basemap-picker__error" role="alert">
          {formError}
        </p>
      )}
    </section>
  );
}
