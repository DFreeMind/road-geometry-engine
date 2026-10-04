import { useEffect, useState, type RefObject } from "react";
import type { Map, MapMouseEvent } from "maplibre-gl";
import { transformPosition, type Position } from "../domain";

// 坐标状态只更新这个小组件，避免鼠标移动触发整个工作台与大属性表重渲染。
export function MapCoordinateReadout({
  mapRef,
  crs,
  mode,
}: {
  mapRef: RefObject<Map | null>;
  crs: string;
  mode: "geographic" | "project";
}) {
  const [cursor, setCursor] = useState<Position | null>(null);
  useEffect(() => {
    let map: Map | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let lastUpdate = 0;
    const onMove = (event: MapMouseEvent) => {
      const now = performance.now();
      if (now - lastUpdate < 100) return;
      lastUpdate = now;
      setCursor([event.lngLat.lng, event.lngLat.lat]);
    };
    const attach = () => {
      map = mapRef.current;
      if (map) map.on("mousemove", onMove);
      else timer = setTimeout(attach, 50);
    };
    attach();
    return () => {
      clearTimeout(timer);
      map?.off("mousemove", onMove);
    };
  }, [mapRef]);
  return (
    <span className="coordinate-value" title={`工程 CRS：${crs}`}>
      {cursor
        ? mode === "geographic"
          ? `${cursor[0].toFixed(6)}°, ${cursor[1].toFixed(6)}°`
          : `${transformPosition(cursor, "EPSG:4326", crs)
              .map((value) => value.toFixed(2))
              .join(", ")} m`
        : "移动指针查看坐标"}
    </span>
  );
}
