import type { Map } from "maplibre-gl";

/** 浏览器不提供设备名称：只接管明确的精细滚动，普通滚轮保留 MapLibre 的平滑缩放。 */
export function wheelIntent(
  event: Pick<WheelEvent, "ctrlKey" | "deltaMode" | "deltaX" | "deltaY">,
): "pinch" | "pan" | "zoom" {
  if (event.ctrlKey) return "pinch";
  if (
    event.deltaMode === 0 &&
    (event.deltaX !== 0 || (Math.abs(event.deltaY) < 50 && event.deltaY !== 0))
  )
    return "pan";
  return "zoom";
}

export function installMapWheelHandling(map: Map, dragging: () => boolean) {
  let lastPan = 0;
  const canvas = map.getCanvas();
  const handle = (event: WheelEvent) => {
    if (event.target !== canvas) return;
    let intent = wheelIntent(event);
    if (
      intent === "zoom" &&
      event.deltaMode === 0 &&
      performance.now() - lastPan < 180
    )
      intent = "pan";
    if (intent === "zoom" && !dragging()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (dragging()) return;
    if (intent === "pan") {
      lastPan = performance.now();
      map.panBy([event.deltaX, event.deltaY], { duration: 0 });
    } else {
      const bounds = canvas.getBoundingClientRect();
      const around = map.unproject([
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      ]);
      const delta = event.deltaY * (event.deltaMode === 1 ? 40 : 1);
      map.zoomTo(map.getZoom() - Math.max(-1, Math.min(1, delta / 100)), {
        around,
        duration: 0,
      });
    }
  };
  map
    .getContainer()
    .addEventListener("wheel", handle, { capture: true, passive: false });
  return () => map.getContainer().removeEventListener("wheel", handle, true);
}
