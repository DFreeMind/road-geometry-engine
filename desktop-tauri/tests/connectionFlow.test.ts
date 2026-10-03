import { describe, expect, it } from "vitest";
import type { SourceConnection } from "../src/workbench/connections";
import {
  availableCatalogLayers,
  catalogLayerKey,
  catalogSourceLayer,
  ConnectionSessions,
  connectionIdentity,
  isRouteCatalogLayer,
  needsPassword,
  type CatalogLayer,
  type SourceCatalog,
} from "../src/workbench/connectionFlow";

const connection = (
  overrides: Partial<SourceConnection> = {},
): SourceConnection => ({
  id: "db-1",
  name: "道路主库",
  kind: "postgis",
  config: {
    host: "localhost",
    port: 5432,
    database: "roads",
    user: "reader",
    password: "private",
  },
  layers: [],
  ...overrides,
});

const layer = (overrides: Partial<CatalogLayer> = {}): CatalogLayer => ({
  schema: "public",
  table: "routes",
  geometry_column: "geom",
  type_name: "",
  ...overrides,
});

describe("数据源连接与目录流程", () => {
  it("仅对密码认证的数据库要求密码", () => {
    expect(needsPassword(connection())).toBe(true);
    expect(needsPassword(connection({ kind: "mysql" }))).toBe(true);
    expect(needsPassword(connection({ kind: "oracle" }))).toBe(true);
    expect(
      needsPassword(connection({ kind: "mssql", config: { auth: "windows" } })),
    ).toBe(false);
    expect(needsPassword(connection({ kind: "mssql" }))).toBe(true);
    expect(needsPassword(connection({ kind: "sqlite" }))).toBe(false);
    expect(needsPassword(connection({ kind: "gpkg" }))).toBe(false);
    expect(needsPassword(connection({ kind: "wfs" }))).toBe(false);
  });

  it("身份不含名称、图层和凭据，只随公开连接参数或类型改变", () => {
    const original = connection();
    expect(
      connectionIdentity({
        ...original,
        name: "改名后的库",
        layers: [
          {
            id: "route",
            name: "public.routes",
            schema: "public",
            table: "routes",
            geometry_column: "geom",
            type_name: "",
          },
        ],
        config: { ...original.config, password: "another-secret" },
      }),
    ).toBe(connectionIdentity(original));
    expect(
      connectionIdentity({
        ...original,
        config: { ...original.config, host: "other-host" },
      }),
    ).not.toBe(connectionIdentity(original));
    expect(connectionIdentity({ ...original, kind: "mysql" })).not.toBe(
      connectionIdentity(original),
    );
  });

  it("会话密码仅驻留内存，支持空密码并在身份变化后清除", () => {
    const sessions = new ConnectionSessions();
    const original = connection();
    expect(sessions.get(original)).toBeUndefined();
    sessions.set(original, "secret");
    expect(sessions.get({ ...original, name: "新名称" })).toBe("secret");
    expect(
      sessions.get({
        ...original,
        config: { ...original.config, password: "updated" },
      }),
    ).toBe("secret");

    const changed = {
      ...original,
      config: { ...original.config, host: "changed-host" },
    };
    expect(sessions.get(changed)).toBeUndefined();
    expect(sessions.get(original)).toBeUndefined();

    sessions.set(original, "");
    expect(sessions.get(original)).toBe("");
    sessions.delete(original.id);
    expect(sessions.get(original)).toBeUndefined();
  });

  it("按 schema 列出目录项，并用全部关键字段区分图层", () => {
    const publicRoute = layer();
    const designRoute = layer({ schema: "design" });
    const alternateGeometry = layer({ geometry_column: "centerline" });
    const catalog: SourceCatalog = {
      schemas: ["public", "design"],
      layers: [publicRoute, designRoute, alternateGeometry],
    };

    expect(availableCatalogLayers(catalog, "public")).toEqual([
      publicRoute,
      alternateGeometry,
    ]);
    expect(availableCatalogLayers(catalog, "missing")).toEqual([]);
    expect(availableCatalogLayers(catalog)).toEqual(catalog.layers);
    expect(catalogLayerKey(publicRoute)).not.toBe(
      catalogLayerKey(alternateGeometry),
    );
    expect(catalogLayerKey(publicRoute)).toBe(
      catalogLayerKey(layer({ geometry_type: "LineString" })),
    );
    expect(catalogLayerKey(layer({ type_name: "roads:routes" }))).toBe(
      catalogLayerKey(
        layer({
          type_name: "roads:routes",
          schema: "",
          table: "",
          geometry_column: "",
        }),
      ),
    );
  });

  it("目录项可转为路线图层，名称带 schema、表名和几何列", () => {
    const result = catalogSourceLayer(
      layer({ geometry_column: "centerline" }),
      "stable-id",
    );
    expect(result).toEqual({
      id: "stable-id",
      name: "public.routes (centerline)",
      schema: "public",
      table: "routes",
      geometry_column: "centerline",
      type_name: "",
    });
    expect(catalogSourceLayer(layer({ schema: "" }), "file-layer").name).toBe(
      "routes (geom)",
    );
    expect(
      catalogSourceLayer(
        layer({ type_name: "workspace:roads", geometry_column: "" }),
        "wfs-layer",
      ).name,
    ).toBe("workspace:roads");
    expect(catalogSourceLayer(layer()).id).toBeTruthy();
  });

  it("路线候选接受线性和未知类型，排除已知非线空间类型", () => {
    for (const geometry_type of [
      "LineString",
      "MultiLineString",
      "Curve",
      "CompoundCurve",
      "CircularString",
      "MultiCurve",
      "LINESTRING Z",
      "3D Line String",
      "Multi Line String",
      "3D Measured Line String",
      "geometry(LineString,32650)",
      "geography(MultiLineStringZ,4326)",
    ])
      expect(isRouteCatalogLayer(layer({ geometry_type }))).toBe(true);

    for (const geometry_type of [
      "Point",
      "MultiPoint",
      "Polygon",
      "MultiPolygon",
      "GeometryCollection",
      "TIN",
      "3D Multi Polygon",
      "3D Measured Polygon",
      "geometry(Polygon,32650)",
      "geography(MultiPoint,4326)",
      "gis.geometry(Polygon,32650)",
    ])
      expect(isRouteCatalogLayer(layer({ geometry_type }))).toBe(false);

    for (const geometry_type of [undefined, "", "GEOMETRY", "Unknown"])
      expect(isRouteCatalogLayer(layer({ geometry_type }))).toBe(true);
  });
});
