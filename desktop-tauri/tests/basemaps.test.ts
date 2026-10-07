import { describe, expect, it } from "vitest";
import {
  BASEMAP_PRESETS,
  createPresetConfig,
  createWmsBasemap,
  createXyzBasemap,
  gcj02ToWgs84,
  validateTileServiceUrl,
  wgs84ToGcj02,
} from "../src/workbench/basemaps";

describe("底图目录与服务配置", () => {
  it("恢复旧版所有在线底图并标记高德需要纠偏", () => {
    expect(BASEMAP_PRESETS.map(({ id }) => id)).toEqual([
      "amap-street",
      "amap-satellite",
      "esri-public",
      "esri-clarity",
      "esri-hillshade",
      "esri-token",
      "usgs-imagery",
      "ign-ortho",
      "osmfr-hot",
      "osmfr",
      "opentopomap",
      "openfreemap-liberty",
      "nasa-gibs",
      "nasa-viirs",
      "osm",
    ]);
    expect(createPresetConfig("amap-street").adapt).toBe("gcj02");
    expect(createPresetConfig("esri-public").displayCrs).toBe("WGS84");
  });

  it("为新增公开预设提供区域、更新时间与适用说明", () => {
    for (const id of [
      "usgs-imagery",
      "ign-ortho",
      "osmfr-hot",
      "osmfr",
      "opentopomap",
      "openfreemap-liberty",
      "nasa-viirs",
    ]) {
      const config = createPresetConfig(id);
      const preset = BASEMAP_PRESETS.find((item) => item.id === id);
      expect(preset?.coverage).toBeTruthy();
      expect(preset?.updateInfo).toBeTruthy();
      expect(preset?.detail).toBeTruthy();
      expect(config.url).toMatch(/^https:\/\//);
      expect(config.attribution).toBeTruthy();
    }

    const viirs = createPresetConfig("nasa-viirs");
    expect(viirs.url).not.toContain("{date}");
    expect(viirs.url).toMatch(/\/\d{4}-\d{2}-\d{2}\//);
    expect(viirs.label).toMatch(/· \d{4}-\d{2}-\d{2}$/);
    expect(createPresetConfig("nasa-gibs").url).not.toContain("{date}");

    const openFreeMap = createPresetConfig("openfreemap-liberty");
    expect(openFreeMap.sourceType).toBe("style");
    expect(openFreeMap.styleUrl).toBe(
      "https://tiles.openfreemap.org/styles/liberty",
    );
    expect(createPresetConfig("opentopomap").sourceType).toBe("xyz");
  });

  it("只接受有效 ArcGIS URL 安全令牌并将其编码进会话 URL", () => {
    expect(() => createPresetConfig("esri-token")).toThrow(/令牌/);
    expect(createPresetConfig("esri-token", "abc.DEF-123_~").url).toContain(
      "token=abc.DEF-123_~",
    );
    expect(() => createPresetConfig("esri-token", "token=abc")).toThrow(/令牌/);
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
