import { transformPosition, utmCrsForWgs84, type Position } from "../domain";

export function prepareRouteEdit(coordinates: Position[], targetCrs: string) {
  if (coordinates.length < 2) throw new Error("路线须包含至少两个控制点。");
  // 注册内置 UTM 定义；仅转换当前部件，不把整个工程传入 Worker。
  utmCrsForWgs84(coordinates[Math.floor(coordinates.length / 2)]);
  return coordinates.map((point) => {
    if (point.length < 2 || !point.slice(0, 2).every(Number.isFinite))
      throw new Error("路线含无效坐标，请修正来源数据。");
    return transformPosition(point, "EPSG:4326", targetCrs);
  });
}

const scope = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<{ coordinates: Position[]; crs: string }>) => void)
    | null;
  postMessage: (message: { points?: Position[]; error?: string }) => void;
};
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ points: prepareRouteEdit(data.coordinates, data.crs) });
  } catch (error) {
    scope.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
