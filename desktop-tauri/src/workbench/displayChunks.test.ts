import { expect, it } from "vitest";
import { outputDisplayChunks } from "./displayChunks";

it("显示传输分块保留完整几何、全局索引，剔除大来源属性", () => {
  const geometry = {
    type: "LineString" as const,
    coordinates: Array.from({ length: 26000 }, (_, i) => [i, 0]),
  };
  const features = Array.from({ length: 260 }, (_, i) => ({
    type: "Feature" as const,
    id: i,
    geometry:
      i === 0 ? geometry : { type: "Point" as const, coordinates: [i, 0] },
    properties: {
      component: "lane",
      source_attributes: { huge: "do not copy" },
    },
  }));
  const chunks = [
    ...outputDisplayChunks([
      {
        name: "road",
        crs: "EPSG:32650",
        collection: { type: "FeatureCollection", features },
      },
    ]),
  ];
  expect(chunks.map((c) => c.feature_start)).toEqual([0, 1, 129, 257]);
  expect(chunks.flatMap((c) => c.layer.collection.features)).toHaveLength(260);
  expect(chunks[0].layer.collection.features[0].geometry).toBe(geometry);
  expect(chunks[0].layer.collection.features[0].properties).toEqual({
    component: "lane",
  });
});
