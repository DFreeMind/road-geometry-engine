import type { BasemapConfig } from "./basemaps";

type MapLoadErrorEvent = {
  sourceId?: unknown;
  url?: unknown;
  status?: unknown;
  error?: {
    url?: unknown;
    status?: unknown;
  };
};

function templateMatchesUrl(template: string, url: string) {
  const escaped = template
    .split(/(\{[^{}]+\})/g)
    .map((part) => {
      if (/^\{[^{}]+\}$/.test(part)) {
        const name = part.slice(1, -1);
        if (["z", "x", "y", "TILEMATRIX", "TILEROW", "TILECOL"].includes(name))
          return "[^/?&#]+";
        if (name === "bbox-epsg-3857") return "[^&#]+";
        return "[^&#/]+";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");

  try {
    return new RegExp(`^${escaped}$`, "i").test(url);
  } catch {
    return false;
  }
}

export function formatOnlineBasemapLoadError(
  event: MapLoadErrorEvent,
  current: BasemapConfig | null,
): string | null {
  if (
    !current ||
    current.id === "none" ||
    (current.sourceType !== "xyz" && current.sourceType !== "wms")
  )
    return null;

  const eventUrl =
    typeof event.url === "string"
      ? event.url
      : typeof event.error?.url === "string"
        ? event.error.url
        : null;
  const urlMatches = eventUrl
    ? templateMatchesUrl(current.url, eventUrl)
    : false;

  // 固定来源 ID 会被底图切换复用；事件带 URL 时必须同时匹配当前模板。
  if (eventUrl ? !urlMatches : event.sourceId !== "user-xyz") return null;

  const rawStatus = event.status ?? event.error?.status;
  const status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
  const prefix = `底图“${current.label}”加载失败：`;
  const retry = "可重新选择该底图重试或切换其他底图；道路成果不受影响。";

  if (status === 401)
    return `${prefix}服务方返回 HTTP 401，访问未获授权。${retry}`;
  if (status === 403) return `${prefix}服务方拒绝访问（HTTP 403）。${retry}`;
  if (status === 0)
    return `${prefix}浏览器未能读取 HTTP 响应（status 0），可能与网络连接或服务方访问限制有关。${retry}`;
  if (Number.isInteger(status) && status > 0)
    return `${prefix}服务返回 HTTP ${status}。${retry}`;
  return `${prefix}瓦片请求未能完成，可能与网络连接或服务方访问限制有关。${retry}`;
}

export function isStaleOnlineBasemapLoadError(
  event: MapLoadErrorEvent,
  current: BasemapConfig | null,
) {
  if (event.sourceId !== "user-xyz") return false;
  const eventUrl =
    typeof event.url === "string"
      ? event.url
      : typeof event.error?.url === "string"
        ? event.error.url
        : null;
  if (!eventUrl) return false;
  if (
    !current ||
    current.id === "none" ||
    (current.sourceType !== "xyz" && current.sourceType !== "wms")
  )
    return true;
  return !templateMatchesUrl(current.url, eventUrl);
}

export function sanitizeMapLoadErrorReason(reason: string) {
  return reason.replace(/https?:\/\/[^\s"'<>]+/gi, "[地址已隐藏]");
}
