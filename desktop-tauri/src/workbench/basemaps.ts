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

export type BasemapPreset = BasemapConfig & { note: string; docs: string };

const esriAttribution =
  "© Esri, Vantor, Earthstar Geographics, GIS User Community";

export const BASEMAP_PRESETS: BasemapPreset[] = [
  {
    id: "amap-satellite",
    label: "高德卫星",
    url: "gcj://amap-satellite/{z}/{x}/{y}",
    attribution: '<a href="https://lbs.amap.com/">© 高德地图</a>',
    maxZoom: 18,
    displayCrs: "GCJ-02",
    adapt: "gcj02",
    sourceType: "xyz",
    group: "卫星与航空影像",
    coverage: "中国为主",
    updateInfo: "拍摄日期随地区变化，服务不标示单瓦片日期",
    detail: "卫星影像，适合查看道路与周边地物",
    note: "卫星影像；使用高德 GCJ-02 瓦片并在显示时近似纠偏。",
    docs: "https://lbs.amap.com/api/javascript-api-v2/guide/layers/official-layers",
  },
  {
    id: "esri-public",
    label: "Esri 全球影像",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: esriAttribution,
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "卫星与航空影像",
    coverage: "全球；分辨率因地区而异",
    updateInfo: "影像日期随地区变化，服务不标示单瓦片日期",
    detail: "多来源卫星与航空影像，适合道路及周边目视核对",
    note: "公开浏览服务；须保留署名并遵守数据提供方条款，影像日期和细节因地区而异。",
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
    group: "卫星与航空影像",
    coverage: "美国；覆盖与分辨率因地区而异",
    updateInfo: "影像日期随地区变化，服务不标示单瓦片日期",
    detail: "正射影像，适合道路与周边环境目视核对",
    note: "公开影像服务；美国之外的覆盖和细节可能不同，不能替代测量或现场核验。",
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
    group: "卫星与航空影像",
    coverage: "法国本土及部分海外领土",
    updateInfo: "分区更新，单瓦片拍摄日期未知",
    detail: "航空正射影像，分辨率和拍摄年代随地区变化",
    note: "公开 WMTS 服务；需保留 IGN 署名并遵守开放许可。",
    docs: "https://geoservices.ign.fr/sites/default/files/2022-10/IGNF_BDORTHOr_2-0.html",
  },
  {
    id: "amap-street",
    label: "高德街道",
    url: "gcj://amap-street/{z}/{x}/{y}",
    attribution: '<a href="https://lbs.amap.com/">© 高德地图</a>',
    maxZoom: 18,
    displayCrs: "GCJ-02",
    adapt: "gcj02",
    sourceType: "xyz",
    group: "街道与路网",
    coverage: "中国为主",
    updateInfo: "地图数据日期随地区和图层变化",
    detail: "道路、地名和地物标注",
    note: "街道地图；使用高德 GCJ-02 瓦片并在显示时近似纠偏。",
    docs: "https://lbs.amap.com/api/javascript-api-v2/guide/abc/basetype",
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
    group: "街道与路网",
    coverage: "全球 OpenStreetMap 数据覆盖区",
    updateInfo: "地图数据持续更新，瓦片按服务策略缓存",
    detail: "道路、地名和地物标注",
    note: "遵循 OSM 瓦片政策并保留可见署名；仅用于当前视口交互浏览。",
    docs: "https://operations.osmfoundation.org/policies/tiles/",
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
    group: "街道与路网",
    coverage: "全球 OpenStreetMap 数据覆盖区",
    updateInfo: "矢量数据按服务发布周期更新",
    detail: "矢量街道图，显示道路、地名和地物",
    note: "公开 MapLibre 样式；使用时保留地图自动署名。",
    docs: "https://openfreemap.org/quick_start/",
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
    group: "地形参考",
    coverage: "全球 OpenStreetMap 与 SRTM 数据覆盖区",
    updateInfo: "地图数据更新时间随数据源变化",
    detail: "等高线与地形渲染，适合地形背景参考",
    note: "地形栅格图；需保留 OSM、SRTM 和 OpenTopoMap 署名并遵守 CC BY-SA。",
    docs: "https://dev.opentopomap.org/about",
  },
];

export const AUTHENTICATED_BASEMAP_PRESETS: BasemapPreset[] = [
  {
    id: "esri-token",
    label: "Esri 全球影像 · 令牌",
    url: "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={token}",
    attribution: esriAttribution,
    maxZoom: 19,
    displayCrs: "WGS84",
    sourceType: "xyz",
    group: "卫星与航空影像",
    coverage: "全球；分辨率因地区而异",
    updateInfo: "影像日期随地区变化，服务不标示单瓦片日期",
    detail: "需要具有 World Imagery 访问权限的 ArcGIS 令牌",
    note: "令牌只存在本次界面会话内，不写入项目或本地存储。",
    docs: "https://developers.arcgis.com/rest/basemap-styles/service-data/",
  },
];

export const BASEMAP_GROUPS = ["卫星与航空影像", "街道与路网", "地形参考"];

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
  const preset = [...BASEMAP_PRESETS, ...AUTHENTICATED_BASEMAP_PRESETS].find(
    (item) => item.id === id,
  );
  if (!preset) throw new Error("找不到所选底图。");
  let url = preset.url;
  const label = preset.label;
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
  return { ...preset, url, label };
}
