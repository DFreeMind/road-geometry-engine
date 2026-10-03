import { describe, expect, it } from "vitest";
import type { Feature, LineString } from "geojson";
import {
  filterRouteFeatures,
  routeFeaturePage,
  type RouteFeature,
} from "../src/workbench/RouteFeatureSelector";

function routeFeature(properties: Record<string, unknown>): RouteFeature {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  } as Feature<LineString>;
}

describe("路线要素选择器数据处理", () => {
  it("可按任意字段和值筛选，并保留要素索引", () => {
    const features = [
      routeFeature({ name: "北环线", metadata: { class: "高速" } }),
      routeFeature({ name: "南环线", metadata: { class: "城市快速路" } }),
    ];

    expect(filterRouteFeatures(features, "name", "南环")).toEqual([1]);
    expect(filterRouteFeatures(features, "metadata", "高速")).toEqual([0]);
    expect(filterRouteFeatures(features, "*", "城市快速路")).toEqual([1]);
  });

  it("1989 条要素按页取值，不会生成整层渲染列表", () => {
    const indexes = Array.from({ length: 1989 }, (_, index) => index);

    expect(routeFeaturePage(indexes, 0, 50)).toHaveLength(50);
    expect(routeFeaturePage(indexes, 0, 50)[0]).toBe(0);
    expect(routeFeaturePage(indexes, 39, 50)).toHaveLength(39);
    expect(routeFeaturePage(indexes, 39, 50).at(-1)).toBe(1988);
  });
});
