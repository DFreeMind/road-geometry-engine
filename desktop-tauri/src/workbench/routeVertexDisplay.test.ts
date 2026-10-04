import { describe, expect, it } from "vitest";
import { routeVertexDisplay } from "./routeVertexDisplay";

describe("控制点视口显示", () => {
  it("大量近邻点去拥挤但保留原索引、选中点与最后点", () => {
    const coordinates = Array.from({ length: 50000 }, (_, i) => [
      116 + i / 1e8,
      40,
    ]);
    const result = routeVertexDisplay(
      coordinates,
      [115, 39, 117, 41],
      { width: 800, height: 600 },
      42000,
    );
    expect(result.features.length).toBeLessThan(10);
    expect(result.features.map((f) => f.id)).toContain(42000);
    expect(result.features.map((f) => f.id)).toContain(49999);
    expect(coordinates).toHaveLength(50000);
  });
  it("只显示视口内的点，跨日期线仍保留正确索引", () => {
    const result = routeVertexDisplay(
      [
        [179, 0],
        [-179, 0],
        [1, 0],
      ],
      [178, -1, 182, 1],
      { width: 800, height: 600 },
      null,
    );
    expect(result.features.map((f) => f.id)).toEqual([0, 1]);
  });
});
