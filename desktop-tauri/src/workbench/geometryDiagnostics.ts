/** 仅诊断用：流式遍历坐标返回数量和校验值，不序列化或复制完整工程。 */
export function geometryDiagnostics(collections: GeoJSON.FeatureCollection[]) {
  let count = 0;
  let hash = 2166136261;
  const storage = new DataView(new ArrayBuffer(8));
  const visit = (value: unknown) => {
    if (!Array.isArray(value) || !value.length) return;
    if (typeof value[0] === "number") {
      count++;
      for (const number of value) {
        storage.setFloat64(0, number);
        hash = Math.imul(hash ^ storage.getUint32(0), 16777619) >>> 0;
        hash = Math.imul(hash ^ storage.getUint32(4), 16777619) >>> 0;
      }
    } else for (const child of value) visit(child);
  };
  const geometry = (item: GeoJSON.Geometry | null) => {
    if (!item) return;
    if (item.type === "GeometryCollection")
      for (const child of item.geometries) geometry(child);
    else visit(item.coordinates);
  };
  let featureCount = 0;
  for (const collection of collections) {
    featureCount += collection.features.length;
    for (const feature of collection.features) geometry(feature.geometry);
  }
  return {
    feature_count: featureCount,
    coordinate_count: count,
    checksum: hash.toString(16),
  };
}

export function responseGeometryCollections(
  response: unknown,
): GeoJSON.FeatureCollection[] {
  if (!response || typeof response !== "object") return [];
  const value = response as Record<string, any>;
  const layers = value.layers ?? value.outputs?.layers;
  const collections = Array.isArray(layers)
    ? layers
        .map(
          (layer) =>
            layer.collection ?? layer.geojson ?? layer.feature_collection,
        )
        .filter((collection) => collection?.type === "FeatureCollection")
    : value.feature_collection?.type === "FeatureCollection"
      ? [value.feature_collection]
      : value.type === "FeatureCollection"
        ? [value]
        : [];
  return [
    ...collections,
    ...(value.ancillary_layers ?? [])
      .map((layer: any) => layer.collection)
      .filter((collection: any) => collection?.type === "FeatureCollection"),
  ];
}
