import { describe, expect, it } from "vitest";
import { prepareRouteEdit } from "./routeEditWorker";

describe("编辑部件离线程转换", () => {
  it("保留全部点及重复点，不修改源坐标", () => {
    const points: [number, number][] = [
      [116, 40],
      [116, 40],
      [116.001, 40],
    ];
    const result = prepareRouteEdit(points, "EPSG:32650");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(result[1]);
    expect(points[0]).toEqual([116, 40]);
    expect(result[2][0]).toBeGreaterThan(result[0][0]);
  });
  it("明确报告非有限坐标", () => {
    expect(() =>
      prepareRouteEdit(
        [
          [116, 40],
          [NaN, 40],
        ],
        "EPSG:32650",
      ),
    ).toThrow();
  });
});
