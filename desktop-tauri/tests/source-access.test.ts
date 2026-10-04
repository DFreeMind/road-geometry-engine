import { describe, expect, it, vi } from "vitest";
import {
  buildSourceQuery,
  isPageable,
  readSourcePage,
  streamSourcePages,
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

describe("streaming complete source pages", () => {
  const capabilities = sourceCapabilities({
    type: "file",
    path: "C:/data/routes.gpkg",
  });

  it("streams more than 10,000 records in order and marks only the final page", async () => {
    const limit = 4_000;
    const total = 10_050;
    const batches: { count: number; final: boolean }[] = [];
    const requested: number[] = [];
    const result = await streamSourcePages<number>({
      capabilities,
      expression: "route_type = 'highway'",
      limit,
      loadPage: vi.fn(async ({ offset, expression }) => {
        requested.push(offset);
        expect(expression).toBe("route_type = 'highway'");
        const count = Math.min(limit, total - offset);
        return {
          offset,
          page_size: limit,
          has_more: offset + count < total,
          capabilities,
          collection: {
            features: Array.from(
              { length: count },
              (_item, index) => offset + index,
            ),
          },
        };
      }),
      onBatch: (features, final) => {
        batches.push({ count: features.length, final });
      },
    });

    expect(requested).toEqual([0, 4_000, 8_000]);
    expect(batches).toEqual([
      { count: 4_000, final: false },
      { count: 4_000, final: false },
      { count: 2_050, final: true },
    ]);
    expect(result).toMatchObject({
      pages: 3,
      loaded: total,
      nextOffset: 12_000,
      hasMore: false,
      cancelled: false,
    });
  });

  it("stops between committed pages when cancelled and does not mark a partial load final", async () => {
    let cancelled = false;
    const loaded: number[][] = [];
    const loadPage = vi.fn(
      async ({ offset }: { offset: number; limit: number }) => ({
        offset,
        page_size: 2,
        has_more: true,
        capabilities,
        collection: { features: [offset, offset + 1] },
      }),
    );
    const result = await streamSourcePages<number>({
      loadPage,
      capabilities,
      expression: "",
      limit: 2,
      isCancelled: () => cancelled,
      onBatch: (features, final) => {
        loaded.push(features);
        expect(final).toBe(false);
        cancelled = true;
      },
    });
    expect(result).toMatchObject({ pages: 1, loaded: 2, cancelled: true });
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual([[0, 1]]);
  });

  it("resumes from the returned offset after cancellation and reports run-local progress", async () => {
    const firstRun: number[][] = [];
    let cancelled = false;
    const loadPage = vi.fn(async ({ offset }: { offset: number }) => ({
      offset,
      page_size: 2,
      has_more: offset < 4,
      capabilities,
      collection: { features: [offset, offset + 1] },
    }));
    const stopped = await streamSourcePages<number>({
      loadPage,
      capabilities,
      expression: "",
      limit: 2,
      isCancelled: () => cancelled,
      onBatch: (features) => {
        firstRun.push(features);
        cancelled = true;
      },
    });
    expect(stopped).toMatchObject({
      pages: 1,
      loaded: 2,
      nextOffset: 2,
      hasMore: true,
      cancelled: true,
    });

    const resumedBatches: number[][] = [];
    const progress: {
      pages: number;
      loaded: number;
      nextOffset: number;
      hasMore: boolean;
    }[] = [];
    const resumed = await streamSourcePages<number>({
      loadPage,
      capabilities,
      expression: "",
      limit: 2,
      startOffset: stopped.nextOffset,
      onBatch: (features) => {
        resumedBatches.push(features);
      },
      onProgress: (item) => progress.push(item),
    });

    expect(loadPage.mock.calls.map(([query]) => query.offset)).toEqual([
      0, 2, 4,
    ]);
    expect(firstRun).toEqual([[0, 1]]);
    expect(resumedBatches).toEqual([
      [2, 3],
      [4, 5],
    ]);
    expect(progress).toEqual([
      { pages: 1, loaded: 2, nextOffset: 4, hasMore: true },
      { pages: 2, loaded: 4, nextOffset: 6, hasMore: false },
    ]);
    expect(resumed).toMatchObject({
      pages: 2,
      loaded: 4,
      nextOffset: 6,
      hasMore: false,
      cancelled: false,
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid resume offsets before reading (%s)",
    async (startOffset) => {
      const loadPage = vi.fn();
      await expect(
        streamSourcePages({
          capabilities,
          expression: "",
          limit: 10,
          startOffset,
          loadPage,
          onBatch: vi.fn(),
        }),
      ).rejects.toThrow("继续读取位置");
      expect(loadPage).not.toHaveBeenCalled();
    },
  );

  it("preserves earlier batches when a later page fails", async () => {
    const persisted: number[] = [];
    let calls = 0;
    await expect(
      streamSourcePages<number>({
        capabilities,
        expression: "",
        limit: 2,
        loadPage: async ({ offset }) => {
          calls++;
          if (calls === 2) throw new Error("磁盘读取失败");
          return {
            offset,
            page_size: 2,
            has_more: true,
            capabilities,
            collection: { features: [1, 2] },
          };
        },
        onBatch: (features) => {
          persisted.push(...features);
        },
      }),
    ).rejects.toThrow("磁盘读取失败");
    expect(persisted).toEqual([1, 2]);
  });

  it("rejects repeated or non-advancing returned offsets instead of duplicating pages", async () => {
    const batches: number[][] = [];
    await expect(
      streamSourcePages<number>({
        capabilities,
        expression: "",
        limit: 2,
        loadPage: async ({ offset }) => ({
          offset: offset === 0 ? 0 : 0,
          page_size: 2,
          has_more: true,
          capabilities,
          collection: { features: [1, 2] },
        }),
        onBatch: (features) => {
          batches.push(features);
        },
      }),
    ).rejects.toThrow("来源分页位置异常");
    expect(batches).toEqual([[1, 2]]);
  });

  it("refuses full reads from bounded snapshots and rejects a has_more page with no progress", async () => {
    const snapshot = sourceCapabilities({
      type: "connection",
      connection: { kind: "mysql" },
    });
    await expect(
      streamSourcePages({
        capabilities: snapshot,
        expression: "",
        limit: 100,
        loadPage: vi.fn(),
        onBatch: vi.fn(),
      }),
    ).rejects.toThrow("有界快照");
    await expect(
      streamSourcePages({
        capabilities,
        expression: "",
        limit: 2,
        loadPage: async ({ offset }) => ({
          offset,
          page_size: 2,
          has_more: true,
          capabilities,
          collection: { features: [] },
        }),
        onBatch: vi.fn(),
      }),
    ).rejects.toThrow("空批次");
  });
});
