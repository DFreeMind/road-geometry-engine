import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./DataSourceTools.css";

type SourceKind = "wfs" | "postgis";
type Field = string | { name: string; type?: string };
const emptyMapping: Record<string, string | null | boolean | undefined> = {};

const mappingFields = [
  ["route_id", "路线 ID", ["route_id", "routeid", "路线id", "路线编号", "道路编号"]],
  ["left_lane_count", "左侧车道数", ["left_lane_count", "leftlanes", "lanes_left", "左车道数", "左侧车道数", "左幅车道数"]],
  ["right_lane_count", "右侧车道数", ["right_lane_count", "rightlanes", "lanes_right", "右车道数", "右侧车道数", "右幅车道数"]],
  ["left_lane_width", "左侧车道宽度 (m)", ["left_lane_width", "leftwidth", "lane_width_left", "左车道宽度", "左侧车道宽度", "左幅车道宽度"]],
  ["right_lane_width", "右侧车道宽度 (m)", ["right_lane_width", "rightwidth", "lane_width_right", "右车道宽度", "右侧车道宽度", "右幅车道宽度"]],
  ["median_width", "中央隔离带宽度 (m)", ["median_width", "median", "中央分隔带宽度", "中央隔离带宽度", "中间带宽度"]],
  ["left_emergency_width", "左侧应急车道宽度 (m)", ["left_emergency_width", "左应急车道宽度", "左侧应急车道宽度"]],
  ["right_emergency_width", "右侧应急车道宽度 (m)", ["right_emergency_width", "右应急车道宽度", "右侧应急车道宽度"]],
  ["left_shoulder_width", "左侧路肩宽度 (m)", ["left_shoulder_width", "左路肩宽度", "左侧路肩宽度"]],
  ["right_shoulder_width", "右侧路肩宽度 (m)", ["right_shoulder_width", "右路肩宽度", "右侧路肩宽度"]],
  ["left_slope_width", "左侧边坡水平投影 (m)", ["left_slope_width", "左边坡水平投影宽度", "左侧边坡投影宽度"]],
  ["right_slope_width", "右侧边坡水平投影 (m)", ["right_slope_width", "右边坡水平投影宽度", "右侧边坡投影宽度"]],
] as const;

function normalized(value: string) {
  return value.replace(/[\s_\-（）()]+/g, "").toLocaleLowerCase();
}

export function DataSourceTools({
  onImport,
}: {
  onImport: (result: any, label: string) => void;
}) {
  const [kind, setKind] = useState<SourceKind>("wfs");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [wfs, setWfs] = useState({ url: "", type_name: "", version: "auto", page_size: 500 });
  const [pg, setPg] = useState({
    host: "localhost", port: 5432, database: "", schema: "public", table: "",
    geometry_column: "geom", user: "", password: "", sslmode: "prefer",
  });

  async function connect() {
    setBusy(true);
    setStatus("");
    const request = kind === "wfs"
      ? { kind, ...wfs }
      : { kind: "postgis", ...pg };
    const label = kind === "wfs" ? wfs.type_name.trim() : `${pg.schema.trim()}.${pg.table.trim()}`;
    try {
      const imported: any = await invoke("import_remote_vector", { connection: request });
      onImport(imported, label || imported.layer_name || "远程路线图层");
      setStatus(`已读取 ${imported.feature_count ?? imported.collection?.features?.length ?? 0} 个要素${imported.truncated ? "（结果已截取）" : ""}。`);
      if (kind === "postgis") setPg((current) => ({ ...current, password: "" }));
    } catch (error) {
      setStatus(typeof error === "string" ? error : "远程连接失败；请检查服务、认证和图层配置。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="source-tools" aria-label="连接路线数据源">
      <header className="source-tools__header">
        <div><h3>连接路线数据源</h3><p>读取 WFS 或 PostGIS 线图层，最多导入 2,000 个要素。</p></div>
        <div className="source-tools__tabs" role="tablist" aria-label="数据源类型">
          <button type="button" role="tab" aria-selected={kind === "wfs"} onClick={() => setKind("wfs")}>WFS</button>
          <button type="button" role="tab" aria-selected={kind === "postgis"} onClick={() => setKind("postgis")}>PostGIS</button>
        </div>
      </header>
      {kind === "wfs" ? (
        <div className="source-tools__grid">
          <label className="source-tools__wide">WFS 服务地址<input value={wfs.url} placeholder="https://server.example/geoserver/wfs" onChange={(event) => setWfs({ ...wfs, url: event.target.value })} /></label>
          <label>要素类型<input value={wfs.type_name} placeholder="workspace:roads" onChange={(event) => setWfs({ ...wfs, type_name: event.target.value })} /></label>
          <label>版本<select value={wfs.version} onChange={(event) => setWfs({ ...wfs, version: event.target.value })}><option value="auto">自动</option><option value="2.0.0">2.0.0</option><option value="1.1.0">1.1.0</option><option value="1.0.0">1.0.0</option></select></label>
          <label>分页大小上限<select value={wfs.page_size} onChange={(event) => setWfs({ ...wfs, page_size: Number(event.target.value) })}><option value={100}>100</option><option value={250}>250</option><option value={500}>500</option></select></label>
        </div>
      ) : (
        <div className="source-tools__grid">
          <label>主机<input value={pg.host} onChange={(event) => setPg({ ...pg, host: event.target.value })} /></label>
          <label>端口<input type="number" min={1} max={65535} value={pg.port} onChange={(event) => setPg({ ...pg, port: Number(event.target.value) })} /></label>
          <label>数据库<input value={pg.database} onChange={(event) => setPg({ ...pg, database: event.target.value })} /></label>
          <label>Schema<input value={pg.schema} onChange={(event) => setPg({ ...pg, schema: event.target.value })} /></label>
          <label>表<input value={pg.table} onChange={(event) => setPg({ ...pg, table: event.target.value })} /></label>
          <label>几何列<input value={pg.geometry_column} onChange={(event) => setPg({ ...pg, geometry_column: event.target.value })} /></label>
          <label>用户<input autoComplete="username" value={pg.user} onChange={(event) => setPg({ ...pg, user: event.target.value })} /></label>
          <label>密码<input type="password" autoComplete="current-password" value={pg.password} onChange={(event) => setPg({ ...pg, password: event.target.value })} /></label>
          <label>SSL<select value={pg.sslmode} onChange={(event) => setPg({ ...pg, sslmode: event.target.value })}><option value="prefer">优先 (prefer)</option><option value="require">必须 (require)</option></select></label>
          <p className="source-tools__note source-tools__wide">密码仅用于本次连接，不会加入来源描述或项目文件。</p>
        </div>
      )}
      <footer className="source-tools__footer">
        <span role="status">{status}</span>
        <button type="button" className="source-tools__primary" disabled={busy} onClick={connect}>{busy ? "连接中…" : "连接并读取"}</button>
      </footer>
    </section>
  );
}

export function FieldMappingTools({
  fields,
  attributes = {},
  value = emptyMapping,
  onChange,
}: {
  fields: Field[];
  attributes?: Record<string, unknown>;
  value?: Record<string, string | null | boolean | undefined>;
  onChange: (mapping: Record<string, string | null | boolean>) => void;
}) {
  const names = useMemo(() => fields.map((field) => typeof field === "string" ? field : field.name).filter(Boolean), [fields]);
  const suggested = useMemo(() => Object.fromEntries(mappingFields.map(([key, _label, aliases]) => {
    if (typeof value[key] === "string" || value[key] === null) return [key, value[key] ?? ""];
    const accepted = new Set(aliases.map(normalized));
    return [key, names.find((name) => accepted.has(normalized(name))) ?? ""];
  })), [names, value]);
  const [mapping, setMapping] = useState<Record<string, string>>(suggested);
  const [fallback, setFallback] = useState(value.mapping_null_fallback === true);
  useEffect(() => {
    setMapping(suggested);
    setFallback(value.mapping_null_fallback === true);
  }, [suggested, value.mapping_null_fallback]);
  const sample = names.map((name) => `${name}: ${String(attributes[name] ?? "空")}`).join("；");

  function update(key: string, field: string) {
    const next = { ...mapping, [key]: field };
    setMapping(next);
    onChange({ ...Object.fromEntries(mappingFields.map(([fieldKey]) => [fieldKey, next[fieldKey] || null])), mapping_null_fallback: fallback });
  }

  function updateFallback(checked: boolean) {
    setFallback(checked);
    onChange({ ...Object.fromEntries(mappingFields.map(([key]) => [key, mapping[key] || null])), mapping_null_fallback: checked });
  }

  return (
    <section className="field-mapping" aria-label="字段映射">
      <header><h3>字段映射与横断面属性</h3><p>宽度按米解释；路线左右侧按输入路线点序定义。总宽度不会自动当作车道宽度。</p></header>
      <div className="field-mapping__grid">
        {mappingFields.map(([key, label]) => (
          <label key={key}>{label}<select value={mapping[key] ?? ""} onChange={(event) => update(key, event.target.value)}>
            <option value="">使用手动值</option>
            {names.map((name) => <option key={name} value={name}>{name}</option>)}
          </select></label>
        ))}
      </div>
      <label className="field-mapping__fallback"><input type="checkbox" checked={fallback} onChange={(event) => updateFallback(event.target.checked)} />映射字段为空时使用手动默认值</label>
      <div className="field-mapping__preview"><strong>当前要素预览</strong><span>{sample || "当前数据没有属性字段。"}</span></div>
    </section>
  );
}
