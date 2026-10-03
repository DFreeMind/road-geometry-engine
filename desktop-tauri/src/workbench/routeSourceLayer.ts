import type { FeatureCollection } from "geojson";
import type { RouteFeature } from "./RouteFeatureSelector";

/** 源路线按 WGS84 保存完整几何与属性；范围仅用于地图定位。 */
export function routeSourceCollection(features: RouteFeature[]): {
  collection: FeatureCollection;
  bounds: [number, number, number, number];
} {
  if (!features.length) throw new Error("请先选择要加载的路线。");
  const bounds: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  for (const feature of features) {
    const lines =
      feature.geometry.type === "LineString"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    for (const line of lines)
      for (const point of line) {
        const [x, y] = point;
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          Math.abs(x) > 180 ||
          Math.abs(y) > 90
        )
          throw new Error("源路线包含无效 WGS84 坐标，未加载到地图。");
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
  }
  if (!bounds.every(Number.isFinite))
    throw new Error("所选路线没有可显示的坐标。");
  return { collection: { type: "FeatureCollection", features }, bounds };
}
