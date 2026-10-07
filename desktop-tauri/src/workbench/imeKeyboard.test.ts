import { describe, expect, it } from "vitest";
import { isImeComposing } from "./imeKeyboard";

describe("输入法组合键识别", () => {
  it("识别标准组合输入状态", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("兼容组合输入期间的旧式 229 键码", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("允许正常按键继续处理", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
