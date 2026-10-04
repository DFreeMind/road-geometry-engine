/** 设施符号显示倍率，不参与设施真实几何或工程计算。 */
export const FACILITY_DISPLAY_SCALE_MIN = 0.75;
export const FACILITY_DISPLAY_SCALE_MAX = 3;
export const FACILITY_DISPLAY_SCALE_DEFAULT = 1.3;

/** 将持久化或界面输入的倍率限制在可用范围。 */
export function clampFacilityDisplayScale(value: number): number {
  if (!Number.isFinite(value)) return FACILITY_DISPLAY_SCALE_DEFAULT;
  return Math.min(
    FACILITY_DISPLAY_SCALE_MAX,
    Math.max(FACILITY_DISPLAY_SCALE_MIN, value),
  );
}

/**
 * 根据地图缩放级别和用户倍率计算图标大小。
 * 低于 7 级时隐藏图片符号，避免远景中大量设施图标互相遮挡。
 */
export function facilityIconSizeExpression(scale: number) {
  const multiplier = clampFacilityDisplayScale(scale);
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    6.99,
    0,
    7,
    0.34 * multiplier,
    10,
    0.58 * multiplier,
    14,
    0.82 * multiplier,
    18,
    1.02 * multiplier,
  ] as const;
}

/** 按缩放级别调整点状设施标记，选中状态保持清晰可见。 */
export function facilityMarkerRadiusExpression(
  scale: number,
  selectedId?: string | null,
) {
  const multiplier = clampFacilityDisplayScale(scale);
  const radiusAt = (zoomFactor: number) => {
    const radius = 4 * multiplier * zoomFactor;
    if (!selectedId) return radius;
    return [
      "case",
      ["==", ["get", "id"], selectedId],
      7 * multiplier * zoomFactor,
      radius,
    ] as const;
  };

  // MapLibre 要求 zoom 只出现在顶层 interpolate/step 的输入位置。
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    5,
    radiusAt(0.72),
    10,
    radiusAt(0.9),
    15,
    radiusAt(1.08),
    19,
    radiusAt(1.22),
  ] as const;
}
