import type { OutputDisplayChunk, OutputDisplayLayer } from "./mapDisplay";

const keys = [
  "component",
  "side",
  "lane_index",
  "marking_class",
  "line_width_m",
  "left_lane_count",
  "right_lane_count",
  "lane_count",
  "lane_label",
  "lane_width_m",
  "source_dataset_id",
  "source_feature_key",
  "part_index",
  "route_id",
];

function coordinateWeight(
  geometry: GeoJSON.Geometry | null,
  limit: number,
): number {
  if (!geometry) return 0;
  if (geometry.type === "GeometryCollection") {
    let count = 0;
    for (const item of geometry.geometries) {
      count += coordinateWeight(item, limit - count);
      if (count >= limit) break;
    }
    return count;
  }
  const visit = (value: unknown): number => {
    if (!Array.isArray(value) || value.length === 0) return 0;
    if (typeof value[0] === "number") return 1;
    let count = 0;
    for (const child of value) {
      count += visit(child);
      if (count >= limit) break;
    }
    return count;
  };
  return visit(geometry.coordinates);
}

/** 逐块发送显示几何和少量绘图属性；不复制来源属性表，不截断单个生产要素。 */
export function* outputDisplayChunks(
  layers: OutputDisplayLayer[],
): Generator<OutputDisplayChunk> {
  for (const [layerIndex, layer] of layers.entries()) {
    let featureStart = 0;
    while (featureStart < layer.collection.features.length) {
      const features: GeoJSON.Feature[] = [];
      let coordinates = 0;
      const start = featureStart;
      while (
        featureStart < layer.collection.features.length &&
        features.length < 128 &&
        coordinates < 25000
      ) {
        const feature = layer.collection.features[featureStart++];
        coordinates += coordinateWeight(feature.geometry, 25000);
        const properties: Record<string, unknown> = {};
        for (const key of keys)
          if (feature.properties && key in feature.properties)
            properties[key] = feature.properties[key];
        features.push({
          type: "Feature",
          ...(feature.id === undefined ? {} : { id: feature.id }),
          geometry: feature.geometry,
          properties,
        });
      }
      yield {
        layer_index: layerIndex,
        feature_start: start,
        layer: {
          name: layer.name,
          crs: layer.crs,
          collection: { type: "FeatureCollection", features },
        },
      };
    }
  }
}
