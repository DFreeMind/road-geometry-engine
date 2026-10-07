export interface RoadExample {
  id: string;
  title: string;
  category: string;
  description: string;
  dataUrl: string;
  sourceUrl: string;
  attribution: string;
  crs: string;
  /** 未提供断面模板；加载时沿用工程默认模板，需人工核验道路属性。 */
  sectionTemplate?: unknown;
}

/**
 * 可离线加载的真实道路参考线。GeoJSON 来自 OSM way 几何，不代表测量中心线；
 * 道路宽度及断面组成不由这些参考线推定，工程断面模板需人工核实。
 */
export const roadExamples: RoadExample[] = [
  {
    id: "west-changan-street",
    title: "西长安街 · 城市主干道",
    category: "城市主干道",
    description:
      "北京西长安街 OSM 单向 trunk way。载入独立示例工程并使用演示断面；道路宽度和车道组成待核验。",
    dataUrl: "/real-route.geojson",
    sourceUrl: "https://api.openstreetmap.org/api/0.6/way/175598144/full",
    attribution: "© OpenStreetMap contributors · ODbL 1.0",
    crs: "EPSG:4326 (WGS 84)",
  },
  {
    id: "hana-highway",
    title: "Hana Highway · 弯曲山路",
    category: "弯曲山路",
    description:
      "夏威夷 HI-360 的 Hana Highway OSM 路段（way 456494873，228 个坐标点）。OSM 道路绘制线不是测量中心线；断面宽度沿用工程默认模板，推定待核验。",
    dataUrl: "/examples/hana-highway.geojson",
    sourceUrl: "https://api.openstreetmap.org/api/0.6/way/456494873/full.json",
    attribution: "© OpenStreetMap contributors · ODbL 1.0",
    crs: "EPSG:4326 (WGS 84)",
  },
  {
    id: "treasure-island-ramp",
    title: "海湾大桥 · Treasure Island 匝道",
    category: "高速匝道",
    description:
      "旧金山海湾大桥 OSM motorway_link（way 322962944，39 个坐标点，junction:ref=4）。OSM 未提供 name 标签，文件展示名依据 destination 和 junction:ref 组合。断面宽度沿用工程默认模板，推定待核验。",
    dataUrl: "/examples/treasure-island-ramp.geojson",
    sourceUrl: "https://api.openstreetmap.org/api/0.6/way/322962944/full.json",
    attribution: "© OpenStreetMap contributors · ODbL 1.0",
    crs: "EPSG:4326 (WGS 84)",
  },
];
