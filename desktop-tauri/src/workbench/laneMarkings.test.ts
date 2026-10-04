import { expect, it } from "vitest";
import { laneMarkingLayers } from "./laneMarkings";
it("车道分隔线与边缘线分层表达，不为所有线套用虚线", () => {
  const layers = laneMarkingLayers("road");
  expect(layers[1].paint?.["line-dasharray"]).toEqual([3, 2]);
  expect(layers[0].paint?.["line-dasharray"]).toBeUndefined();
  expect(layers[1].filter).toContainEqual(["==", "marking_class", "lane"]);
  expect(layers.map((layer) => layer.source)).toEqual(["road", "road"]);
});
