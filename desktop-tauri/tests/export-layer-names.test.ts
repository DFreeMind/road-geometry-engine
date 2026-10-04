import { expect, it } from "vitest";
import { exportLayerNames } from "../src/workbench/exportLayerNames";

it("导出图层名称去除路径字符、按 UTF-8 字节限长并区分重名", () => {
  const names = exportLayerNames([
    "C:\\路线/测试",
    "道路".repeat(100),
    "道路".repeat(100),
    "lane",
    "LANE",
    "",
  ]);
  expect(names[0]).toBe("C:_路线_测试");
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(
    names.length,
  );
  expect(
    names.every(
      (name) =>
        new TextEncoder().encode(name).length <= 128 &&
        !/[\\/\u0000]/.test(name),
    ),
  ).toBe(true);
});
