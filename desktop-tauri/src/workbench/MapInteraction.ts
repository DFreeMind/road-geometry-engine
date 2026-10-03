import type { Map } from "maplibre-gl";

/** 桌面容器必须启用原生捏合入口，但网页本身不能随 Ctrl 手势或快捷键改变比例。 */
export function installPageZoomGuard(target: Window) {
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey) event.preventDefault();
  };
  const key = (event: KeyboardEvent) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      ["+", "=", "-", "0"].includes(event.key)
    )
      event.preventDefault();
  };
  // 只阻止浏览器默认行为，不截断传播，地图仍可消费同一个捏合事件。
  target.addEventListener("wheel", wheel, { capture: true, passive: false });
  target.addEventListener("keydown", key, true);
  return () => {
    target.removeEventListener("wheel", wheel, true);
    target.removeEventListener("keydown", key, true);
  };
}

/** 浏览器不提供设备名称，使用像素精度、方向和最近的手势判别，离散滚轮保留原生缩放。 */
export function wheelIntent(
  event: Pick<WheelEvent, "ctrlKey" | "deltaMode" | "deltaX" | "deltaY">,
  recentPan = false,
): "pinch" | "pan" | "zoom" {
  if (event.ctrlKey) return "pinch";
  const discreteWheel =
    Number.isInteger(event.deltaY) &&
    (Math.abs(event.deltaY) % 100 === 0 || Math.abs(event.deltaY) % 120 === 0);
  if (
    event.deltaMode === 0 &&
    (event.deltaX !== 0 ||
      !Number.isInteger(event.deltaY) ||
      (Math.abs(event.deltaY) < 50 && event.deltaY !== 0) ||
      (recentPan && !discreteWheel))
  )
    return "pan";
  return "zoom";
}

export function installMapWheelHandling(map: Map, dragging: () => boolean) {
  let lastPan = -Infinity;
  let frame: number | undefined;
  let pending:
    | {
        intent: "pan" | "pinch";
        x: number;
        y: number;
        clientX: number;
        clientY: number;
      }
    | undefined;
  const canvas = map.getCanvas();
  const clearFrame = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const flush = () => {
    clearFrame();
    const input = pending;
    pending = undefined;
    if (!input || dragging()) return;
    if (input.intent === "pan") {
      map.panBy([input.x, input.y], { duration: 0 });
    } else {
      const bounds = canvas.getBoundingClientRect();
      const around = map.unproject([
        input.clientX - bounds.left,
        input.clientY - bounds.top,
      ]);
      map.zoomTo(
        Math.max(
          map.getMinZoom(),
          Math.min(
            map.getMaxZoom(),
            map.getZoom() - Math.max(-1, Math.min(1, input.y / 100)),
          ),
        ),
        { around, duration: 0 },
      );
    }
  };
  const handle = (event: WheelEvent) => {
    if (event.target !== canvas) return;
    if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY))
      return;
    const intent = wheelIntent(event, performance.now() - lastPan < 250);
    if (intent === "zoom" && !dragging()) {
      flush();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (dragging()) {
      clearFrame();
      pending = undefined;
      return;
    }
    if (intent === "pan") {
      lastPan = performance.now();
    }
    if (pending && pending.intent !== intent) flush();
    // 高频触控板事件合并到下一帧，避免每个事件都重绘及同步工程视图。
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 40
        : event.deltaMode === 2
          ? canvas.clientHeight
          : 1);
    pending = {
      intent: intent as "pan" | "pinch",
      x: (pending?.x ?? 0) + event.deltaX,
      y: (pending?.y ?? 0) + delta,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (frame === undefined) frame = requestAnimationFrame(flush);
  };
  map
    .getContainer()
    .addEventListener("wheel", handle, { capture: true, passive: false });
  return () => {
    clearFrame();
    pending = undefined;
    map.getContainer().removeEventListener("wheel", handle, true);
  };
}
