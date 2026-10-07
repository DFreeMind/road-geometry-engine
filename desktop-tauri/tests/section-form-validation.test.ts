import { describe, expect, it } from "vitest";
import { defaultProject } from "../src/domain";
import { sectionFormIssue } from "../src/workbench/sectionFormValidation";

describe("横断面生成前的表单校验", () => {
  it("应急带和边坡允许为零，正常左右不对称断面可生成", () => {
    const section = {
      ...defaultProject().section,
      left_lanes: [3.2],
      right_emergency_width: 0,
    };
    expect(sectionFormIssue(section)).toBeNull();
  });
  it("各字段均合法时仍阻止零车道和总宽度超限", () => {
    expect(
      sectionFormIssue({
        ...defaultProject().section,
        left_lanes: [],
        right_lanes: [],
      }),
    ).toContain("至少");
    expect(
      sectionFormIssue({ ...defaultProject().section, median_width: 200 }),
    ).toContain("总水平投影宽度");
  });
  it("拒绝无效工程参数，不把空值与非有限值解释为零", () => {
    expect(
      sectionFormIssue({ ...defaultProject().section, left_lanes: [0] }),
    ).toContain("车道宽度");
    expect(
      sectionFormIssue({
        ...defaultProject().section,
        right_shoulder_width: NaN,
      }),
    ).toContain("空值");
  });
});
