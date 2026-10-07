import { addProtocol } from "maplibre-gl";

export type BasemapConfig = {
  id: string;
  label: string;
  url: string;
  attribution: string;
  maxZoom: number;
  displayCrs: "WGS84" | "GCJ-02";
  adapt?: "gcj02";
  sourceType?: "xyz" | "wms" | "style";
  styleUrl?: string;
  group?: string;
  coverage?: string;
  updateInfo?: string;
  detail?: string;
};

type Preset = BasemapConfig & { note: string; docs: string };

const esriAttribution =
  "© Esri, Vantor, Earthstar Geographics, GIS User Community";

export const BASEMAP_PRESETS: Preset[] = [
  {
    id: "amap-street",
    label: "高德街道",
    url: "gcj://amap-street/{z}/{x}/{y}",
    attribution: '<a href="https://lbs.amap.com/">© 高德地图</a>',
    maxZoom: 18,
    displayCrs: "GCJ-02",
    adapt: "gcj02",
    sourceType: "xyz",
    group: "中国地图",
    note: "高德街道瓦片使用 GCJ-02，显示时按网格近似纠偏到 WGS84；只请求地图当前需要的瓦片。",
    docs: "https://lbs.amap.com/api/javascript-api-v2/guide/abc/basetype",
  },
  {
    id: "amap-satellite",
    label: "高德卫星",
    url: "gcj://amap-satellite/{z}/{x}/{y}",
    attribution: '<a href="https://lbs.amap.com/">© 高德地图</a>',
    maxZoom: 18,
    displayCrs: "GCJ-02",
    adapt: "gcj02",
    sourceType: "xyz",
    group: "中国地图",
    note: "高德卫星瓦片使用 GCJ-02，显示时按网格近似纠偏到 WGS84；只请求地图当前需要的瓦片。",
    docs: "https://lbs.amap.com/api/javascript-api-v2/guide/layers/official-layers",
  },
  {
    id: "esri-public",
    label: "Esri 卫星 · 公开浏览",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: esriAttribution,
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "Esri",
    note: "公开 ArcGIS 瓦片服务，按 Esri 和数据提供者条款浏览；服务可用性与覆盖范围无保证。",
    docs: "https://developers.arcgis.com/rest/basemap-styles/service-data/",
  },
  {
    id: "esri-clarity",
    label: "Esri 卫星 · Clarity",
    url: "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "© Esri, Vantor, Earthstar Geographics, IGN, GIS User Community",
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "Esri",
    note: "Esri Clarity 影像公开浏览入口；按服务条款使用，不提供批量下载。",
    docs: "https://developers.arcgis.com/rest/basemap-styles/service-data/",
  },
  {
    id: "esri-hillshade",
    label: "Esri 地形晕渲",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
    attribution: "© Esri · World Hillshade / 数据提供者",
    maxZoom: 16,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "Esri",
    note: "Esri World Hillshade 公开浏览瓦片；按服务条款使用。",
    docs: "https://developers.arcgis.com/rest/services-reference/enterprise/map-service/",
  },
  {
    id: "esri-token",
    label: "Esri 卫星 · 令牌",
    url: "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={token}",
    attribution: esriAttribution,
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "Esri",
    note: "粘贴具有 World Imagery 访问权限的 ArcGIS 令牌。令牌只存在本次界面会话内，不写入项目或本地存储。",
    docs: "https://developers.arcgis.com/rest/basemap-styles/service-data/",
  },
  {
    id: "usgs-imagery",
    label: "USGS 正射影像 · 美国",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    attribution:
      '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">U.S. Geological Survey, The National Map</a>',
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "开放影像",
    coverage:
      "美国；不同地区与缩放级别使用不同影像来源，非全境均有同等高分辨率。",
    updateInfo:
      "服务元数据显示影像数据于 2024-06 刷新；具体区域的航摄日期各异。",
    detail:
      "高分辨率正射影像适合美国道路位置与周边环境目视检查；不可替代测量控制或现场核验。",
    note: "The National Map 影像瓦片公开且免费；美国本土常见 NAIP 正射影像约 1m，城市局部有更高分辨率影像。美国之外覆盖或细节可能不同。",
    docs: "https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map",
  },
  {
    id: "ign-ortho",
    label: "IGN 正射影像 · 法国",
    url: "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
    attribution:
      '<a href="https://geoservices.ign.fr/bd-ortho">© IGN – BD ORTHO</a>',
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "开放影像",
    coverage: "法国本土及部分海外领土；具体影像覆盖随区域而变。",
    updateInfo:
      "BD ORTHO 分区更新；官方产品说明的采集影像平均约 3 年、最长约 5 年，单个瓦片的拍摄年份未知。",
    detail:
      "航空正射影像，适合道路和地物目视核对；实际分辨率与拍摄年代依区域而变。",
    note: "IGN Géoplateforme 正射影像 WMTS，无需令牌；BD ORTHO 产品使用 Etalab 开放许可并需保留署名。瓦片服务可用性不保证。",
    docs: "https://geoservices.ign.fr/sites/default/files/2022-10/IGNF_BDORTHOr_2-0.html",
  },
  {
    id: "osmfr-hot",
    label: "OSM France · 人道主义街道",
    url: "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    attribution:
      'Données © <a href="https://osm.org/copyright">OpenStreetMap</a> / ODbL · rendu <a href="https://hot.openstreetmap.org/">Humanitarian OpenStreetMap Team</a>',
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "全球与开放数据",
    coverage: "全球 OpenStreetMap 数据覆盖区。",
    updateInfo:
      "底层数据库约每 5 分钟更新；低 zoom 的缓存瓦片每周更新，高 zoom 瓦片按请求或更新需求生成。",
    detail:
      "街道地图强调道路与人道救援相关 POI；适合道路网络背景核对，不是正射影像或测量底图。",
    note: "OSM France 提供的 HOT 街道样式，需在地图上清晰显示 OSM 与 HOT 署名；遵守服务使用条件，避免批量请求。",
    docs: "https://wiki.openstreetmap.org/wiki/FR:Serveurs/tile.openstreetmap.fr",
  },
  {
    id: "osmfr",
    label: "OSM France · 法语街道",
    url: "https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
    attribution:
      'Données © <a href="https://osm.org/copyright">OpenStreetMap</a> / ODbL · rendu <a href="https://openstreetmap.fr/">OSM France</a>',
    maxZoom: 20,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "全球与开放数据",
    coverage: "全球 OpenStreetMap 数据覆盖区；样式与地名主要面向法语使用者。",
    updateInfo:
      "底层数据库约每 5 分钟更新；zoom 0–12 缓存瓦片每周更新，高 zoom 瓦片按请求或更新需求生成。",
    detail:
      "突出道路与法语地名的街道地图，可放大到 zoom 20；不是正射影像或测量底图。",
    note: "OSM France 法语街道样式；需在地图上清晰显示 OSM 与 OSM France 署名，并遵守服务使用条件。",
    docs: "https://wiki.openstreetmap.org/wiki/FR:Serveurs/tile.openstreetmap.fr",
  },
  {
    id: "opentopomap",
    label: "OpenTopoMap · 地形",
    url: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution:
      'Kartendaten: © <a href="https://osm.org/copyright">OpenStreetMap-Mitwirkende</a>, SRTM | Kartendarstellung: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxZoom: 17,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "全球与开放数据",
    coverage: "全球 OpenStreetMap 与 SRTM 数据覆盖区。",
    updateInfo: "官方说明数据总体为最新；部分地图区域可能最多滞后约 4 周。",
    detail:
      "地形渲染突出等高线、阴影和道路等级；适合地形与道路网络背景查看，不是正射影像。",
    note: "OpenTopoMap 栅格瓦片公开可用；地图需显示 OpenStreetMap、SRTM 和 OpenTopoMap 署名。CC BY-SA 要求保持相同方式共享；服务不保证可用，避免大量下载。",
    docs: "https://dev.opentopomap.org/about",
  },
  {
    id: "openfreemap-liberty",
    label: "OpenFreeMap · Liberty 矢量",
    url: "https://tiles.openfreemap.org/styles/liberty",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    attribution:
      '© <a href="https://openfreemap.org/">OpenFreeMap</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://osm.org/copyright">OpenStreetMap contributors</a>',
    maxZoom: 14,
    displayCrs: "WGS84",
    sourceType: "style",
    group: "全球与开放数据",
    coverage: "全球 OpenStreetMap 数据覆盖区。",
    updateInfo: "OpenFreeMap 每周发布全星球矢量数据。",
    detail:
      "MapLibre style JSON 加载的矢量街道图；瓦片源 zoom 0–14，显示道路、地名和地物，不是影像或测量底图。",
    note: "OpenFreeMap 官方 MapLibre 样式，无令牌、免注册；样式会加载其公开矢量瓦片、字体与 sprite 资源，使用 MapLibre AttributionControl 保留自动署名。服务无 SLA。",
    docs: "https://openfreemap.org/quick_start/",
  },
  {
    id: "nasa-gibs",
    label: "NASA 卫星 · MODIS 真彩色",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
    attribution:
      '<a href="https://www.earthdata.nasa.gov/data/tools/gibs">NASA GIBS / MODIS Terra</a>',
    maxZoom: 9,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "全球与开放数据",
    note: "NASA GIBS MODIS Terra 真彩色，最高 250m 级别；日期默认为两天前，可能有云或缺测。",
    docs: "https://nasa-gibs.github.io/gibs-api-docs/access-basics/",
  },
  {
    id: "nasa-viirs",
    label: "NASA 卫星 · VIIRS 真彩色",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
    attribution:
      '<a href="https://www.earthdata.nasa.gov/data/tools/gibs">NASA GIBS / VIIRS Suomi NPP</a>',
    maxZoom: 9,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "全球与开放数据",
    coverage: "全球。",
    updateInfo:
      "按日提供；默认请求两天前的影像，云、夜间或缺测区域仍可能空白。",
    detail:
      "VIIRS 真彩色约 750m 级别，只适合大范围地表概览；不适合识别道路边界或车道。",
    note: "NASA GIBS VIIRS Suomi NPP 每日真彩色浏览影像，最高 zoom 9；按数据日查看，不代表当天实况。",
    docs: "https://nasa-gibs.github.io/gibs-api-docs/access-basics/",
  },
  {
    id: "osm",
    label: "OpenStreetMap 街道",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "全球与开放数据",
    note: "遵循 OSM 瓦片政策并保留可见署名；服务用于当前视口交互浏览，禁止预取或离线批量下载。",
    docs: "https://operations.osmfoundation.org/policies/tiles/",
  },
];

export const BASEMAP_GROUPS = [
  "中国地图",
  "Esri",
  "开放影像",
  "全球与开放数据",
];

export type BasemapProtocolRequest = {
  url: string;
  signal: AbortSignal;
};

const AMAP_URLS: Record<string, string> = {
  "amap-street":
    "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  "amap-satellite":
    "https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
};
let gcjProtocolsRegistered = false;

function inChina(lng: number, lat: number) {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLatitude(x: number, y: number) {
  let value =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  value +=
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value +=
    ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  value +=
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) *
      2) /
    3;
  return value;
}

function transformLongitude(x: number, y: number) {
  let value =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value +=
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  value +=
    ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  value +=
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) *
      2) /
    3;
  return value;
}

/** 将 WGS84 经纬度近似转换为高德使用的 GCJ-02 经纬度。 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (!inChina(lng, lat)) return [lng, lat];
  const radians = (lat / 180) * Math.PI;
  let magic = Math.sin(radians);
  magic = 1 - 0.00669342162296594323 * magic * magic;
  const rootMagic = Math.sqrt(magic);
  const dLat =
    (transformLatitude(lng - 105, lat - 35) * 180) /
    (((6378245 * (1 - 0.00669342162296594323)) / (magic * rootMagic)) *
      Math.PI);
  const dLng =
    (transformLongitude(lng - 105, lat - 35) * 180) /
    ((6378245 / rootMagic) * Math.cos(radians) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/** 用迭代反算 WGS84，误差足以用于屏幕影像叠加，不改动项目坐标。 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (!inChina(lng, lat)) return [lng, lat];
  let guessLng = lng;
  let guessLat = lat;
  for (let i = 0; i < 8; i++) {
    const [convertedLng, convertedLat] = wgs84ToGcj02(guessLng, guessLat);
    guessLng -= convertedLng - lng;
    guessLat -= convertedLat - lat;
  }
  return [guessLng, guessLat];
}

function tilePixel(lng: number, lat: number, zoom: number): [number, number] {
  const scale = 256 * 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = ((lng + 180) / 360) * scale;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function pixelLonLat(x: number, y: number, zoom: number): [number, number] {
  const scale = 256 * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return [lng, lat];
}

async function loadAmapTile(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, mode: "cors" });
  if (!response.ok) throw new Error(`底图瓦片请求失败（${response.status}）`);
  const bitmap = await createImageBitmap(await response.blob());
  if (signal.aborted) {
    bitmap.close();
    throw new DOMException("The operation was aborted", "AbortError");
  }
  return bitmap;
}

async function warpGcjTile(
  serviceId: string,
  zoom: number,
  tileX: number,
  tileY: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (zoom < 0 || zoom > 22) throw new Error("不支持该缩放级别");
  const tileCount = 2 ** zoom;
  const corners: Array<[number, number]> = [];
  for (let i = 0; i <= 16; i++) {
    const edge = (i / 16) * 256;
    for (const [px, py] of [
      [edge, 0],
      [edge, 256],
      [0, edge],
      [256, edge],
    ]) {
      const [lng, lat] = pixelLonLat(tileX * 256 + px, tileY * 256 + py, zoom);
      corners.push(tilePixel(...wgs84ToGcj02(lng, lat), zoom));
    }
  }
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const minTileX = Math.floor(Math.min(...xs) / 256);
  const maxTileX = Math.floor((Math.max(...xs) - 1e-7) / 256);
  const minTileY = Math.max(0, Math.floor(Math.min(...ys) / 256));
  const maxTileY = Math.min(
    tileCount - 1,
    Math.floor((Math.max(...ys) - 1e-7) / 256),
  );
  const xTiles = maxTileX - minTileX + 1;
  const yTiles = maxTileY - minTileY + 1;
  if (xTiles < 1 || yTiles < 1 || xTiles * yTiles > 64) {
    throw new Error("坐标纠偏瓦片范围超出单次请求上限");
  }

  const urlTemplate = AMAP_URLS[serviceId];
  if (!urlTemplate) throw new Error("未知的高德底图类型");
  const mosaic = document.createElement("canvas");
  mosaic.width = xTiles * 256;
  mosaic.height = yTiles * 256;
  const mosaicContext = mosaic.getContext("2d", { willReadFrequently: true });
  if (!mosaicContext) throw new Error("无法创建底图纠偏画布");
  try {
    for (let sourceY = minTileY; sourceY <= maxTileY; sourceY++) {
      for (let sourceX = minTileX; sourceX <= maxTileX; sourceX++) {
        if (signal.aborted)
          throw new DOMException("The operation was aborted", "AbortError");
        const wrappedX = ((sourceX % tileCount) + tileCount) % tileCount;
        const url = urlTemplate
          .replace("{z}", String(zoom))
          .replace("{x}", String(wrappedX))
          .replace("{y}", String(sourceY));
        const bitmap = await loadAmapTile(url, signal);
        try {
          mosaicContext.drawImage(
            bitmap,
            (sourceX - minTileX) * 256,
            (sourceY - minTileY) * 256,
            256,
            256,
          );
        } finally {
          bitmap.close();
        }
      }
    }

    const sourceImage = mosaicContext.getImageData(
      0,
      0,
      mosaic.width,
      mosaic.height,
    );
    const output = document.createElement("canvas");
    output.width = 256;
    output.height = 256;
    const outputContext = output.getContext("2d", { willReadFrequently: true });
    if (!outputContext) throw new Error("无法创建底图纠偏画布");
    const outputImage = outputContext.createImageData(256, 256);
    const source = sourceImage.data;
    const target = outputImage.data;
    const gridSize = 16;
    const mapped: Array<[number, number]> = [];
    for (let gy = 0; gy <= gridSize; gy++) {
      for (let gx = 0; gx <= gridSize; gx++) {
        const [lng, lat] = pixelLonLat(
          tileX * 256 + (gx / gridSize) * 256,
          tileY * 256 + (gy / gridSize) * 256,
          zoom,
        );
        mapped.push(tilePixel(...wgs84ToGcj02(lng, lat), zoom));
      }
    }
    for (let y = 0; y < 256; y++) {
      const gridY = Math.floor(y / (256 / gridSize));
      const fy = (y % (256 / gridSize)) / (256 / gridSize);
      for (let x = 0; x < 256; x++) {
        const gridX = Math.floor(x / (256 / gridSize));
        const fx = (x % (256 / gridSize)) / (256 / gridSize);
        const topLeft = mapped[gridY * (gridSize + 1) + gridX];
        const topRight = mapped[gridY * (gridSize + 1) + gridX + 1];
        const bottomLeft = mapped[(gridY + 1) * (gridSize + 1) + gridX];
        const bottomRight = mapped[(gridY + 1) * (gridSize + 1) + gridX + 1];
        const sourceX =
          topLeft[0] * (1 - fx) * (1 - fy) +
          topRight[0] * fx * (1 - fy) +
          bottomLeft[0] * (1 - fx) * fy +
          bottomRight[0] * fx * fy -
          minTileX * 256;
        const sourceY =
          topLeft[1] * (1 - fx) * (1 - fy) +
          topRight[1] * fx * (1 - fy) +
          bottomLeft[1] * (1 - fx) * fy +
          bottomRight[1] * fx * fy -
          minTileY * 256;
        const sx = Math.floor(sourceX);
        const sy = Math.floor(sourceY);
        if (sx < 0 || sy < 0 || sx >= mosaic.width || sy >= mosaic.height)
          continue;
        const sourceOffset = (sy * mosaic.width + sx) * 4;
        const targetOffset = (y * 256 + x) * 4;
        target[targetOffset] = source[sourceOffset];
        target[targetOffset + 1] = source[sourceOffset + 1];
        target[targetOffset + 2] = source[sourceOffset + 2];
        target[targetOffset + 3] = source[sourceOffset + 3];
      }
    }
    outputContext.putImageData(outputImage, 0, 0);
    if (signal.aborted)
      throw new DOMException("The operation was aborted", "AbortError");
    const blob = await new Promise<Blob>((resolve, reject) =>
      output.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("底图纠偏图像编码失败")),
        "image/png",
      ),
    );
    return await blob.arrayBuffer();
  } finally {
    mosaic.width = 0;
    mosaic.height = 0;
  }
}

/** 在创建 MapLibre 地图前注册高德瓦片的显示坐标纠偏协议。 */
export function registerBasemapProtocols() {
  if (gcjProtocolsRegistered) return;
  addProtocol("gcj", async (params, abortController) => {
    const match = params.url.match(/^gcj:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) throw new Error("无效的高德瓦片地址");
    const [, serviceId, z, x, y] = match;
    const data = await warpGcjTile(
      serviceId,
      Number(z),
      Number(x),
      Number(y),
      abortController.signal,
    );
    return { data };
  });
  gcjProtocolsRegistered = true;
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

export function validateTileServiceUrl(input: string, kind: "xyz" | "wms") {
  const value = input.trim();
  if (!value) return "请输入服务地址。";
  if (/\{(?!z\}|x\}|y\}|bbox-epsg-3857\})[^}]+\}/i.test(value)) {
    return "地址包含不支持的模板变量。";
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "请输入完整的服务 URL。";
  }
  if (parsed.username || parsed.password)
    return "请勿在 URL 中嵌入账号或密码。";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback(parsed.hostname))
  ) {
    return "仅支持 HTTPS 地址；HTTP 仅允许 localhost、127.0.0.1 或 ::1。";
  }
  if (
    kind === "xyz" &&
    !["{z}", "{x}", "{y}"].every((token) => value.includes(token))
  ) {
    return "XYZ 地址必须包含 {z}、{x} 和 {y}。";
  }
  if (kind === "wms" && !/\{bbox-epsg-3857\}/i.test(value)) {
    return "WMS 地址必须包含 {bbox-epsg-3857}，并使用 EPSG:3857。";
  }
  return null;
}

function validateServiceEndpoint(input: string) {
  const value = input.trim();
  if (!value) return "请输入服务地址。";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "请输入完整的服务 URL。";
  }
  if (parsed.username || parsed.password)
    return "请勿在 URL 中嵌入账号或密码。";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback(parsed.hostname))
  ) {
    return "仅支持 HTTPS 地址；HTTP 仅允许 localhost、127.0.0.1 或 ::1。";
  }
  return null;
}

export function createXyzBasemap(input: {
  id?: string;
  label: string;
  url: string;
  attribution: string;
  maxZoom?: number;
}): BasemapConfig {
  const error = validateTileServiceUrl(input.url, "xyz");
  if (error) throw new Error(error);
  validateCommon(input.label, input.attribution, input.maxZoom ?? 19);
  return {
    id: input.id ?? "custom-xyz",
    label: input.label.trim(),
    url: input.url.trim(),
    attribution: input.attribution.trim(),
    maxZoom: input.maxZoom ?? 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
  };
}

export function createWmsBasemap(input: {
  id?: string;
  label: string;
  endpoint: string;
  layers: string;
  attribution: string;
  maxZoom?: number;
}): BasemapConfig {
  const endpoint = input.endpoint.trim();
  const error = validateServiceEndpoint(endpoint);
  if (error) throw new Error(error);
  if (/[{}]/.test(endpoint))
    throw new Error("WMS 服务地址请填写 GetMap 端点，不要带瓦片模板变量。");
  if (!input.layers.trim()) throw new Error("请填写至少一个 WMS 图层名。 ");
  validateCommon(input.label, input.attribution, input.maxZoom ?? 19);
  const separator = endpoint.includes("?") ? "&" : "?";
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.1.1",
    REQUEST: "GetMap",
    LAYERS: input.layers.trim(),
    STYLES: "",
    FORMAT: "image/png",
    TRANSPARENT: "true",
    SRS: "EPSG:3857",
    WIDTH: "256",
    HEIGHT: "256",
  });
  const url = `${endpoint}${separator}${params.toString()}&BBOX={bbox-epsg-3857}`;
  return {
    id: input.id ?? "custom-wms",
    label: input.label.trim(),
    url,
    attribution: input.attribution.trim(),
    maxZoom: input.maxZoom ?? 19,
    displayCrs: "WGS84",
    sourceType: "wms",
  };
}

function validateCommon(label: string, attribution: string, maxZoom: number) {
  if (!label.trim()) throw new Error("请填写底图名称。 ");
  if (!attribution.trim()) throw new Error("请填写服务署名。 ");
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 22) {
    throw new Error("最大缩放级别须为 0 到 22 的整数。 ");
  }
}

export function createPresetConfig(id: string, token = ""): BasemapConfig {
  const preset = BASEMAP_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error("找不到所选底图。");
  let url = preset.url;
  let label = preset.label;
  if (id === "esri-token") {
    const cleanToken = token.trim();
    if (
      !cleanToken ||
      cleanToken.length > 8192 ||
      !/^[A-Za-z0-9._~-]+$/.test(cleanToken)
    ) {
      throw new Error("请粘贴完整的 URL 安全 ArcGIS 访问令牌。");
    }
    url = url.replace("{token}", encodeURIComponent(cleanToken));
  }
  if (id === "nasa-gibs" || id === "nasa-viirs") {
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    url = url.replace("{date}", date);
    label = `${label} · ${date}`;
  }
  return { ...preset, url, label };
}
