import type { LineLayerSpecification } from "maplibre-gl";

/** 标线绘图样式：车道分隔虚线与边缘/中央实线分开，像素表达不替代生产几何宽度。 */
export function laneMarkingLayers(source: string): LineLayerSpecification[] {
  const common = {
    type: "line" as const,
    source,
    minzoom: 15,
    layout: { "line-cap": "butt" as const, "line-join": "round" as const },
  };
  return [
    {
      ...common,
      id: `${source}-markings-solid`,
      filter: [
        "all",
        ["==", "$type", "LineString"],
        ["==", "component", "markings"],
        ["!=", "marking_class", "lane"],
      ],
      paint: {
        "line-color": [
          "match",
          ["get", "marking_class"],
          ["center", "median"],
          "#f4d35e",
          "#f8fafc",
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 20, 2],
      },
    },
    {
      ...common,
      id: `${source}-markings-dashed`,
      filter: [
        "all",
        ["==", "$type", "LineString"],
        ["==", "component", "markings"],
        ["==", "marking_class", "lane"],
      ],
      paint: {
        "line-color": "#f8fafc",
        "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 20, 2],
        "line-dasharray": [3, 2],
      },
    },
  ];
}
