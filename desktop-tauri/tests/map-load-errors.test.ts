import { describe, expect, it } from "vitest";
import {
  formatOnlineBasemapLoadError,
  isStaleOnlineBasemapLoadError,
  sanitizeMapLoadErrorReason,
} from "../src/workbench/MapLoadErrors";
import type { BasemapConfig } from "../src/workbench/basemaps";

const esri: BasemapConfig = {
  id: "esri-public",
  label: "Esri 全球影像",
  url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "© Esri",
  maxZoom: 19,
  displayCrs: "WGS84",
  sourceType: "xyz",
};

describe("在线底图加载错误提示", () => {
  it("说明已确认的 HTTP 403 拒绝并带底图名称", () => {
    expect(
      formatOnlineBasemapLoadError(
        {
          sourceId: "user-xyz",
          url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/2173/14443",
          error: { status: 403 },
        },
        esri,
      ),
    ).toContain("Esri 全球影像”加载失败：服务方拒绝访问（HTTP 403）");
  });

  it("对 status 0 不臆断为 HTTP 拒绝或 403", () => {
    const message = formatOnlineBasemapLoadError(
      { sourceId: "user-xyz", error: { status: 0 } },
      esri,
    );
    expect(message).toContain("浏览器未能读取 HTTP 响应（status 0）");
    expect(message).toContain("服务方访问限制");
    expect(message).not.toContain("403");
  });

  it("非底图来源继续由原地图错误提示处理", () => {
    expect(
      formatOnlineBasemapLoadError({ sourceId: "road-raster-hana" }, esri),
    ).toBeNull();
    expect(
      formatOnlineBasemapLoadError(
        { sourceId: "user-xyz" },
        { ...esri, sourceType: "style" },
      ),
    ).toBeNull();
  });

  it("不会把旧底图 URL 的迟到错误归到当前底图", () => {
    const event = {
      sourceId: "user-xyz",
      url: "https://old.example/tiles/15/2173/14443.png",
      error: { status: 403 },
    };
    expect(formatOnlineBasemapLoadError(event, esri)).toBeNull();
    expect(isStaleOnlineBasemapLoadError(event, esri)).toBe(true);
    expect(isStaleOnlineBasemapLoadError(event, null)).toBe(true);
  });

  it("通用地图错误原因移除原始 URL 和查询参数", () => {
    expect(
      sanitizeMapLoadErrorReason(
        "请求失败 https://tiles.example/a/15/1/2?token=secret-value",
      ),
    ).toBe("请求失败 [地址已隐藏]");
  });

  it("不把带令牌的瓦片 URL 或查询参数写入状态提示", () => {
    const secretConfig = {
      ...esri,
      url: "https://tiles.example/imagery/{z}/{x}/{y}.png?token=secret-value",
    };
    const message = formatOnlineBasemapLoadError(
      {
        sourceId: "user-xyz",
        url: "https://tiles.example/imagery/15/14443/2173.png?token=secret-value",
        error: { status: 403 },
      },
      secretConfig,
    );
    expect(message).toContain("服务方拒绝访问（HTTP 403）");
    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("tiles.example");
  });
});
