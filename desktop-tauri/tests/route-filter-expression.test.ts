import { describe, expect, it } from "vitest";
import { compileRouteFilter } from "../src/workbench/routeFilterExpression";

describe("安全路线 WHERE 子集解析器", () => {
  const fields = [
    "name",
    "width",
    "enabled",
    "nullable",
    "道路 名",
    "O'Reilly",
    "mixed",
  ];

  it("空表达式匹配全部，并支持可选 WHERE 前缀", () => {
    expect(compileRouteFilter("  ", fields)({})).toBe(true);
    expect(compileRouteFilter("WHERE width >= 12", fields)({ width: 12 })).toBe(
      true,
    );
    expect(compileRouteFilter("WHERE width >= 12", fields)({ width: 11 })).toBe(
      false,
    );
  });

  it("支持优先级、NOT、括号和 SQL 字符串转义", () => {
    const matches = compileRouteFilter(
      `name = 'O''Reilly' OR (width > 10 AND NOT enabled = false)`,
      fields,
    );
    expect(matches({ name: "O'Reilly", width: 1, enabled: false })).toBe(true);
    expect(matches({ name: "other", width: 11, enabled: true })).toBe(true);
    expect(matches({ name: "other", width: 11, enabled: false })).toBe(false);
  });

  it("双引号字段名按原样匹配，普通字段名忽略大小写", () => {
    expect(
      compileRouteFilter("\"道路 名\" = '主路'", fields)({ "道路 名": "主路" }),
    ).toBe(true);
    expect(compileRouteFilter("MIXED = 'x'", fields)({ mixed: "x" })).toBe(
      true,
    );
    expect(() => compileRouteFilter("\"MIXED\" = 'x'", fields)).toThrow(
      /未知字段/u,
    );
  });

  it("按 Unicode 字符实现字符串函数和负数 left/right", () => {
    const matches = compileRouteFilter(
      "left(name, -1) = '道路' AND right(name, -1) = '路段' AND length(name) = 3",
      fields,
    );
    expect(matches({ name: "道路段" })).toBe(true);
    expect(
      compileRouteFilter(
        "left(name, -1) = '道路' AND right(name, -1) = '路段'",
        fields,
      )({ name: "道路🙂段" }),
    ).toBe(false);
    expect(
      compileRouteFilter(
        "left(name, -1) = '道路🙂' AND right(name, -1) = '路🙂段'",
        fields,
      )({ name: "道路🙂段" }),
    ).toBe(true);
    expect(
      compileRouteFilter(
        "upper(trim(name)) = 'ABC'",
        fields,
      )({ name: " abc " }),
    ).toBe(true);
    expect(
      compileRouteFilter(
        "coalesce(nullable, '默认') = '默认'",
        fields,
      )({ nullable: null }),
    ).toBe(true);
  });

  it("支持 LIKE、ILIKE、IN 和 NULL 三值逻辑", () => {
    expect(
      compileRouteFilter("name LIKE '北%_'", fields)({ name: "北环线" }),
    ).toBe(true);
    expect(
      compileRouteFilter("name ILIKE '北%'", fields)({ name: "北环线" }),
    ).toBe(true);
    expect(
      compileRouteFilter("name ILIKE 'NORTH%'", fields)({ name: "north road" }),
    ).toBe(true);
    expect(
      compileRouteFilter("width IN (8, 10, NULL)", fields)({ width: 10 }),
    ).toBe(true);
    expect(
      compileRouteFilter("width NOT IN (8, NULL)", fields)({ width: 10 }),
    ).toBe(false);
    expect(
      compileRouteFilter("nullable IS NULL", fields)({ nullable: null }),
    ).toBe(true);
    expect(
      compileRouteFilter(
        "nullable IS NOT NULL",
        fields,
      )({ nullable: undefined }),
    ).toBe(false);
    expect(compileRouteFilter("nullable = 1", fields)({ nullable: null })).toBe(
      false,
    );
    expect(
      compileRouteFilter(
        "nullable = 1 OR enabled = true",
        fields,
      )({ nullable: null, enabled: true }),
    ).toBe(true);
    expect(
      compileRouteFilter(
        "nullable = 1 AND enabled = true",
        fields,
      )({ nullable: null, enabled: false }),
    ).toBe(false);
  });

  it("对未知字段、函数和语法错误给出中文位置提示", () => {
    expect(() => compileRouteFilter("missing = 1", fields)).toThrow(
      /未知字段.*第 1 位/u,
    );
    expect(() => compileRouteFilter("danger(width)", fields)).toThrow(
      /未知函数.*第 1 位/u,
    );
    expect(() => compileRouteFilter("width =", fields)).toThrow(/第 8 位/u);
    expect(() => compileRouteFilter("name = '未闭合", fields)).toThrow(
      /单引号未闭合/u,
    );
  });

  it("限制长度及嵌套深度", () => {
    expect(() => compileRouteFilter("x".repeat(4097), fields)).toThrow(
      /表达式过长/u,
    );
    expect(() =>
      compileRouteFilter(`${"(".repeat(66)}TRUE${")".repeat(66)}`, fields),
    ).toThrow(/嵌套过深/u);
  });

  it("拒绝将非布尔字段直接用于 WHERE 逻辑", () => {
    expect(() =>
      compileRouteFilter(
        "width AND enabled",
        fields,
      )({ width: 1, enabled: true }),
    ).toThrow(/需要布尔值/u);
    expect(() => compileRouteFilter("NOT width", fields)({ width: 1 })).toThrow(
      /需要布尔值/u,
    );
  });
});
