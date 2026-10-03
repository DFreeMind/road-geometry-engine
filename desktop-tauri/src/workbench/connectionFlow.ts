import {
  publicConnection,
  type SourceConnection,
  type SourceLayer,
} from "./connections";

export type CatalogLayer = {
  schema: string;
  table: string;
  geometry_column: string;
  type_name: string;
  geometry_type?: string;
};

export type SourceCatalog = {
  schemas: string[];
  layers: CatalogLayer[];
};

const passwordKinds = new Set(["postgis", "mysql", "oracle"]);

/** 判断连接是否使用密码认证。 */
export function needsPassword(connection: SourceConnection): boolean {
  if (passwordKinds.has(connection.kind)) return true;
  return connection.kind === "mssql" && connection.config.auth !== "windows";
}

/** 身份只由可公开保存的连接参数构成，不受名称和图层变化影响。 */
export function connectionIdentity(connection: SourceConnection): string {
  return JSON.stringify([connection.kind, publicConnection(connection).config]);
}

/** 认证凭据只保存在当前进程内，并在连接身份改变后失效。 */
export class ConnectionSessions {
  private readonly sessions = new Map<
    string,
    { identity: string; password: string }
  >();

  get(connection: SourceConnection): string | undefined {
    const session = this.sessions.get(connection.id);
    if (!session) return undefined;
    if (session.identity !== connectionIdentity(connection)) {
      this.sessions.delete(connection.id);
      return undefined;
    }
    return session.password;
  }

  set(connection: SourceConnection, password: string): void {
    this.sessions.set(connection.id, {
      identity: connectionIdentity(connection),
      password,
    });
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }
}

/** 用目录关键字段稳定区分表和几何列。 */
export function catalogLayerKey(layer: CatalogLayer): string {
  if (layer.type_name) return JSON.stringify(["wfs", layer.type_name]);
  return JSON.stringify([
    layer.schema,
    layer.table,
    layer.geometry_column,
    layer.type_name,
  ]);
}

/** 将目录项转换为可保存的数据源图层。 */
export function catalogSourceLayer(
  layer: CatalogLayer,
  id: string = crypto.randomUUID(),
): SourceLayer {
  const tableName =
    layer.type_name ||
    (layer.schema ? `${layer.schema}.${layer.table}` : layer.table);
  return {
    id,
    name: layer.geometry_column
      ? `${tableName} (${layer.geometry_column})`
      : tableName,
    schema: layer.schema,
    table: layer.table,
    geometry_column: layer.geometry_column,
    type_name: layer.type_name,
  };
}

export function availableCatalogLayers(
  catalog: SourceCatalog,
  schema?: string,
): CatalogLayer[] {
  return schema === undefined
    ? catalog.layers
    : catalog.layers.filter((layer) => layer.schema === schema);
}

const lineTypes = new Set([
  "LINESTRING",
  "MULTILINESTRING",
  "CURVE",
  "MULTICURVE",
  "COMPOUNDCURVE",
  "CIRCULARSTRING",
  "MULTICIRCULARSTRING",
]);

const nonLineTypes = new Set([
  "POINT",
  "MULTIPOINT",
  "POLYGON",
  "MULTIPOLYGON",
  "SURFACE",
  "MULTISURFACE",
  "POLYHEDRALSURFACE",
  "TIN",
  "TRIANGLE",
  "GEOMETRYCOLLECTION",
]);

/** 未知类型允许进入路线候选，由界面提示人工确认；已知点面类型会被排除。 */
export function isRouteCatalogLayer(layer: CatalogLayer): boolean {
  const raw = layer.geometry_type?.trim().toUpperCase() ?? "";
  if (!raw || raw === "GEOMETRY" || raw === "UNKNOWN") return true;

  // PostgreSQL 系统目录使用 geometry(LineString,SRID) 形式声明列类型。
  const declared =
    raw.match(
      /^(?:[^()]*\.)?(?:GEOMETRY|GEOGRAPHY)\(([^,()]+)(?:,[^()]*)?\)$/,
    )?.[1] ?? raw;
  const base = declared
    .replace(/^3D\s*/, "")
    .replace(/^MEASURED\s*/, "")
    .replace(/^ST_/, "")
    .replace(/(?:ZM|Z|M|25D)$/, "")
    .replace(/[\s_-]/g, "");
  if (lineTypes.has(base)) return true;
  if (nonLineTypes.has(base)) return false;

  // 部分驱动会把多部件类型拆成两个词，归一化后再识别其基础类型。
  if (/^(MULTI)?(POINT|POLYGON|SURFACE)/.test(base)) return false;
  if (
    /^(LINESTRING|MULTILINESTRING|CURVE|MULTICURVE|COMPOUNDCURVE|CIRCULARSTRING|MULTICIRCULARSTRING)/.test(
      base,
    )
  )
    return true;
  return true;
}
