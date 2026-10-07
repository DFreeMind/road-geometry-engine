import type { RouteSection } from "../domain";

export const MAX_SECTION_WIDTH_M = 200;
export const MAX_SECTION_LANES = 8;

/** 只校验表单范围；几何有效性仍由唯一 Rust 引擎负责。 */
export function sectionFormIssue(section: RouteSection): string | null {
  const lanes = [...section.left_lanes, ...section.right_lanes];
  if (!lanes.length) return "至少需要设置一条车道。";
  if (
    section.left_lanes.length > MAX_SECTION_LANES ||
    section.right_lanes.length > MAX_SECTION_LANES
  )
    return `每侧车道数不得超过 ${MAX_SECTION_LANES} 条。`;
  if (lanes.some((width) => !Number.isFinite(width) || width < 0.1))
    return "车道宽度不得小于 0.1 m。";
  const extra = [
    section.median_width,
    section.left_emergency_width,
    section.right_emergency_width,
    section.left_shoulder_width,
    section.right_shoulder_width,
    section.left_slope_width,
    section.right_slope_width,
  ];
  if (extra.some((width) => !Number.isFinite(width) || width < 0))
    return "隔离带、应急带、路肩和边坡投影宽度不能为负值或空值。";
  if (
    [...lanes, ...extra].reduce((sum, width) => sum + width, 0) >
    MAX_SECTION_WIDTH_M
  )
    return `总水平投影宽度不得超过 ${MAX_SECTION_WIDTH_M} m。`;
  return null;
}
