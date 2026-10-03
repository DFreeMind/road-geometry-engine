export type SourceKind =
  | "postgis"
  | "mysql"
  | "mssql"
  | "oracle"
  | "sqlite"
  | "gpkg"
  | "wfs";
export const sourceLabels: Record<SourceKind, string> = {
  postgis: "PostgreSQL / PostGIS",
  mysql: "MySQL / MariaDB",
  mssql: "SQL Server Spatial",
  oracle: "Oracle Spatial",
  sqlite: "SQLite / SpatiaLite",
  gpkg: "GeoPackage",
  wfs: "WFS 服务",
};
export const fileDatabase = (kind: SourceKind) =>
  kind === "sqlite" || kind === "gpkg";
export const schemaDatabase = (kind: SourceKind) =>
  ["postgis", "mssql", "oracle"].includes(kind);
export type FieldMapping = Record<string, string | null | boolean>;
export type SourceLayer = {
  id: string;
  name: string;
  schema: string;
  table: string;
  geometry_column: string;
  type_name: string;
  mapping?: FieldMapping;
};
export type SourceConnection = {
  id: string;
  name: string;
  kind: SourceKind;
  config: Record<string, string | number>;
  rememberPassword?: boolean;
  layers: SourceLayer[];
};
export type SourceBinding = {
  connectionId: string;
  layerId: string;
  label: string;
  fingerprint: string;
  mapping?: FieldMapping;
};
export const connectionStorageKey = "road-data-connections-v1";
const keys = {
  postgis: [
    "host",
    "port",
    "database",
    "user",
    "sslmode",
    "scope",
    "default_schema",
  ],
  mysql: ["host", "port", "database", "user"],
  mssql: [
    "host",
    "port",
    "database",
    "user",
    "auth",
    "odbc_driver",
    "encrypt",
    "trust_certificate",
    "scope",
    "default_schema",
  ],
  oracle: ["host", "port", "service", "user", "scope", "default_schema"],
  sqlite: ["path"],
  gpkg: ["path"],
  wfs: ["url", "version", "page_size"],
};

/** 使用白名单保存连接偏好和公开参数，密码及附加凭据不会进入配置库。 */
export function publicConnection(value: SourceConnection): SourceConnection {
  const config: SourceConnection["config"] = {};
  for (const key of keys[value.kind])
    if (["string", "number"].includes(typeof value.config[key]))
      config[key] = value.config[key];
  // 默认数据库范围不写入附加字段，保持旧连接及映射指纹兼容。
  if (config.scope === "database") delete config.scope;
  if (config.default_schema === "") delete config.default_schema;
  if (value.kind === "wfs" && typeof config.url === "string") {
    const url = new URL(config.url);
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) =>
        /token|password|secret|api[_-]?key|authorization/i.test(key),
      )
    )
      throw new Error("服务地址含认证信息，请使用不含凭据的地址。");
  }
  return {
    id: value.id,
    name: value.name.trim(),
    kind: value.kind,
    config,
    ...(value.rememberPassword === undefined
      ? {}
      : { rememberPassword: value.rememberPassword }),
    layers: value.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      schema: layer.schema,
      table: layer.table,
      geometry_column: layer.geometry_column,
      type_name: layer.type_name,
      mapping: layer.mapping,
    })),
  };
}
export function readConnections(
  storage: Pick<Storage, "getItem"> = localStorage,
): SourceConnection[] {
  const raw = storage.getItem(connectionStorageKey);
  if (!raw) return [];
  const data = JSON.parse(raw);
  if (data.version !== 1 || !Array.isArray(data.connections))
    throw new Error("连接配置库格式无效；原配置未被覆盖。");
  return data.connections.map((value: SourceConnection) => {
    if (
      !value.id ||
      !value.name ||
      !keys[value.kind] ||
      !Array.isArray(value.layers) ||
      !value.config
    )
      throw new Error("连接配置损坏；原配置未被覆盖。");
    return publicConnection(value);
  });
}
export function writeConnections(
  connections: SourceConnection[],
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  storage.setItem(
    connectionStorageKey,
    JSON.stringify({
      version: 1,
      connections: connections.map(publicConnection),
    }),
  );
}
export function layerFingerprint(
  connection: SourceConnection,
  layer: SourceLayer,
) {
  return JSON.stringify([
    connection.kind,
    publicConnection(connection).config,
    layer.schema,
    layer.table,
    layer.geometry_column,
    layer.type_name,
  ]);
}
export function bindingFor(
  connection: SourceConnection,
  layer: SourceLayer,
): SourceBinding {
  return {
    connectionId: connection.id,
    layerId: layer.id,
    label: `${connection.name} / ${layer.name}`,
    fingerprint: layerFingerprint(connection, layer),
    mapping: layer.mapping,
  };
}
/** 连接或图层配置改变时，不把旧映射写回新的数据源。 */
export function saveBindingMapping(
  binding: SourceBinding,
  mapping: FieldMapping,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
) {
  const connections = readConnections(storage);
  const connection = connections.find(
    (item) => item.id === binding.connectionId,
  );
  const layer = connection?.layers.find((item) => item.id === binding.layerId);
  if (
    !connection ||
    !layer ||
    layerFingerprint(connection, layer) !== binding.fingerprint
  )
    throw new Error("原连接或图层已改变；当前工程映射仍保留，但未更新连接库。");
  layer.mapping = { ...mapping };
  writeConnections(connections, storage);
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("road-connections-changed"));
}
