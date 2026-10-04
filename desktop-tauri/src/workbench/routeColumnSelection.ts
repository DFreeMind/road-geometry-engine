export type RouteColumn = { name: string };

const COMMON_ROUTE_COLUMNS = [
  "gid",
  "route_id",
  "roadcode",
  "roadname",
  "name",
  "roadstart",
  "roadends",
];

export function defaultRouteColumnSelection(
  fields: readonly RouteColumn[],
  maximum = 12,
): Set<string> {
  // 数据库允许仅大小写不同的字段名，不能按小写键合并这些业务字段。
  const names = [...new Set(fields.map((field) => field.name))];
  const limit = Math.max(0, Math.floor(maximum));
  if (names.length <= limit) return new Set(names);

  const common = names.filter((name) =>
    COMMON_ROUTE_COLUMNS.includes(name.trim().toLocaleLowerCase()),
  );
  const selected = new Set([...new Set([...common, ...names])].slice(0, limit));
  return new Set(names.filter((name) => selected.has(name)));
}
