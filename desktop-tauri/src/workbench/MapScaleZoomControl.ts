import { ScaleControl, type IControl, type Map } from "maplibre-gl";

/** 比例尺与连续缩放级别共用一行；Z 不代表地形高程或某个来源实际请求的瓦片级别。 */
export class MapScaleZoomControl implements IControl {
  private map?: Map;
  private container?: HTMLDivElement;
  private label?: HTMLSpanElement;
  private scale = new ScaleControl({ maxWidth: 120, unit: "metric" });

  private updateZoom = () => {
    if (this.map && this.label)
      this.label.textContent = `Z ${this.map.getZoom().toFixed(2)}`;
  };

  onAdd(map: Map) {
    this.map = map;
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl map-scale-zoom";
    this.container.setAttribute("role", "group");
    this.container.setAttribute("aria-label", "地图比例尺与缩放级别");
    this.container.setAttribute("data-testid", "map-scale-zoom");
    this.container.append(this.scale.onAdd(map));
    this.label = document.createElement("span");
    this.label.className = "map-zoom-level";
    this.label.setAttribute("aria-label", "当前地图缩放级别");
    this.label.title =
      "当前地图缩放级别 Z（不是高程）；实际瓦片级别由底图来源决定";
    this.container.append(this.label);
    map.on("zoom", this.updateZoom);
    this.updateZoom();
    return this.container;
  }

  onRemove() {
    this.map?.off("zoom", this.updateZoom);
    this.scale.onRemove();
    this.container?.remove();
    this.map = undefined;
    this.container = undefined;
    this.label = undefined;
  }
}
