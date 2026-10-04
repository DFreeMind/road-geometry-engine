import { describe, expect, it } from "vitest";
import {
  appendDataset,
  findSourceFeatureIndex,
  normalizeSourceDataset,
} from "./sourceBatch";

describe("source dataset normalization memory behavior", () => {
  it("复用同一原始几何数组的规范化键列表", () => {
    const features = [
      {
        type: "Feature" as const,
        properties: { name: "A" },
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [116, 40],
            [116.01, 40],
          ],
        },
      },
    ];
    const layer = {
      id: "source",
      kind: "route-source" as const,
      collection: { type: "FeatureCollection" as const, features },
    };

    const first = normalizeSourceDataset(layer);
    const second = normalizeSourceDataset(layer);

    expect(second.feature_keys).toBe(first.feature_keys);
    expect(second.collection.features).toBe(features);
  });

  it("规范化时保留不可变覆盖记录引用", () => {
    const positions: [number, number][] = [
      [116, 40],
      [116.01, 40],
    ];
    const overrides = {
      route: {
        parts: { "0": positions },
      },
    };
    const dataset = normalizeSourceDataset({
      id: "source",
      kind: "route-source" as const,
      route_overrides: overrides,
    });

    expect(dataset.route_overrides).toBe(overrides);
  });
});

describe("appendDataset", () => {
  it("仍精确去重相同要素并保留异内容", () => {
    const feature = {
      type: "Feature" as const,
      id: "fid-1",
      properties: { name: "主路" },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [116, 40],
          [116.01, 40],
        ],
      },
    };
    const existing = normalizeSourceDataset({
      id: "source",
      kind: "route-source",
      source_label: "数据源",
      collection: { type: "FeatureCollection", features: [feature] },
    });

    const appended = appendDataset(
      existing,
      [feature, { ...feature, properties: { name: "支路" } }],
      "数据源",
      [],
      null,
      {},
      () => "new-source",
    );

    expect(appended.collection.features).toHaveLength(2);
    expect(appended.collection.features[1].properties?.name).toBe("支路");
  });
});

describe("source feature lookup", () => {
  it("uses the requested stable key without serializing the feature set", () => {
    const dataset = normalizeSourceDataset({
      id: "source",
      kind: "route-source" as const,
      collection: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature" as const,
            properties: { name: "first" },
            geometry: {
              type: "LineString" as const,
              coordinates: [
                [1, 2],
                [3, 4],
              ],
            },
          },
          {
            type: "Feature" as const,
            properties: { name: "second" },
            geometry: {
              type: "LineString" as const,
              coordinates: [
                [5, 6],
                [7, 8],
              ],
            },
          },
        ],
      },
      feature_keys: ["first-key", "second-key"],
    });

    expect(
      findSourceFeatureIndex(dataset, {} as GeoJSON.Feature, "second-key"),
    ).toBe(1);
    expect(
      findSourceFeatureIndex(dataset, {} as GeoJSON.Feature, "missing"),
    ).toBe(-1);
  });

  it("uses reference first and restricts structural fallback by id and fingerprint", () => {
    const first = {
      type: "Feature" as const,
      id: "duplicate-id",
      properties: { name: "first" },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
    };
    const second = {
      type: "Feature" as const,
      id: "duplicate-id",
      properties: { name: "second" },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [5, 6],
          [7, 8],
        ],
      },
    };
    const dataset = normalizeSourceDataset({
      id: "source",
      kind: "route-source" as const,
      collection: { type: "FeatureCollection", features: [first, second] },
    });

    expect(findSourceFeatureIndex(dataset, second)).toBe(1);
    expect(findSourceFeatureIndex(dataset, structuredClone(second))).toBe(1);
    expect(
      findSourceFeatureIndex(dataset, {
        ...structuredClone(second),
        properties: { name: "different" },
      }),
    ).toBe(-1);
  });
});
