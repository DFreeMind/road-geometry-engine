import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_BASEMAP_PRESETS,
  BASEMAP_PRESETS,
  BASEMAP_GROUPS,
  createPresetConfig,
  createWmsBasemap,
  createXyzBasemap,
  gcj02ToWgs84,
  validateTileServiceUrl,
  wgs84ToGcj02,
} from "../src/workbench/basemaps";

describe("底图目录与服务配置", () => {
  it("按用途展示十一个常用预设并把影像排在前面", () => {
    expect(BASEMAP_PRESETS.map(({ id }) => id)).toEqual([
      "amap-satellite",
      "esri-public",
      "usgs-imagery",
      "swisstopo-swissimage",
      "basemap-at-orthofoto",
      "ign-ortho",
      "cuzk-orthophoto",
      "amap-street",
      "osm",
      "openfreemap-liberty",
      "opentopomap",
    ]);
    expect(BASEMAP_GROUPS).toEqual([
      "卫星与航空影像",
      "街道与路网",
      "地形参考",
    ]);
    expect(createPresetConfig("amap-street").adapt).toBe("gcj02");
    expect(createPresetConfig("esri-public").displayCrs).toBe("WGS84");
    expect(createPresetConfig("amap-satellite").group).toBe("卫星与航空影像");
    expect(createPresetConfig("opentopomap").group).toBe("地形参考");
    expect(createPresetConfig("swisstopo-swissimage").url).toContain(
      "/3857/{z}/{x}/{y}.jpeg",
    );
    expect(createPresetConfig("basemap-at-orthofoto").url).toContain(
      "/google3857/{z}/{y}/{x}.jpeg",
    );
    expect(createPresetConfig("cuzk-orthophoto").sourceType).toBe("wms");
    expect(createPresetConfig("cuzk-orthophoto").url).toContain(
      "BBOX={bbox-epsg-3857}",
    );
  });

  it("为每个常用预设提供简短统一的用途与来源元数据", () => {
    for (const id of [
      "amap-satellite",
      "esri-public",
      "usgs-imagery",
      "swisstopo-swissimage",
      "basemap-at-orthofoto",
      "ign-ortho",
      "cuzk-orthophoto",
      "amap-street",
      "osm",
      "openfreemap-liberty",
      "opentopomap",
    ]) {
      const config = createPresetConfig(id);
      const preset = BASEMAP_PRESETS.find((item) => item.id === id);
      expect(preset?.coverage).toBeTruthy();
      expect(preset?.updateInfo).toBeTruthy();
      expect(preset?.detail).toBeTruthy();
      expect(config.attribution).toBeTruthy();
      expect(preset?.note).toBeTruthy();
    }

    const openFreeMap = createPresetConfig("openfreemap-liberty");
    expect(openFreeMap.sourceType).toBe("style");
    expect(openFreeMap.styleUrl).toBe(
      "https://tiles.openfreemap.org/styles/liberty",
    );
    expect(createPresetConfig("opentopomap").sourceType).toBe("xyz");
  });

  it("将需要授权的 ArcGIS 令牌来源与常用目录分开但保留转换能力", () => {
    expect(BASEMAP_PRESETS.some((item) => item.id === "esri-token")).toBe(
      false,
    );
    expect(AUTHENTICATED_BASEMAP_PRESETS.map(({ id }) => id)).toEqual([
      "esri-token",
    ]);
    expect(AUTHENTICATED_BASEMAP_PRESETS[0].group).toBe("卫星与航空影像");
    expect(() => createPresetConfig("esri-token")).toThrow(/令牌/);
    expect(createPresetConfig("esri-token", "abc.DEF-123_~").url).toContain(
      "token=abc.DEF-123_~",
    );
    expect(() => createPresetConfig("esri-token", "token=abc")).toThrow(/令牌/);
  });

  it("不再提供不适合道路判读或与常用来源重复的预设", () => {
    for (const id of [
      "nasa-gibs",
      "nasa-viirs",
      "osmfr-hot",
      "osmfr",
      "esri-clarity",
      "esri-hillshade",
    ]) {
      expect(() => createPresetConfig(id)).toThrow(/找不到/);
    }
  });

  it("要求 XYZ 模板及 HTTPS，HTTP 只允许本机回环", () => {
    expect(
      validateTileServiceUrl("https://tiles.example/{z}/{x}/{y}.png", "xyz"),
    ).toBeNull();
    expect(
      validateTileServiceUrl("http://localhost:8080/{z}/{x}/{y}.png", "xyz"),
    ).toBeNull();
    expect(
      validateTileServiceUrl("http://192.168.1.2/{z}/{x}/{y}.png", "xyz"),
    ).toMatch(/HTTPS/);
    expect(() =>
      createXyzBasemap({
        label: "图",
        url: "https://tiles.example/{x}/{y}.png",
        attribution: "© A",
      }),
    ).toThrow(/必须包含/);
    expect(() =>
      createXyzBasemap({
        label: "图",
        url: "https://tiles.example/{z}/{x}/{y}.png",
        attribution: "",
      }),
    ).toThrow(/署名/);
  });

  it("为 WMS 生成 EPSG:3857 bbox 模板并拒绝不安全地址", () => {
    const config = createWmsBasemap({
      label: "影像 WMS",
      endpoint: "https://maps.example/wms?map=roads",
      layers: "imagery",
      attribution: "© Provider",
    });
    expect(config.sourceType).toBe("wms");
    expect(config.url).toContain("SRS=EPSG%3A3857");
    expect(config.url).toContain("BBOX={bbox-epsg-3857}");
    expect(config.url).toContain("map=roads&");
    expect(() =>
      createWmsBasemap({
        label: "WMS",
        endpoint: "http://maps.example/wms",
        layers: "x",
        attribution: "© X",
      }),
    ).toThrow(/HTTPS/);
  });
});

describe("GCJ-02 显示纠偏坐标", () => {
  it("已知中国范围内位置往返误差小于十万分之一度", () => {
    const wgs84: [number, number] = [116.397, 39.908];
    const gcj = wgs84ToGcj02(...wgs84);
    const roundTrip = gcj02ToWgs84(...gcj);
    expect(gcj[0]).not.toBe(wgs84[0]);
    expect(Math.abs(roundTrip[0] - wgs84[0])).toBeLessThan(1e-5);
    expect(Math.abs(roundTrip[1] - wgs84[1])).toBeLessThan(1e-5);
  });

  it("中国范围外坐标保持不变", () => {
    const point: [number, number] = [-122.4194, 37.7749];
    expect(wgs84ToGcj02(...point)).toEqual(point);
    expect(gcj02ToWgs84(...point)).toEqual(point);
  });
});
