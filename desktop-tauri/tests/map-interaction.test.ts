import { describe, expect, it } from "vitest";
import { wheelIntent } from "../src/workbench/MapInteraction";

describe("地图设备滚动意图", () => {
  it("捏合优先于滚动幅度和方向", () => {
    expect(
      wheelIntent({ ctrlKey: true, deltaMode: 0, deltaX: 0, deltaY: 120 }),
    ).toBe("pinch");
  });
  it("精细像素滚动和横向滚动用于平移", () => {
    for (const [deltaX, deltaY] of [
      [0, 2.5],
      [18, 120],
      [0, -12],
    ]) {
      expect(
        wheelIntent({ ctrlKey: false, deltaMode: 0, deltaX, deltaY }),
      ).toBe("pan");
    }
  });
  it("普通离散滚轮及行单位滚动保留原生缩放", () => {
    for (const [deltaMode, deltaY] of [
      [0, 120],
      [0, -100],
      [1, 3],
    ]) {
      expect(
        wheelIntent({ ctrlKey: false, deltaMode, deltaX: 0, deltaY }),
      ).toBe("zoom");
    }
  });
});
