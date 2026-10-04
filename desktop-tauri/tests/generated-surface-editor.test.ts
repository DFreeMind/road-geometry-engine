import { describe, expect, it } from "vitest";
import {
  validateGeneratedSurfaceDraft,
  type GeneratedSurfaceDraft,
} from "../src/workbench/GeneratedSurfaceEditor";

function draft(
  overrides: Partial<GeneratedSurfaceDraft> = {},
): GeneratedSurfaceDraft {
  return {
    left_lanes: "3.5, 3.5",
    right_lanes: "3.5, 3.5",
    median_width: "0",
    left_emergency_width: "0",
    right_emergency_width: "0",
    left_shoulder_width: "0",
    right_shoulder_width: "0",
    left_slope_width: "0",
    right_slope_width: "0",
    ...overrides,
  };
}

describe("生成面宽度表单校验", () => {
  it("拒绝非有限车道宽度和负的辅助宽度", () => {
    const invalidLane = validateGeneratedSurfaceDraft(
      draft({ left_lanes: "3.5, Infinity" }),
    );
    expect(invalidLane.section).toBeUndefined();
    expect(invalidLane.errors).toContain("左车道 2请输入有限数值。");

    const negativeWidth = validateGeneratedSurfaceDraft(
      draft({ right_shoulder_width: "-0.1" }),
    );
    expect(negativeWidth.section).toBeUndefined();
    expect(negativeWidth.errors).toContain("右路肩不能小于 0。");
  });

  it("允许左右车道都为空，但要求其他组成提供非零总宽度", () => {
    const valid = validateGeneratedSurfaceDraft(
      draft({ left_lanes: "", right_lanes: "", median_width: "1.2" }),
    );
    expect(valid.errors).toEqual([]);
    expect(valid.section).toMatchObject({
      left_lanes: [],
      right_lanes: [],
      median_width: 1.2,
    });

    const zeroWidth = validateGeneratedSurfaceDraft(
      draft({ left_lanes: "", right_lanes: "" }),
    );
    expect(zeroWidth.section).toBeUndefined();
    expect(zeroWidth.errors).toContain(
      "横断面总宽度必须大于 0。至少填写一项非零宽度。",
    );
  });

  it("保留左右不对称的车道及附属宽度", () => {
    const result = validateGeneratedSurfaceDraft(
      draft({
        left_lanes: "3.1, 3.2",
        right_lanes: "3.8",
        median_width: "1.4",
        left_emergency_width: "0.6",
        right_emergency_width: "0.9",
        left_shoulder_width: "1.1",
        right_shoulder_width: "1.7",
        left_slope_width: "2.2",
        right_slope_width: "3.3",
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.section).toMatchObject({
      left_lanes: [3.1, 3.2],
      right_lanes: [3.8],
      median_width: 1.4,
      left_emergency_width: 0.6,
      right_emergency_width: 0.9,
      left_shoulder_width: 1.1,
      right_shoulder_width: 1.7,
      left_slope_width: 2.2,
      right_slope_width: 3.3,
    });
  });
});
