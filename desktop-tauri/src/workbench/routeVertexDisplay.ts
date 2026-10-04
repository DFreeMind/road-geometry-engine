/** 仅显示视口内去拥挤的控制点；索引始终指向完整路线，放大可继续编辑其余点。 */
export function routeVertexDisplay(
  coordinates: GeoJSON.Position[],
  bounds: [number, number, number, number],
  size: { width: number; height: number },
  selected: number | null,
): GeoJSON.FeatureCollection {
  const [west, south, east, north] = bounds;
  const columns = Math.max(1, Math.ceil(size.width / 24));
  const rows = Math.max(1, Math.ceil(size.height / 24));
  const occupied = new Set<number>();
  const features: GeoJSON.Feature[] = [];
  const span = east - west;
  for (let index = 0; index < coordinates.length; index++) {
    const point = coordinates[index];
    const longitude =
      point[0] + 360 * Math.round(((west + east) / 2 - point[0]) / 360);
    if (
      longitude < west ||
      longitude > east ||
      point[1] < south ||
      point[1] > north
    )
      continue;
    const cell =
      Math.min(
        columns - 1,
        Math.floor(((longitude - west) / Math.max(span, 1e-10)) * columns),
      ) +
      columns *
        Math.min(
          rows - 1,
          Math.floor(
            ((point[1] - south) / Math.max(north - south, 1e-10)) * rows,
          ),
        );
    if (
      occupied.has(cell) &&
      index !== selected &&
      index !== coordinates.length - 1
    )
      continue;
    occupied.add(cell);
    features.push({
      type: "Feature",
      id: index,
      properties: { index, current: index === coordinates.length - 1 },
      geometry: { type: "Point", coordinates: point },
    });
  }
  return { type: "FeatureCollection", features };
}
