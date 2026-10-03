import { useEffect, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { chooseFile as openFile } from "../tauri";
import "./DataSourceTools.css";
import { SourceCatalogPicker } from "./SourceCatalogPicker";
import {
  ConnectionSessions,
  connectionIdentity,
  needsPassword,
  catalogLayerKey,
  catalogSourceLayer,
  type CatalogLayer,
  type SourceCatalog,
} from "./connectionFlow";

// 会话缓存配合系统凭据管理器，避免切换面板时重复读取密码。
const connectionSessions = new ConnectionSessions();

import {
  Database,
  Plus,
  Settings2,
  Trash2,
  Copy,
  X,
  Layers3,
} from "lucide-react";
import {
  sourceLabels,
  fileDatabase,
  schemaDatabase,
  readConnections,
  writeConnections,
  publicConnection,
  bindingFor,
  type SourceKind,
  type SourceConnection,
  type SourceLayer,
  type SourceBinding,
} from "./connections";
import { isPageable, readSourcePage, sourceCapabilities } from "./sourceAccess";
export type Field =
  | string
  | {
      name: string;
      type?: string;
      description?: string | null;
      comment?: string | null;
    };
const emptyMapping: Record<string, string | null | boolean | undefined> = {};

const mappingFields = [
  [
    "route_id",
    "路线 ID",
    ["route_id", "routeid", "路线id", "路线编号", "道路编号"],
  ],
  [
    "left_lane_count",
    "左侧车道数",
    [
      "left_lane_count",
      "leftlanes",
      "lanes_left",
      "左车道数",
      "左侧车道数",
      "左幅车道数",
    ],
  ],
  [
    "right_lane_count",
    "右侧车道数",
    [
      "right_lane_count",
      "rightlanes",
      "lanes_right",
      "右车道数",
      "右侧车道数",
      "右幅车道数",
    ],
  ],
  [
    "left_lane_width",
    "左侧车道宽度 (m)",
    [
      "left_lane_width",
      "leftwidth",
      "lane_width_left",
      "左车道宽度",
      "左侧车道宽度",
      "左幅车道宽度",
    ],
  ],
  [
    "right_lane_width",
    "右侧车道宽度 (m)",
    [
      "right_lane_width",
      "rightwidth",
      "lane_width_right",
      "右车道宽度",
      "右侧车道宽度",
      "右幅车道宽度",
    ],
  ],
  [
    "median_width",
    "中央隔离带宽度 (m)",
    [
      "median_width",
      "median",
      "中央分隔带宽度",
      "中央隔离带宽度",
      "中间带宽度",
    ],
  ],
  [
    "left_emergency_width",
    "左侧应急车道宽度 (m)",
    ["left_emergency_width", "左应急车道宽度", "左侧应急车道宽度"],
  ],
  [
    "right_emergency_width",
    "右侧应急车道宽度 (m)",
    ["right_emergency_width", "右应急车道宽度", "右侧应急车道宽度"],
  ],
  [
    "left_shoulder_width",
    "左侧路肩宽度 (m)",
    ["left_shoulder_width", "左路肩宽度", "左侧路肩宽度"],
  ],
  [
    "right_shoulder_width",
    "右侧路肩宽度 (m)",
    ["right_shoulder_width", "右路肩宽度", "右侧路肩宽度"],
  ],
  [
    "left_slope_width",
    "左侧边坡水平投影 (m)",
    ["left_slope_width", "左边坡水平投影宽度", "左侧边坡投影宽度"],
  ],
  [
    "right_slope_width",
    "右侧边坡水平投影 (m)",
    ["right_slope_width", "右边坡水平投影宽度", "右侧边坡投影宽度"],
  ],
] as const;

function normalized(value: string) {
  return value.replace(/[\s_\-（）()]+/g, "").toLocaleLowerCase();
}

function ConnectionEditor({
  initial,
  layer,
  layerMode = false,
  sessionPassword = "",
  sessionProvided = false,
  onAuthenticated,
  onSave,
}: {
  initial?: SourceConnection;
  layer?: SourceLayer;
  layerMode?: boolean;
  sessionPassword?: string;
  sessionProvided?: boolean;
  onAuthenticated?: (config: Record<string, string | number>) => void;
  onSave: (
    name: string,
    kind: SourceKind,
    config: Record<string, string | number>,
    credentialProvided: boolean,
    rememberPassword: boolean,
  ) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<SourceKind>(initial?.kind ?? "postgis");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [credentialProvided, setCredentialProvided] = useState(sessionProvided);
  const [rememberPassword, setRememberPassword] = useState(
    initial?.rememberPassword !== false,
  );
  const [capabilities, setCapabilities] = useState<
    Partial<Record<SourceKind, { available: boolean; reason: string }>>
  >({});
  const [capabilityError, setCapabilityError] = useState("");
  const [drafts, setDrafts] = useState(() => {
    const defaults: Record<SourceKind, Record<string, string | number>> = {
      postgis: {
        host: "localhost",
        port: 5432,
        database: "",
        user: "",
        password: sessionPassword,
        sslmode: "prefer",
        scope: "database",
        schema: "public",
        table: "",
        geometry_column: "geom",
      },
      mysql: {
        host: "localhost",
        port: 3306,
        database: "",
        user: "",
        password: sessionPassword,
        table: "",
        geometry_column: "geom",
      },
      mssql: {
        host: "localhost",
        port: 1433,
        database: "",
        user: "",
        password: sessionPassword,
        auth: "sql",
        odbc_driver: "ODBC Driver 18 for SQL Server",
        encrypt: "yes",
        trust_certificate: "no",
        scope: "database",
        schema: "dbo",
        table: "",
        geometry_column: "geom",
      },
      oracle: {
        host: "localhost",
        port: 1521,
        service: "",
        user: "",
        password: sessionPassword,
        scope: "database",
        schema: "",
        table: "",
        geometry_column: "GEOM",
      },
      sqlite: { path: "", table: "", geometry_column: "geometry" },
      gpkg: { path: "", table: "", geometry_column: "geom" },
      wfs: { url: "", version: "auto", page_size: 500, type_name: "" },
    };
    if (initial)
      defaults[initial.kind] = {
        ...defaults[initial.kind],
        ...initial.config,
        schema:
          layer?.schema ??
          initial.config.default_schema ??
          defaults[initial.kind].schema ??
          "",
        table: layer?.table ?? "",
        geometry_column:
          layer?.geometry_column ??
          defaults[initial.kind].geometry_column ??
          "geom",
        type_name: layer?.type_name ?? "",
      };
    return defaults;
  });
  const config = drafts[kind];
  const capability = capabilities[kind];
  useEffect(() => {
    let active = true;
    invoke<{
      databases: Array<{
        kind: SourceKind;
        available: boolean;
        reason: string;
      }>;
    }>("get_database_capabilities")
      .then((result) => {
        if (active)
          setCapabilities(
            Object.fromEntries(
              result.databases.map((item) => [item.kind, item]),
            ),
          );
      })
      .catch(() => {
        if (active)
          setCapabilityError("无法检测数据库驱动，请确认已启动最新桌面版本。");
      });
    return () => {
      active = false;
    };
  }, []);
  function change(key: string, value: string | number) {
    const next = { ...config, [key]: value };
    if (key === "password") setCredentialProvided(true);
    else if (initial) {
      const connectionConfig = (draft: Record<string, string | number>) => ({
        ...draft,
        default_schema: layerMode
          ? (initial.config.default_schema ?? "")
          : draft.scope === "schema"
            ? draft.schema
            : "",
      });
      let changed = true;
      try {
        changed =
          connectionIdentity({
            ...initial,
            config: connectionConfig(config),
          }) !==
          connectionIdentity({ ...initial, config: connectionConfig(next) });
      } catch {
        // 编辑中的服务地址可能暂时无效，保存时再显示校验提示。
      }
      if (changed) {
        next.password = "";
        setCredentialProvided(false);
      }
    }
    setDrafts((previous) => ({ ...previous, [kind]: next }));
    setStatus("");
  }
  function field(
    key: string,
    label: string,
    options: {
      required?: boolean;
      type?: string;
      wide?: boolean;
      placeholder?: string;
    } = {},
  ) {
    return (
      <label className={options.wide ? "source-tools__wide" : undefined}>
        {label}
        <input
          value={config[key] ?? ""}
          required={options.required}
          type={options.type ?? "text"}
          placeholder={options.placeholder}
          min={options.type === "number" ? 1 : undefined}
          max={options.type === "number" ? 65535 : undefined}
          autoComplete={
            key === "password"
              ? "current-password"
              : key === "user"
                ? "username"
                : undefined
          }
          onWheel={
            options.type === "number"
              ? (event) => event.currentTarget.blur()
              : undefined
          }
          onChange={(event) =>
            change(
              key,
              options.type === "number"
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        />
      </label>
    );
  }
  function choice(
    key: string,
    label: string,
    options: Array<[string, string]>,
  ) {
    return (
      <label>
        {label}
        <select
          value={config[key] ?? ""}
          onChange={(event) =>
            change(
              key,
              key === "page_size"
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        >
          {options.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
    );
  }
  async function testConnection() {
    setBusy(true);
    setStatus("正在测试连接…");
    try {
      const result = await invoke<{ message: string }>(
        "test_remote_connection",
        { connection: { kind, ...config } },
      );
      setStatus(result.message);
      setCredentialProvided(true);
      onAuthenticated?.(config);
    } catch (error) {
      setStatus(
        typeof error === "string" ? error : "连接测试失败，请检查配置。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function chooseFile() {
    try {
      const path = await openFile([
        {
          name: sourceLabels[kind],
          extensions: kind === "gpkg" ? ["gpkg"] : ["sqlite", "db", "sqlite3"],
        },
      ]);
      if (typeof path === "string") change("path", path);
    } catch {
      setStatus("无法打开文件选择器，请检查桌面运行环境。");
    }
  }
  async function save() {
    setBusy(true);
    try {
      await onSave(
        name.trim(),
        kind,
        {
          ...config,
          default_schema: layerMode
            ? (initial?.config.default_schema ?? "")
            : config.scope === "schema"
              ? config.schema
              : "",
        },
        credentialProvided,
        rememberPassword,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="source-tools"
      aria-label="编辑数据连接"
      onInvalidCapture={(event) => {
        const details = (event.target as HTMLElement).closest("details");
        if (details) details.open = true;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) save();
      }}
    >
      {!layerMode && (
        <label className="connection-name">
          连接名称
          <input
            required
            maxLength={100}
            value={name}
            placeholder="例如：市政道路库"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      )}
      {!layerMode && (
        <div
          className="source-tools__tabs"
          role="tablist"
          aria-label="数据源类型"
          onKeyDown={(event) => {
            if (
              ["ArrowLeft", "ArrowRight"].includes(event.key) &&
              !initial &&
              !busy
            ) {
              event.preventDefault();
              const next = kind === "wfs" ? "postgis" : "wfs";
              setKind(next);
              event.currentTarget
                .querySelector<HTMLButtonElement>(`[data-kind="${next}"]`)
                ?.focus();
            }
          }}
        >
          <button
            type="button"
            role="tab"
            data-kind="postgis"
            aria-selected={kind !== "wfs"}
            disabled={busy || Boolean(initial)}
            onClick={() => {
              setKind("postgis");
              setStatus("");
            }}
          >
            数据库
          </button>
          <button
            type="button"
            role="tab"
            data-kind="wfs"
            aria-selected={kind === "wfs"}
            disabled={busy || Boolean(initial)}
            onClick={() => {
              setKind("wfs");
              setStatus("");
            }}
          >
            WFS 服务
          </button>
        </div>
      )}
      <p className="source-tools__note">
        {layerMode
          ? `${initial?.name} · 手动登记路线图层；也可关闭管理窗口后连接并浏览空间表。`
          : "先保存数据库或服务连接，图层可稍后添加。"}
      </p>
      <fieldset disabled={busy} className="source-tools__fields">
        <div className="source-tools__grid">
          {!layerMode && kind !== "wfs" && (
            <label className="source-tools__wide">
              数据库类型
              <select
                aria-label="数据库类型"
                disabled={Boolean(initial)}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as SourceKind);
                  setStatus("");
                }}
              >
                {(Object.keys(sourceLabels) as SourceKind[])
                  .filter((key) => key !== "wfs")
                  .map((key) => (
                    <option key={key} value={key}>
                      {sourceLabels[key]}
                      {capabilities[key]?.available === false
                        ? " · 需配置驱动"
                        : ""}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {layerMode ? (
            <>
              {schemaDatabase(kind) &&
                field("schema", "Schema", { required: true })}
              {kind === "wfs" &&
                field("type_name", "路线图层", { required: true, wide: true })}
              {kind !== "wfs" &&
                field("geometry_column", "几何列", { required: true })}
            </>
          ) : fileDatabase(kind) ? (
            <>
              <label className="source-tools__wide">
                数据库文件
                <input
                  required
                  value={config.path ?? ""}
                  placeholder="选择本地空间数据库"
                  onChange={(event) => change("path", event.target.value)}
                />
              </label>
              <button
                className="button outline source-tools__wide"
                type="button"
                onClick={() => void chooseFile()}
              >
                选择数据库文件
              </button>
            </>
          ) : kind === "wfs" ? (
            <>
              {field("url", "服务地址", {
                required: true,
                type: "url",
                wide: true,
                placeholder: "https://…/geoserver/wfs",
              })}
            </>
          ) : (
            <>
              {field("host", "主机", {
                required: true,
                wide: true,
                placeholder: "localhost / IP 地址",
              })}
              {field(
                kind === "oracle" ? "service" : "database",
                kind === "oracle" ? "服务名（Service Name）" : "数据库",
                { required: true },
              )}
              {kind === "mssql" &&
                choice("auth", "认证方式", [
                  ["sql", "数据库用户名 / 密码"],
                  ["windows", "Windows 集成认证"],
                ])}
              {schemaDatabase(kind) &&
                choice("scope", "连接范围", [
                  ["database", "整个数据库"],
                  ["schema", "指定 Schema"],
                ])}
              {schemaDatabase(kind) &&
                config.scope === "schema" &&
                field("schema", "Schema", { required: true })}
              {!(kind === "mssql" && config.auth === "windows") && (
                <>
                  {field("user", "用户", { required: true })}
                  {field("password", "密码", { type: "password" })}
                </>
              )}
            </>
          )}
          {kind !== "wfs" &&
            layerMode &&
            field("table", "路线表", { required: true, wide: true })}
        </div>
        {!layerMode && !fileDatabase(kind) && (
          <details className="source-tools__advanced">
            <summary>
              高级设置
              <span>{kind === "wfs" ? "版本 / 分页" : "端口 / 安全设置"}</span>
            </summary>
            <div className="source-tools__grid">
              {kind === "wfs" ? (
                <>
                  {choice("version", "版本", [
                    ["auto", "自动"],
                    ["2.0.0", "2.0.0"],
                    ["1.1.0", "1.1.0"],
                    ["1.0.0", "1.0.0"],
                  ])}
                  {choice("page_size", "分页大小", [
                    ["100", "100"],
                    ["250", "250"],
                    ["500", "500"],
                  ])}
                </>
              ) : (
                <>
                  {field("port", "端口", { required: true, type: "number" })}
                  {kind === "postgis" &&
                    choice("sslmode", "SSL", [
                      ["disable", "关闭 SSL (disable)"],
                      ["prefer", "优先 (prefer)"],
                      ["require", "必须 (require)"],
                    ])}
                  {kind === "mssql" && (
                    <>
                      {field("odbc_driver", "ODBC 驱动", {
                        required: true,
                        wide: true,
                      })}
                      {choice("encrypt", "加密连接", [
                        ["yes", "启用"],
                        ["no", "关闭"],
                      ])}
                      {choice("trust_certificate", "服务器证书", [
                        ["no", "校验证书"],
                        ["yes", "信任服务器证书（仅可信环境）"],
                      ])}
                    </>
                  )}
                </>
              )}
            </div>
          </details>
        )}
      </fieldset>
      {!layerMode && kind !== "wfs" && (
        <p className="source-browser__status" aria-live="polite">
          {capabilityError ||
            (capability
              ? capability.available
                ? `${sourceLabels[kind]} 驱动可用`
                : capability.reason
              : "正在检测数据库驱动…")}
        </p>
      )}
      <div className="source-tools__footer">
        {!layerMode && needsPassword({ kind, config } as SourceConnection) && (
          <label className="source-tools__remember">
            <input
              type="checkbox"
              checked={rememberPassword}
              disabled={busy}
              onChange={(event) => setRememberPassword(event.target.checked)}
            />
            保存密码，下次启动自动使用
          </label>
        )}
        <button type="submit" className="source-tools__primary" disabled={busy}>
          {layerMode ? "保存路线图层" : "保存连接"}
        </button>
        {!layerMode && (
          <button
            type="button"
            className="button outline"
            disabled={busy || (kind !== "wfs" && !capability?.available)}
            onClick={() => void testConnection()}
          >
            {busy ? "测试中…" : "测试连接"}
          </button>
        )}
        <p className="source-tools__note">
          连接配置保存在本机
          {needsPassword({ kind, config } as SourceConnection)
            ? " · 勾选后密码保存到 Windows 凭据管理器"
            : ""}
          {fileDatabase(kind) ? " · 以只读方式访问文件" : ""}
        </p>
        {status && <span role="status">{status}</span>}
      </div>
    </form>
  );
}

export function DataSourceTools({
  onImport,
  getMapBounds,
}: {
  onImport: (
    result: any,
    label: string,
    binding?: SourceBinding,
    loadPage?: (options: {
      expression: string;
      offset: number;
      limit: number;
    }) => Promise<any>,
  ) => void;
  getMapBounds?: () =>
    | [west: number, south: number, east: number, north: number]
    | null;
}) {
  const [status, setStatus] = useState("");
  const [connections, setConnections] = useState<SourceConnection[]>(() => {
    try {
      return readConnections();
    } catch {
      return [];
    }
  });
  const [selected, setSelected] = useState(connections[0]?.id ?? "");
  const [selectedLayer, setSelectedLayer] = useState(
    connections[0]?.layers[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [restoringPassword, setRestoringPassword] = useState(false);
  const editorRequest = useRef(0);
  const [showAuthentication, setShowAuthentication] = useState(false);
  const [catalogs, setCatalogs] = useState<
    Record<string, { identity: string; catalog: SourceCatalog }>
  >({});
  const [browsing, setBrowsing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [connectionActionsOpen, setConnectionActionsOpen] = useState(false);
  const [filterExpression, setFilterExpression] = useState("");
  const [pageSize, setPageSize] = useState(500);
  const [useMapBounds, setUseMapBounds] = useState(false);
  const [manager, setManager] = useState(false);
  const [edit, setEdit] = useState<{
    connection?: SourceConnection;
    layer?: SourceLayer;
    layerMode?: boolean;
    key: number;
  }>({ key: 0 });
  const [deleting, setDeleting] = useState<"connection" | "layer" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = connections.find((item) => item.id === selected);
  const identity = current ? connectionIdentity(current) : "";
  const catalog =
    current && catalogs[current.id]?.identity === identity
      ? catalogs[current.id].catalog
      : undefined;
  useEffect(() => {
    let active = true;
    const credential = current ? connectionSessions.get(current) : undefined;
    setPassword(credential ?? "");
    setPasswordSaved(false);
    setShowAuthentication(
      Boolean(current && needsPassword(current) && credential === undefined),
    );
    if (
      !current ||
      !needsPassword(current) ||
      current.rememberPassword === false
    ) {
      if (current && needsPassword(current) && credential === undefined)
        setConnectionActionsOpen(true);
      setRestoringPassword(false);
      return;
    }
    setRestoringPassword(true);
    void invoke<string | null>("read_connection_password", {
      connectionId: current.id,
      identity,
    })
      .then((stored) => {
        if (!active) return;
        setPasswordSaved(stored !== null);
        if (credential === undefined && stored !== null) {
          connectionSessions.set(current, stored);
          setPassword(stored);
          setShowAuthentication(false);
        } else if (credential === undefined) {
          setConnectionActionsOpen(true);
        }
      })
      .catch((error) => {
        if (active) {
          setConnectionActionsOpen(true);
          setStatus(`无法读取保存的密码：${String(error)}`);
        }
      })
      .finally(() => {
        if (active) setRestoringPassword(false);
      });
    return () => {
      active = false;
    };
  }, [selected, identity]);
  const layer =
    current?.layers.find((item) => item.id === selectedLayer) ??
    current?.layers[0];
  const source = current
    ? {
        type: "connection" as const,
        connection: {
          kind: current.kind,
          ...current.config,
          ...(layer ?? {}),
          password,
        },
      }
    : null;
  const capabilities = source ? sourceCapabilities(source) : null;
  useEffect(() => {
    const refresh = () => {
      try {
        setConnections(readConnections());
      } catch (error) {
        setStatus(String(error));
      }
    };
    refresh();
    window.addEventListener("road-connections-changed", refresh);
    return () =>
      window.removeEventListener("road-connections-changed", refresh);
  }, []);
  useEffect(() => {
    if (manager) {
      dialog.current?.showModal();
      return () => trigger.current?.focus({ preventScroll: true });
    }
  }, [manager]);
  function persist(next: SourceConnection[]) {
    writeConnections(next);
    setConnections(next);
  }
  async function persistCredentialChange(
    next: SourceConnection[],
    mutate: () => Promise<unknown>,
  ) {
    // 先确认公开配置可写；系统凭据失败时恢复配置，避免产生孤立凭据。
    writeConnections(next);
    try {
      await mutate();
    } catch (error) {
      try {
        writeConnections(connections);
      } catch {
        setConnections(next);
        throw new Error(
          "系统凭据操作失败，连接配置恢复也失败，请检查本机存储后重新保存。",
        );
      }
      throw error;
    }
    setConnections(next);
  }
  function select(connection: SourceConnection) {
    setSelected(connection.id);
    setSelectedLayer(connection.layers[0]?.id ?? "");
    setPassword(connectionSessions.get(connection) ?? "");
    setShowAuthentication(
      needsPassword(connection) &&
        connectionSessions.get(connection) === undefined,
    );
    setStatus("");
    setCatalogOpen(false);
    setFilterExpression("");
    setUseMapBounds(false);
    setDeleting(null);
  }
  function selectLayer(layerId: string) {
    setSelectedLayer(layerId);
    setFilterExpression("");
    setUseMapBounds(false);
  }
  async function start(
    connection?: SourceConnection,
    target?: SourceLayer,
    layerMode = Boolean(target),
  ) {
    const request = ++editorRequest.current;
    let credentialError = "";
    if (
      connection &&
      connections.some((item) => item.id === connection.id) &&
      needsPassword(connection) &&
      connection.rememberPassword !== false &&
      connectionSessions.get(connection) === undefined
    ) {
      setRestoringPassword(true);
      try {
        const stored = await invoke<string | null>("read_connection_password", {
          connectionId: connection.id,
          identity: connectionIdentity(connection),
        });
        if (request !== editorRequest.current) return;
        if (stored !== null) connectionSessions.set(connection, stored);
      } catch (error) {
        credentialError = `无法读取保存的密码，请重新输入或取消保存：${String(error)}`;
      } finally {
        setRestoringPassword(false);
      }
    }
    setDeleting(null);
    setStatus(credentialError);
    setEdit({ connection, layer: target, layerMode, key: Date.now() });
    setManager(true);
  }
  async function save(
    name: string,
    kind: SourceKind,
    config: Record<string, string | number>,
    credentialProvided: boolean,
    rememberPassword: boolean,
  ) {
    const previous = edit.connection;
    if (
      connections.some(
        (item) =>
          item.id !== previous?.id &&
          item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      throw new Error("连接名称已存在，请使用不同名称。");
    const id = previous?.id ?? crypto.randomUUID();
    if (!edit.layerMode) {
      const next = publicConnection({
        id,
        name,
        kind,
        config,
        rememberPassword,
        layers: previous?.layers ?? [],
      });
      const changed =
        previous &&
        JSON.stringify(next.config) !== JSON.stringify(previous.config);
      if (changed)
        next.layers = next.layers.map((item) => ({
          ...item,
          mapping: undefined,
        }));
      await persistCredentialChange(
        [...connections.filter((item) => item.id !== id), next],
        async () => {
          if (needsPassword(next) && rememberPassword && credentialProvided) {
            await invoke("store_connection_password", {
              connectionId: id,
              identity: connectionIdentity(next),
              password: String(config.password ?? ""),
            });
          } else if (previous && needsPassword(previous)) {
            await invoke("delete_connection_password", { connectionId: id });
          }
        },
      );
      if (credentialProvided)
        connectionSessions.set(next, String(config.password ?? ""));
      else connectionSessions.delete(next.id);
      select(next);
      setPassword(String(config.password ?? ""));
      setPasswordSaved(
        needsPassword(next) && rememberPassword && credentialProvided,
      );
      setManager(false);
      setStatus(`已保存连接 ${name}；可按需添加路线图层。`);
      return;
    }
    if (
      schemaDatabase(kind) &&
      config.scope === "schema" &&
      config.schema !== config.default_schema
    )
      throw new Error(
        "此连接限定于指定 Schema；其他 Schema 请使用数据库级连接。",
      );
    const target: SourceLayer = {
      id: edit.layer?.id ?? crypto.randomUUID(),
      name:
        kind === "wfs"
          ? String(config.type_name)
          : schemaDatabase(kind) && config.schema
            ? `${config.schema}.${config.table}`
            : String(config.table),
      schema: String(config.schema ?? ""),
      table: String(config.table ?? ""),
      geometry_column: String(config.geometry_column ?? "geom"),
      type_name: String(config.type_name ?? ""),
    };
    target.name = catalogSourceLayer(target, target.id).name;
    if (
      previous?.layers.some(
        (item) =>
          item.id !== target.id &&
          catalogLayerKey(item) === catalogLayerKey(target),
      )
    )
      throw new Error("此图层已配置，请选择已有图层编辑。");
    const sameTarget =
      edit.layer &&
      target.schema === edit.layer.schema &&
      target.table === edit.layer.table &&
      target.geometry_column === edit.layer.geometry_column &&
      target.type_name === edit.layer.type_name &&
      kind === previous?.kind;
    const configChanged =
      previous &&
      JSON.stringify(publicConnection({ ...previous, config }).config) !==
        JSON.stringify(previous.config);
    if (sameTarget && !configChanged) target.mapping = edit.layer?.mapping;
    const clean = publicConnection({
      id,
      name,
      kind,
      config,
      rememberPassword: previous?.rememberPassword,
      layers:
        previous?.kind === kind
          ? [
              ...previous.layers
                .filter((item) => item.id !== target.id)
                .map((item) =>
                  configChanged ? { ...item, mapping: undefined } : item,
                ),
              target,
            ]
          : [target],
    });
    persist([...connections.filter((item) => item.id !== id), clean]);
    if (credentialProvided)
      connectionSessions.set(clean, String(config.password ?? ""));
    else connectionSessions.delete(clean.id);
    select(clean);
    setSelectedLayer(target.id);
    setPassword(String(config.password ?? ""));
    setManager(false);
    setStatus(`已保存 ${name} · ${target.name}`);
  }
  async function browse() {
    if (!current || busy || restoringPassword) return;
    const connection = current;
    setBusy(true);
    setBrowsing(true);
    setCatalogs((previous) => {
      const next = { ...previous };
      delete next[connection.id];
      return next;
    });
    setStatus("正在连接并读取空间图层目录…");
    setConnectionActionsOpen(true);
    try {
      const result = await invoke<SourceCatalog>("list_remote_layers", {
        connection: { kind: connection.kind, ...connection.config, password },
      });
      connectionSessions.set(connection, password);
      const credentialWarning = await rememberAuthenticated(
        connection,
        password,
      );
      setShowAuthentication(false);
      setCatalogOpen(true);
      setCatalogs((previous) => ({
        ...previous,
        [connection.id]: {
          identity: connectionIdentity(connection),
          catalog: result,
        },
      }));
      setStatus(
        `连接成功，发现 ${result.schemas.length} 个 Schema、${result.layers.length} 个空间图层。请选择路线表后添加。${credentialWarning}`,
      );
    } catch (error) {
      if (needsPassword(connection)) setShowAuthentication(true);
      setStatus(
        typeof error === "string"
          ? error
          : "无法读取图层目录，请检查认证、权限和数据库驱动。",
      );
    } finally {
      setBusy(false);
      setBrowsing(false);
    }
  }
  function addCatalogLayer(target: CatalogLayer) {
    if (!current || busy) return;
    try {
      const existing = current.layers.find(
        (item) => catalogLayerKey(item) === catalogLayerKey(target),
      );
      if (existing) {
        selectLayer(existing.id);
        setCatalogOpen(false);
        setStatus(`已选择现有路线图层 ${existing.name}。`);
        return;
      }
      const added = catalogSourceLayer(target);
      const changed = { ...current, layers: [...current.layers, added] };
      persist(
        connections.map((item) => (item.id === current.id ? changed : item)),
      );
      selectLayer(added.id);
      setCatalogOpen(false);
      setStatus(`已添加 ${added.name}；读取后配置此图层的字段映射。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }
  async function read() {
    if (!current || !layer || busy || restoringPassword) return;
    setBusy(true);
    setStatus("");
    try {
      const bbox = useMapBounds ? (getMapBounds?.() ?? null) : null;
      if (!source || !capabilities) return;
      const pageBounds = bbox
        ? ([...bbox] as [number, number, number, number])
        : undefined;
      const imported: any = await readSourcePage(source, {
        expression: capabilities.attribute_filter ? filterExpression : "",
        offset: 0,
        limit: pageSize,
        ...(capabilities.spatial_filter && pageBounds
          ? { bbox: pageBounds }
          : {}),
      });
      const binding = bindingFor(current, layer);
      const loadPage = async (options: {
        expression: string;
        offset: number;
        limit: number;
      }) => {
        return readSourcePage(source, {
          ...options,
          expression: capabilities.attribute_filter ? options.expression : "",
          ...(capabilities.spatial_filter && pageBounds
            ? { bbox: pageBounds }
            : {}),
        });
      };
      onImport(
        imported,
        binding.label,
        binding,
        isPageable(imported.capabilities) ? loadPage : undefined,
      );
      connectionSessions.set(current, password);
      const credentialWarning = await rememberAuthenticated(current, password);
      setShowAuthentication(false);
      const count =
        imported.collection?.features?.length ?? imported.feature_count ?? 0;
      const more = Boolean(imported.has_more || imported.truncated);
      const orderWarning =
        isPageable(imported.capabilities) && !imported.capabilities.stable_order
          ? "当前图层未确认稳定排序，继续翻页时可能出现重复或遗漏。"
          : "";
      setConnectionActionsOpen(false);
      setCatalogOpen(false);
      setStatus(
        `已取得 ${count} 条候选，请在属性表选择后加载地图。${more ? (isPageable(imported.capabilities) ? `本批 ${count} 条，仍有更多；可继续翻页或缩小来源条件。` : "已达到本批快照上限；此数据源不支持翻页或来源条件筛选。") : ""}${orderWarning}${credentialWarning}`,
      );
    } catch (error) {
      setStatus(
        typeof error === "string" ? error : "读取失败，请检查连接与图层配置。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function rememberAuthenticated(
    connection: SourceConnection,
    credential: string,
  ) {
    if (!needsPassword(connection) || connection.rememberPassword === false)
      return "";
    try {
      await invoke("store_connection_password", {
        connectionId: connection.id,
        identity: connectionIdentity(connection),
        password: credential,
      });
      setPasswordSaved(true);
      return "";
    } catch (error) {
      setPasswordSaved(false);
      return `；密码保存失败，本次连接仍可使用：${String(error)}`;
    }
  }
  async function changeRememberPassword(remember: boolean) {
    if (!current || busy || restoringPassword) return;
    setBusy(true);
    try {
      await persistCredentialChange(
        connections.map((item) =>
          item.id === current.id
            ? { ...item, rememberPassword: remember }
            : item,
        ),
        async () => {
          if (!remember)
            await invoke("delete_connection_password", {
              connectionId: current.id,
            });
        },
      );
      if (!remember) setPasswordSaved(false);
      setStatus(
        remember
          ? "连接成功后保存密码，下次启动自动使用。"
          : "已清除保存的密码；本次会话仍可继续使用。",
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="source-tools source-browser"
      aria-label="连接路线数据源"
    >
      {connections.length ? (
        <>
          <label>
            数据连接
            <select
              aria-label="选择数据连接"
              disabled={busy || restoringPassword}
              value={selected}
              onChange={(event) => {
                const c = connections.find(
                  (item) => item.id === event.target.value,
                );
                if (c) select(c);
              }}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {sourceLabels[c.kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            已添加的路线图层
            <select
              aria-label="选择数据源图层"
              disabled={busy || !current?.layers.length}
              value={layer?.id ?? ""}
              onChange={(event) => selectLayer(event.target.value)}
            >
              {!current?.layers.length && (
                <option value="">尚未添加路线图层</option>
              )}
              {current?.layers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.mapping ? " · 已配置映射" : ""}
                </option>
              ))}
            </select>
          </label>
          {layer && capabilities && (
            <div
              className="source-browser__capability"
              aria-label="数据源读取能力"
            >
              {capabilities.query_scope === "source"
                ? capabilities.native_dialect === "postgres"
                  ? "数据库查询"
                  : "本地查询"
                : "有界快照"}
            </div>
          )}
          {layer &&
            capabilities &&
            (capabilities.attribute_filter ||
              capabilities.pagination ||
              capabilities.spatial_filter) && (
              <details className="source-browser__read-range">
                <summary>读取范围</summary>
                <div className="source-browser__read-range-fields">
                  {capabilities.attribute_filter && (
                    <label>
                      筛选条件
                      <input
                        value={filterExpression}
                        placeholder="例如: route_type = '高速公路'"
                        disabled={busy}
                        onChange={(event) =>
                          setFilterExpression(event.target.value)
                        }
                      />
                      <small>按数据源支持的表达式筛选属性。</small>
                    </label>
                  )}
                  {capabilities.pagination && (
                    <label>
                      每批读取数量
                      <select
                        value={pageSize}
                        disabled={busy}
                        onChange={(event) =>
                          setPageSize(Number(event.target.value))
                        }
                      >
                        {[100, 500, 2000, 10000].map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {capabilities.spatial_filter && (
                    <label className="source-browser__bounds-toggle">
                      <input
                        type="checkbox"
                        checked={useMapBounds}
                        disabled={busy || !getMapBounds}
                        onChange={(event) =>
                          setUseMapBounds(event.target.checked)
                        }
                      />
                      仅读取当前地图范围
                      {!getMapBounds && <small>当前未提供地图范围。</small>}
                    </label>
                  )}
                </div>
              </details>
            )}
          {layer && capabilities?.query_scope === "snapshot" && (
            <p className="source-browser__snapshot-note" role="note">
              此来源仅读取最多 {pageSize}{" "}
              条有界快照；不支持来源条件筛选、地图范围筛选或翻页。
            </p>
          )}
          <button
            className="source-tools__primary"
            disabled={busy || restoringPassword || !current}
            onClick={() => (layer ? void read() : void browse())}
          >
            {busy
              ? browsing
                ? "正在连接…"
                : "读取中…"
              : layer
                ? "打开路线数据"
                : "浏览空间目录"}
          </button>
          <details
            className="source-browser__operations"
            open={connectionActionsOpen}
            onToggle={(event) =>
              setConnectionActionsOpen(event.currentTarget.open)
            }
          >
            <summary>连接操作</summary>
            <button
              type="button"
              ref={trigger}
              disabled={busy || restoringPassword}
              onClick={() => void start(current)}
            >
              <Settings2 size={15} />
              管理数据连接
            </button>
            {current && needsPassword(current) && (
              <div className="source-browser__authentication">
                {!showAuthentication && !restoringPassword && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setShowAuthentication(true);
                      setConnectionActionsOpen(true);
                    }}
                  >
                    更换认证
                  </button>
                )}
                {showAuthentication && (
                  <>
                    <label>
                      连接密码
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        disabled={busy || restoringPassword}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <small>无需密码的认证方式可留空。</small>
                    </label>
                    <label className="source-tools__remember">
                      <input
                        type="checkbox"
                        checked={current.rememberPassword !== false}
                        disabled={busy || restoringPassword}
                        onChange={(event) =>
                          void changeRememberPassword(event.target.checked)
                        }
                      />
                      保存密码，下次启动自动使用
                    </label>
                    {passwordSaved && (
                      <button
                        type="button"
                        disabled={busy || restoringPassword}
                        onClick={() => void changeRememberPassword(false)}
                      >
                        清除保存密码
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            <button
              className="button outline"
              disabled={busy || restoringPassword || !current}
              onClick={() => void browse()}
            >
              {browsing
                ? "正在浏览…"
                : catalog
                  ? "刷新空间图层目录"
                  : "浏览空间目录"}
            </button>
            {catalog && (
              <details
                className="source-browser__directory"
                open={catalogOpen}
                onToggle={(event) => setCatalogOpen(event.currentTarget.open)}
              >
                <summary>空间图层目录</summary>
                <fieldset className="source-browser__catalog" disabled={busy}>
                  <SourceCatalogPicker
                    catalog={catalog}
                    kind={current?.kind ?? "postgis"}
                    defaultSchema={String(current?.config.default_schema ?? "")}
                    onAdd={addCatalogLayer}
                  />
                </fieldset>
              </details>
            )}
            <button
              type="button"
              className="source-browser__manual"
              disabled={busy || restoringPassword}
              onClick={() => start(current, undefined, true)}
            >
              手动登记路线图层…
            </button>
          </details>
        </>
      ) : (
        <div className="source-browser__empty">
          <Database size={26} />
          <strong>添加第一个数据连接</strong>
          <p>管理多个数据库、Schema 和 WFS 图层。</p>
          <button className="source-tools__primary" onClick={() => start()}>
            <Plus size={15} />
            新建连接
          </button>
        </div>
      )}
      {status && (
        <p className="source-browser__status" role="status">
          {status}
        </p>
      )}
      {manager && (
        <dialog
          ref={dialog}
          className="workbench-dialog connection-manager"
          aria-label="数据连接管理"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (!busy && !restoringPassword) setManager(false);
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            if (!busy && !restoringPassword) setManager(false);
          }}
        >
          <header className="dialog-title">
            <div>
              <h2>数据连接管理</h2>
              <p>连接可包含多个 Schema / 图层，字段规则按图层保存。</p>
            </div>
            <button
              className="icon-button"
              aria-label="关闭连接管理"
              disabled={busy || restoringPassword}
              onClick={() => setManager(false)}
            >
              <X size={18} />
            </button>
          </header>
          {status && (
            <p className="connection-manager__error" role="alert">
              {status}
            </p>
          )}
          <div
            className="connection-manager__body"
            inert={restoringPassword || busy}
          >
            <aside className="connection-manager__list">
              <button className="button outline" onClick={() => start()}>
                <Plus size={15} />
                新建连接
              </button>
              {connections.map((c) => (
                <div
                  key={c.id}
                  className={
                    edit.connection?.id === c.id
                      ? "connection-item active"
                      : "connection-item"
                  }
                >
                  <button onClick={() => start(c)}>
                    <Database size={16} />
                    <span>
                      <strong>{c.name}</strong>
                      <small>
                        {sourceLabels[c.kind]} · {c.layers.length} 个图层
                      </small>
                    </span>
                  </button>
                  {edit.connection?.id === c.id &&
                    c.layers.map((l) => (
                      <button
                        key={l.id}
                        className={
                          edit.layer?.id === l.id
                            ? "connection-layer active"
                            : "connection-layer"
                        }
                        onClick={() => start(c, l)}
                      >
                        {l.name}
                      </button>
                    ))}
                </div>
              ))}
            </aside>
            <div className="connection-manager__editor">
              <div className="connection-manager__actions">
                <strong>
                  {edit.layerMode
                    ? "手动编辑路线图层"
                    : edit.connection
                      ? "编辑连接"
                      : "新建连接"}
                </strong>
                {edit.connection && (
                  <>
                    <button
                      title="添加其他 Schema / 图层"
                      aria-label="添加数据源图层"
                      onClick={() => start(edit.connection, undefined, true)}
                    >
                      <Plus size={15} />
                    </button>
                    <button
                      title="复制连接"
                      aria-label="复制数据连接"
                      onClick={() =>
                        start(
                          {
                            ...edit.connection!,
                            id: crypto.randomUUID(),
                            name: edit.connection!.name + " 副本",
                            layers: [],
                          },
                          edit.layer
                            ? {
                                ...edit.layer,
                                id: crypto.randomUUID(),
                                mapping: undefined,
                              }
                            : undefined,
                        )
                      }
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      aria-label="删除数据源图层"
                      title="删除当前图层配置"
                      disabled={!edit.layer}
                      onClick={() => setDeleting("layer")}
                    >
                      <Layers3 size={15} />
                      <X size={12} />
                    </button>
                    <button
                      aria-label="删除数据连接"
                      onClick={() => setDeleting("connection")}
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
              {deleting && (
                <div className="connection-delete" role="alert">
                  <span>
                    {deleting === "layer"
                      ? "删除此图层配置？"
                      : "删除此连接及其图层配置？"}
                    工程成果保留。
                  </span>
                  <button
                    disabled={busy || restoringPassword}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        if (
                          deleting === "layer" &&
                          edit.connection &&
                          edit.layer
                        ) {
                          const changed = {
                            ...edit.connection,
                            layers: edit.connection.layers.filter(
                              (item) => item.id !== edit.layer?.id,
                            ),
                          };
                          persist(
                            connections.map((item) =>
                              item.id === changed.id ? changed : item,
                            ),
                          );
                          if (selected === changed.id)
                            setSelectedLayer(changed.layers[0]?.id ?? "");
                          start(changed, changed.layers[0]);
                        } else {
                          const next = connections.filter(
                            (c) => c.id !== edit.connection?.id,
                          );
                          await persistCredentialChange(next, async () => {
                            if (
                              edit.connection &&
                              needsPassword(edit.connection)
                            )
                              await invoke("delete_connection_password", {
                                connectionId: edit.connection.id,
                              });
                          });
                          if (edit.connection)
                            connectionSessions.delete(edit.connection.id);
                          if (selected === edit.connection?.id) {
                            setSelected(next[0]?.id ?? "");
                            setSelectedLayer(next[0]?.layers[0]?.id ?? "");
                          }
                          start();
                        }
                      } catch (error) {
                        setStatus(String(error));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    确认删除
                  </button>
                  <button onClick={() => setDeleting(null)}>取消</button>
                </div>
              )}
              <ConnectionEditor
                key={edit.key}
                initial={edit.connection}
                layer={edit.layer}
                layerMode={edit.layerMode}
                sessionPassword={
                  edit.connection
                    ? (connectionSessions.get(edit.connection) ?? "")
                    : ""
                }
                sessionProvided={Boolean(
                  edit.connection &&
                    connectionSessions.get(edit.connection) !== undefined,
                )}
                onAuthenticated={(config) => {
                  const connection = edit.connection;
                  if (
                    connection &&
                    connectionIdentity({ ...connection, config }) ===
                      connectionIdentity(connection)
                  ) {
                    const credential = String(config.password ?? "");
                    connectionSessions.set(connection, credential);
                    if (connection.id === selected) {
                      setPassword(credential);
                      if (credential !== password) setPasswordSaved(false);
                      setShowAuthentication(false);
                    }
                  }
                }}
                onSave={async (...args) => {
                  setBusy(true);
                  try {
                    await save(...args);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </div>
          </div>
        </dialog>
      )}
    </section>
  );
}

export function FieldMappingTools({
  fields,
  attributes = {},
  value = emptyMapping,
  onChange,
  context,
  onSaveRule,
}: {
  context?: string;
  onSaveRule?: () => void;
  fields: Field[];
  attributes?: Record<string, unknown>;
  value?: Record<string, string | null | boolean | undefined>;
  onChange: (mapping: Record<string, string | null | boolean>) => void;
}) {
  const fieldDetails = useMemo(
    () =>
      fields
        .map((field) => (typeof field === "string" ? { name: field } : field))
        .filter((field) => field.name),
    [fields],
  );
  const names = fieldDetails.map((field) => field.name);
  const mapping = Object.fromEntries(
    mappingFields.map(([key]) => [
      key,
      typeof value[key] === "string" ? value[key] : "",
    ]),
  ) as Record<string, string>;
  const fallback = value.mapping_null_fallback === true;
  const valueType = (value: unknown) => {
    if (value == null) return "未知";
    if (Array.isArray(value)) return "数组";
    if (typeof value === "number")
      return Number.isInteger(value) ? "整数" : "数值";
    if (typeof value === "boolean") return "布尔值";
    if (typeof value === "string") return "文本";
    return "对象";
  };
  const fieldType = (field: (typeof fieldDetails)[number]) =>
    field.type || valueType(attributes[field.name]);
  const fieldDescription = (field: (typeof fieldDetails)[number]) =>
    field.comment || field.description || "暂无字段注释";
  const sample = names
    .map((name) => `${name}: ${String(attributes[name] ?? "空")}`)
    .join("；");

  function update(key: string, field: string) {
    const next = { ...mapping, [key]: field };
    onChange({
      ...Object.fromEntries(
        mappingFields.map(([fieldKey]) => [fieldKey, next[fieldKey] || null]),
      ),
      mapping_null_fallback: fallback,
    });
  }

  function updateFallback(checked: boolean) {
    onChange({
      ...Object.fromEntries(
        mappingFields.map(([key]) => [key, mapping[key] || null]),
      ),
      mapping_null_fallback: checked,
    });
  }

  return (
    <section className="field-mapping" aria-label="字段映射">
      <header>
        <h3>字段映射与横断面属性</h3>
        <p>
          宽度按米解释；路线左右侧按输入路线点序定义。总宽度不会自动当作车道宽度。
        </p>
      </header>
      <div className="field-mapping__context">
        {context ?? "当前本地路线 · 独立字段映射"}
      </div>
      <div className="field-mapping__actions">
        <button
          type="button"
          disabled={!names.length}
          onClick={() => {
            const next = Object.fromEntries(
              mappingFields.map(([key, _label, aliases]) => {
                const accepted = new Set(aliases.map(normalized));
                return [
                  key,
                  names.find((name) => accepted.has(normalized(name))) ?? "",
                ];
              }),
            );
            onChange({
              ...Object.fromEntries(
                Object.entries(next).map(([key, name]) => [key, name || null]),
              ),
              mapping_null_fallback: fallback,
            });
          }}
        >
          自动识别字段
        </button>
        {onSaveRule && (
          <button type="button" disabled={!names.length} onClick={onSaveRule}>
            保存此图层规则
          </button>
        )}
      </div>
      <div className="field-mapping__grid">
        {mappingFields.map(([key, label]) => (
          <label className="field-mapping__row" key={key}>
            <span className="field-mapping__target">{label}</span>
            <select
              value={mapping[key] ?? ""}
              onChange={(event) => update(key, event.target.value)}
            >
              <option value="">手动默认值 · 使用横断面中的当前值</option>
              {fieldDetails.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name} · {fieldType(field)} · {fieldDescription(field)}
                </option>
              ))}
            </select>
            {mapping[key] && (
              <span className="field-mapping__field-meta">
                <code>{mapping[key]}</code>
                <span>
                  {fieldType(
                    fieldDetails.find(
                      (field) => field.name === mapping[key],
                    ) ?? { name: mapping[key] },
                  )}
                </span>
                <span>
                  {fieldDescription(
                    fieldDetails.find(
                      (field) => field.name === mapping[key],
                    ) ?? { name: mapping[key] },
                  )}
                </span>
              </span>
            )}
          </label>
        ))}
      </div>
      <label className="field-mapping__fallback">
        <input
          type="checkbox"
          checked={fallback}
          onChange={(event) => updateFallback(event.target.checked)}
        />
        映射字段为空时使用手动默认值
      </label>
      <div className="field-mapping__preview">
        <strong>当前要素预览</strong>
        <span>{sample || "当前数据没有属性字段。"}</span>
      </div>
    </section>
  );
}
