import { describe, expect, it, vi } from "vitest";
import {
  buildSourceQuery,
  isPageable,
  readSourcePage,
  sourceCapabilities,
  type RouteDataSource,
} from "../src/workbench/sourceAccess";

describe("source capabilities", () => {
  it.each<RouteDataSource>([
    { type: "file", path: "C:/data/routes.gpkg", layer_name: "routes" },
    {
      type: "connection",
      connection: { kind: "gpkg", path: "C:/data/routes.gpkg" },
    },
    {
      type: "connection",
      connection: { kind: "sqlite", path: "C:/data/routes.db" },
    },
    {
      type: "connection",
      connection: { kind: "postgis", host: "localhost" },
    },
  ])("declares source-level query for supported sources: %j", (source) => {
    const capabilities = sourceCapabilities(source);
    expect(capabilities).toMatchObject({
      query_scope: "source",
      pagination: true,
      attribute_filter: true,
      spatial_filter: true,
      stable_order: false,
    });
    expect(isPageable(capabilities)).toBe(true);
  });

  it.each(["mysql", "mssql", "oracle", "wfs", "unrecognized"])(
    "treats %s as a bounded snapshot",
    (kind) => {
      const capabilities = sourceCapabilities({
        type: "connection",
        connection: { kind },
      });
      expect(capabilities).toEqual({
        query_scope: "snapshot",
        pagination: false,
        attribute_filter: false,
        spatial_filter: false,
        native_dialect: null,
        stable_order: false,
      });
      expect(isPageable(capabilities)).toBe(false);
    },
  );
});

describe("source page requests", () => {
  it("builds the unified query shape with a limit and optional bbox", () => {
    expect(
      buildSourceQuery({
        expression: "  route_type = 'highway'  ",
        offset: 25,
        limit: 100,
        bbox: [1, 2, 3, 4],
      }),
    ).toEqual({
      expression: "route_type = 'highway'",
      offset: 25,
      limit: 100,
      bbox: [1, 2, 3, 4],
    });
    expect(buildSourceQuery({ expression: "", offset: 0, limit: 50 })).toEqual({
      expression: "",
      offset: 0,
      limit: 50,
    });
  });

  it("invokes query_vector_data with source and query, returning capabilities", async () => {
    const source: RouteDataSource = {
      type: "connection",
      connection: {
        kind: "postgis",
        host: "db.local",
        password: "private-token",
      },
    };
    const invoke = vi.fn(async () => ({
      collection: { type: "FeatureCollection", features: [] },
      feature_count: 0,
      capabilities: {
        query_scope: "source",
        pagination: true,
        attribute_filter: true,
        spatial_filter: true,
        native_dialect: "PostgreSQL",
        stable_order: false,
      },
    }));

    const result = await readSourcePage(
      source,
      { expression: "id > 5", offset: 10, limit: 100 },
      invoke,
    );

    expect(invoke).toHaveBeenCalledWith("query_vector_data", {
      source,
      query: { expression: "id > 5", offset: 10, limit: 100 },
    });
    expect(result.feature_count).toBe(0);
    expect(result.capabilities.query_scope).toBe("source");
    expect(result.capabilities.native_dialect).toBe("PostgreSQL");
    expect(JSON.stringify(result.capabilities)).not.toContain("private-token");
    expect(JSON.stringify(source)).toContain("private-token");
  });

  it("prefers validated native capabilities and falls back when absent", async () => {
    const source: RouteDataSource = {
      type: "connection",
      connection: { kind: "postgis" },
    };
    const nativeCapabilities = {
      query_scope: "source" as const,
      pagination: true,
      attribute_filter: true,
      spatial_filter: true,
      native_dialect: "PostgreSQL",
      stable_order: false,
    };
    const withNative = await readSourcePage(
      source,
      { expression: "", offset: 0, limit: 50 },
      vi.fn(async () => ({ capabilities: nativeCapabilities })),
    );
    expect(withNative.capabilities).toEqual(nativeCapabilities);

    const fallback = await readSourcePage(
      source,
      { expression: "", offset: 0, limit: 50 },
      vi.fn(async () => ({ feature_count: 2 })),
    );
    expect(fallback.capabilities).toEqual(sourceCapabilities(source));
    expect(isPageable(fallback.capabilities)).toBe(true);
  });

  it("allows a bounded snapshot request but rejects unsupported filtering and paging", async () => {
    const source: RouteDataSource = {
      type: "connection",
      connection: { kind: "mysql", password: "secret" },
    };
    const invoke = vi.fn(async () => ({ feature_count: 1 }));

    const result = await readSourcePage(
      source,
      { expression: "", offset: 0, limit: 500 },
      invoke,
    );
    expect(result.capabilities.query_scope).toBe("snapshot");
    await expect(
      readSourcePage(
        source,
        { expression: "route_id = 1", offset: 0, limit: 500 },
        invoke,
      ),
    ).rejects.toThrow("有界快照");
    await expect(
      readSourcePage(
        source,
        { expression: "", offset: 500, limit: 500 },
        invoke,
      ),
    ).rejects.toThrow("有界快照");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid bounds before invoking native code", async () => {
    const source: RouteDataSource = {
      type: "file",
      path: "C:/data/roads.gpkg",
    };
    const invoke = vi.fn();
    await expect(
      readSourcePage(
        source,
        {
          expression: "",
          offset: 0,
          limit: 10,
          bbox: [4, 0, 2, 1],
        },
        invoke,
      ),
    ).rejects.toThrow("地图范围无效");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("enforces the native read limit and safe offset range", () => {
    expect(() =>
      buildSourceQuery({
        expression: "",
        offset: Number.MAX_SAFE_INTEGER + 1,
        limit: 1,
      }),
    ).toThrow();
    expect(() =>
      buildSourceQuery({ expression: "", offset: 0, limit: 10_001 }),
    ).toThrow();
    expect(() =>
      buildSourceQuery({
        expression: "",
        offset: 0,
        limit: 1,
        bbox: [-181, 0, 10, 20],
      }),
    ).toThrow("地图范围无效");
  });
});
