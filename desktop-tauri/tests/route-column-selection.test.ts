import { describe, expect, it } from "vitest";
import { defaultRouteColumnSelection } from "../src/workbench/routeColumnSelection";

describe("路线属性表默认显示字段", () => {
  it("保留数据库中大小写不同的独立字段", () => {
    expect([
      ...defaultRouteColumnSelection([{ name: "Name" }, { name: "name" }]),
    ]).toEqual(["Name", "name"]);
  });
  it("宽表默认最多显示 12 列并优先选中常用路线字段", () => {
    const fields = [
      ...Array.from({ length: 62 }, (_, index) => ({ name: `字段${index}` })),
      ...[
        "gid",
        "route_id",
        "roadcode",
        "roadname",
        "name",
        "roadstart",
        "roadends",
      ].map((name) => ({ name })),
    ];
    const original = fields.map((field) => field.name);

    const selected = defaultRouteColumnSelection(fields);

    expect(fields.map((field) => field.name)).toEqual(original);
    expect(selected.size).toBe(12);
    expect(
      [
        "gid",
        "route_id",
        "roadcode",
        "roadname",
        "name",
        "roadstart",
        "roadends",
      ].every((name) => selected.has(name)),
    ).toBe(true);
    expect([...selected]).toEqual([
      "字段0",
      "字段1",
      "字段2",
      "字段3",
      "字段4",
      "gid",
      "route_id",
      "roadcode",
      "roadname",
      "name",
      "roadstart",
      "roadends",
    ]);
  });

  it("字段不超过 12 列时全部显示，保留旧四字段表头", () => {
    const fields = ["name", "roadcode", "direction", "width"].map((name) => ({
      name,
    }));

    expect([...defaultRouteColumnSelection(fields)]).toEqual([
      "name",
      "roadcode",
      "direction",
      "width",
    ]);
  });

  it("常用数据库字段名大小写不敏感，roadcode 优先于回退列", () => {
    const fields = [
      ...Array.from({ length: 13 }, (_, index) => ({ name: `列${index}` })),
      { name: "RoadCode" },
    ];

    const selected = defaultRouteColumnSelection(fields);

    expect(selected.size).toBe(12);
    expect(selected.has("RoadCode")).toBe(true);
    expect(selected.has("列11")).toBe(false);
  });
});
