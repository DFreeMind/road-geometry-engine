import { describe, expect, it } from "vitest";
import {
  bindingFor,
  connectionStorageKey,
  publicConnection,
  readConnections,
  saveBindingMapping,
  writeConnections,
  type SourceConnection,
} from "../src/workbench/connections";

const example = (): SourceConnection => ({
  id: "database-a",
  name: "道路库",
  kind: "postgis",
  config: {
    host: "localhost",
    port: 5432,
    database: "roads",
    user: "reader",
    sslmode: "prefer",
    password: "must-not-persist",
  },
  layers: ["public", "design"].map((schema) => ({
    id: schema,
    name: `${schema}.roads`,
    schema,
    table: "roads",
    geometry_column: "geom",
    type_name: "",
  })),
});
function store() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
describe("多连接与图层字段规则", () => {
  it("多数据库公开参数保存重读，认证凭据全部排除", () => {
    const storage = store();
    const definitions = [
      [
        "mysql",
        { host: "server", port: 3306, database: "roads", user: "reader" },
      ],
      [
        "mssql",
        {
          host: "server",
          port: 1433,
          database: "roads",
          auth: "windows",
          odbc_driver: "ODBC Driver 18 for SQL Server",
          encrypt: "yes",
          trust_certificate: "no",
        },
      ],
      [
        "oracle",
        {
          host: "server",
          port: 1521,
          service: "ORCL",
          user: "reader",
          scope: "schema",
          default_schema: "ROADS",
        },
      ],
      ["sqlite", { path: "C:/data/roads.sqlite" }],
      ["gpkg", { path: "C:/data/roads.gpkg" }],
    ] as const;
    const connections = definitions.map(([kind, config]) => ({
      id: kind,
      name: kind,
      kind,
      config: {
        ...config,
        password: "test-only-secret",
        connection_string: "forbidden",
      },
      layers: [],
    }));
    writeConnections(connections, storage);
    const restored = readConnections(storage);
    expect(restored.map((c) => c.kind)).toEqual(
      definitions.map(([kind]) => kind),
    );
    expect(restored[2].config.service).toBe("ORCL");
    expect(restored[3].config.path).toBe("C:/data/roads.sqlite");
    expect(storage.getItem(connectionStorageKey)).not.toContain(
      "test-only-secret",
    );
    expect(storage.getItem(connectionStorageKey)).not.toContain(
      "connection_string",
    );
  });
  it("数据库和 Schema 连接可以不包含图层，范围保存重读", () => {
    const storage = store();
    const connection = {
      ...example(),
      layers: [],
      config: {
        ...example().config,
        scope: "schema",
        default_schema: "design",
      },
    };
    writeConnections([connection], storage);
    const restored = readConnections(storage)[0];
    expect(restored.layers).toEqual([]);
    expect(restored.config.default_schema).toBe("design");
    expect(restored.config.scope).toBe("schema");
    expect(restored.config.password).toBeUndefined();
  });
  it("保存重读多个数据库，且不保存密码", () => {
    const storage = store();
    const a = example(),
      b = {
        ...example(),
        id: "database-b",
        name: "另一库",
        config: { ...example().config, database: "other" },
      };
    writeConnections([a, b], storage);
    const restored = readConnections(storage);
    expect(restored).toHaveLength(2);
    expect(restored[1].config.database).toBe("other");
    expect(storage.getItem(connectionStorageKey)).not.toContain(
      "must-not-persist",
    );
    expect(storage.getItem(connectionStorageKey)).not.toContain('"password"');
  });
  it("持久化记住密码偏好三态，但任何情况下都不持久化密码", () => {
    const storage = store();
    const connections = [
      { ...example(), rememberPassword: true },
      { ...example(), id: "database-b", rememberPassword: false },
      { ...example(), id: "database-legacy", rememberPassword: undefined },
    ];

    writeConnections(connections, storage);

    const serialized = storage.getItem(connectionStorageKey)!;
    const persisted = JSON.parse(serialized).connections;
    expect(
      persisted.map((item: SourceConnection) => item.rememberPassword),
    ).toEqual([true, false, undefined]);
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toContain('"password"');
    expect(
      readConnections(storage).map((item) => item.rememberPassword),
    ).toEqual([true, false, undefined]);
  });
  it("切换记住密码偏好不改变绑定指纹，旧映射仍可保存", () => {
    const storage = store();
    const connection = example();
    const layer = connection.layers[0];
    writeConnections([connection], storage);
    const binding = bindingFor(connection, layer);

    writeConnections([{ ...connection, rememberPassword: true }], storage);
    expect(
      bindingFor({ ...connection, rememberPassword: true }, layer).fingerprint,
    ).toBe(binding.fingerprint);
    saveBindingMapping(binding, { route_id: "route_code" }, storage);

    const restored = readConnections(storage)[0];
    expect(restored.rememberPassword).toBe(true);
    expect(restored.layers[0].mapping).toEqual({ route_id: "route_code" });
    expect(storage.getItem(connectionStorageKey)).not.toContain(
      "must-not-persist",
    );
  });
  it("默认数据库范围不改变旧连接映射指纹", () => {
    const connection = example();
    const before = bindingFor(connection, connection.layers[0]);
    connection.config = {
      ...connection.config,
      scope: "database",
      default_schema: "",
    };
    expect(bindingFor(connection, connection.layers[0]).fingerprint).toBe(
      before.fingerprint,
    );
  });
  it("同名表位于不同 Schema 时映射相互隔离", () => {
    const storage = store(),
      connection = example();
    writeConnections([connection], storage);
    saveBindingMapping(
      bindingFor(connection, connection.layers[0]),
      { route_id: "rid" },
      storage,
    );
    const restored = readConnections(storage)[0];
    expect(restored.layers[0].mapping).toEqual({ route_id: "rid" });
    expect(restored.layers[1].mapping).toBeUndefined();
  });
  it("修改连接目标后拒绝把旧工程规则写入新数据库", () => {
    const storage = store(),
      connection = example(),
      binding = bindingFor(connection, connection.layers[0]);
    connection.config.database = "changed";
    writeConnections([connection], storage);
    const before = storage.getItem(connectionStorageKey);
    expect(() =>
      saveBindingMapping(binding, { route_id: "old_id" }, storage),
    ).toThrow("已改变");
    expect(storage.getItem(connectionStorageKey)).toBe(before);
  });
  it("拒绝把带凭据的 WFS 地址持久保存", () => {
    for (const url of [
      "https://user:secret@example.com/wfs",
      "https://example.com/wfs?token=secret",
    ]) {
      expect(() =>
        publicConnection({ ...example(), kind: "wfs", config: { url } }),
      ).toThrow("认证信息");
    }
  });
  it("损坏的配置库不被读取过程覆盖", () => {
    const storage = store();
    storage.setItem(connectionStorageKey, "{broken");
    expect(() => readConnections(storage)).toThrow();
    expect(storage.getItem(connectionStorageKey)).toBe("{broken");
  });
});
