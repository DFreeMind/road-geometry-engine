import { describe, expect, it } from "vitest";
import { prepareOutputDisplay } from "./mapDisplay";
import {
  createMapDisplayChunkProcessor,
  processMapDisplayWorkerMessage,
} from "./mapDisplayWorker";

describe("map display worker chunks", () => {
  it("保持跨块的源图层与要素索引，并只返回显示属性", () => {
    const processChunk = createMapDisplayChunkProcessor();
    const chunk = processChunk({
      kind: "chunk",
      revision: 7,
      layer_index: 2,
      feature_start: 128,
      layer: {
        name: "车道",
        crs: "EPSG:4326",
        collection: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {
                component: "lane",
                source_feature_key: "route-129",
                large_unused_property:
                  "输入块允许携带额外属性，显示副本不会保留它",
              },
              geometry: {
                type: "LineString",
                coordinates: [
                  [116, 40],
                  [116.01, 40],
                ],
              },
            },
          ],
        },
      },
    });

    expect(chunk.kind).toBe("chunk");
    if (!("value" in chunk)) throw new Error("期望分块响应");
    expect(chunk.revision).toBe(7);
    expect(chunk.value.collection.features[0].properties).toMatchObject({
      component: "lane",
      source_feature_key: "route-129",
      __output_layer: 2,
      __output_feature: 128,
    });
    expect(chunk.value.collection.features[0].properties).not.toHaveProperty(
      "large_unused_property",
    );
  });

  it("分块投影结果与整层处理相同，且保留旧版整层接口", () => {
    const layer = {
      name: "车道",
      crs: "EPSG:4326",
      collection: {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            properties: { lane_index: 1 },
            geometry: {
              type: "LineString" as const,
              coordinates: [
                [116, 40],
                [116.01, 40],
              ],
            },
          },
          {
            type: "Feature" as const,
            properties: { lane_index: 2 },
            geometry: {
              type: "LineString" as const,
              coordinates: [
                [116.02, 40],
                [116.03, 40],
              ],
            },
          },
        ],
      },
    };
    const expected = prepareOutputDisplay([layer]);
    const processChunk = createMapDisplayChunkProcessor();
    const first = processChunk({
      kind: "chunk",
      revision: 1,
      layer_index: 0,
      feature_start: 0,
      layer: {
        ...layer,
        collection: {
          ...layer.collection,
          features: [layer.collection.features[0]],
        },
      },
    });
    const second = processChunk({
      kind: "chunk",
      revision: 1,
      layer_index: 0,
      feature_start: 1,
      layer: {
        ...layer,
        collection: {
          ...layer.collection,
          features: [layer.collection.features[1]],
        },
      },
    });

    expect(
      processMapDisplayWorkerMessage({ revision: 1, layers: [layer] }).revision,
    ).toBe(1);
    if (!("value" in first) || !("value" in second))
      throw new Error("期望分块响应");
    expect([
      ...first.value.collection.features,
      ...second.value.collection.features,
    ]).toEqual(expected.collection.features);
    expect(
      first.value.metrics.coordinate_count +
        second.value.metrics.coordinate_count,
    ).toBe(expected.metrics.coordinate_count);
  });
});
