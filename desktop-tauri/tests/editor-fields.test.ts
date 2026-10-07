import { describe, expect, it } from "vitest";
import {
  beginNumericDraftTransaction,
  editNumericDraftTransaction,
  formatNumericDraft,
  parseNumericDraft,
  parseStructuredDraft,
  resolveNumericDraftTransaction,
  updateSpecificationValue,
} from "../src/workbench/EditorFields";
import {
  setEditorFieldValidity,
  unregisterEditorField,
} from "../src/workbench/EditorValidation";

describe("编辑器字段值转换", () => {
  it("数字草稿支持显式空值，并拒绝必填空值", () => {
    expect(parseNumericDraft("   ", { nullable: true })).toEqual({
      ok: true,
      value: null,
    });
    expect(parseNumericDraft("", { nullable: false })).toEqual({
      ok: false,
      error: "此项不能为空",
    });
  });

  it("只接受有限数字并执行已配置范围", () => {
    expect(parseNumericDraft("Infinity")).toMatchObject({ ok: false });
    expect(parseNumericDraft("1.2x")).toMatchObject({ ok: false });
    expect(parseNumericDraft("-0.1", { min: 0 })).toMatchObject({
      ok: false,
      error: "数值不能小于 0",
    });
    expect(parseNumericDraft("10.1", { max: 10 })).toMatchObject({
      ok: false,
      error: "数值不能大于 10",
    });
    expect(parseNumericDraft("3.14159", { min: 0, max: 4 })).toEqual({
      ok: true,
      value: 3.14159,
    });
  });

  it("提交前跟踪实时无效草稿，并在修复后清除字段状态", () => {
    const invalidDraft = "-";
    const invalid = !parseNumericDraft(invalidDraft, { min: 0 }).ok;
    const afterInvalid = setEditorFieldValidity(new Set(), "width", invalid);
    expect(afterInvalid.has("width")).toBe(true);

    const repairedDraft = "0";
    const repaired = !parseNumericDraft(repairedDraft, { min: 0 }).ok;
    const afterRepair = setEditorFieldValidity(afterInvalid, "width", repaired);
    expect(afterRepair.has("width")).toBe(false);
    expect(afterInvalid.has("width")).toBe(true);
  });

  it("移除无效字段时保留其他仍挂载字段的状态", () => {
    const invalidFields = setEditorFieldValidity(
      setEditorFieldValidity(new Set(), "width", true),
      "slope",
      true,
    );
    const remaining = unregisterEditorField(invalidFields, "width");
    expect([...remaining]).toEqual(["slope"]);
  });

  it("显示格式不改变源值，并仅通过用户草稿产生数值", () => {
    const exactValue = 1.23456;
    expect(formatNumericDraft(exactValue, 3)).toBe("1.235");
    expect(exactValue).toBe(1.23456);
    expect(parseNumericDraft("1.23456")).toEqual({
      ok: true,
      value: 1.23456,
    });
  });

  it("未编辑的高精度坐标失焦不提交，聚焦草稿保留完整值", () => {
    const original = 448249.901927754;
    const transaction = beginNumericDraftTransaction(original);
    expect(transaction.draft).toBe("448249.901927754");
    expect(
      resolveNumericDraftTransaction(transaction, original, {
        nullable: false,
      }),
    ).toMatchObject({ status: "unchanged" });
  });

  it("合法修改生成一次提交意图，重复 Enter/blur 不会重复提交", () => {
    const original = 448249.901927754;
    const edited = editNumericDraftTransaction(
      beginNumericDraftTransaction(original),
      "448250.25",
    );
    const first = resolveNumericDraftTransaction(edited, original, {
      nullable: false,
    });
    expect(first).toMatchObject({ status: "commit", value: 448250.25 });
    if (first.status !== "commit") throw new Error("应产生一次提交意图");
    expect(
      resolveNumericDraftTransaction(first.transaction, first.value, {
        nullable: false,
      }),
    ).toMatchObject({ status: "unchanged" });
  });

  it("写入编码字段时保留前导零和字符串类型", () => {
    const current = { sign_code: "0012", panel_width_m: null };
    const next = updateSpecificationValue(current, "sign_code", "0007");
    expect(next.sign_code).toBe("0007");
    expect(typeof next.sign_code).toBe("string");
    expect(current.sign_code).toBe("0012");
  });

  it("结构化字段校验 JSON 语法及数组/对象类型", () => {
    expect(parseStructuredDraft('[{"id":"001"}]', "array")).toEqual({
      ok: true,
      value: [{ id: "001" }],
    });
    expect(parseStructuredDraft('{"enabled":true}', "object")).toEqual({
      ok: true,
      value: { enabled: true },
    });
    expect(parseStructuredDraft("{bad json", "object")).toMatchObject({
      ok: false,
    });
    expect(parseStructuredDraft("[]", "object")).toMatchObject({ ok: false });
    expect(parseStructuredDraft("{}", "array")).toMatchObject({ ok: false });
  });
});
