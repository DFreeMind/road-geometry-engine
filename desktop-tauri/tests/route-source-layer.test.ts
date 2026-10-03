import { describe, expect, it } from "vitest";
import { routeSourceCollection } from "../src/workbench/routeSourceLayer";
import type { RouteFeature } from "../src/workbench/RouteFeatureSelector";
describe("选中路线源图层", () => {
  it("完整保留多部件、字段和原始坐标，并计算选中集合范围", () => {
    const features: RouteFeature[] = [
      {
        type: "Feature",
        id: "R1",
        properties: { code: "业务值" },
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [116, 39],
              [117, 40],
            ],
            [
              [118, 41],
              [119, 42],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { code: "R2" },
        geometry: {
          type: "LineString",
          coordinates: [
            [115, 38],
            [116, 39],
          ],
        },
      },
    ];
    const result = routeSourceCollection(features);
    expect(result.bounds).toEqual([115, 38, 119, 42]);
    expect(result.collection.features).toEqual(features);
    expect(result.collection.features[0]).toBe(features[0]);
    expect(features[0].properties).toEqual({ code: "业务值" });
  });
  it("拒绝投影坐标被误当 WGS84 及空集合", () => {
    expect(() => routeSourceCollection([])).toThrow(/选择/);
    expect(() =>
      routeSourceCollection([
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [448000, 4420000],
              [448100, 4420050],
            ],
          },
        },
      ]),
    ).toThrow(/WGS84/);
  });
});
