import proj4 from "proj4";
import type * as GeoJSON from "geojson";

export type Position = [number, number];
export type GeometryType = "Point" | "LineString" | "Polygon";
export type CatalogEntry = {
  id: string;
  revision: number;
  name: string;
  category: string;
  subtype: string;
  geometry: GeometryType;
  specification: Record<string, unknown>;
  placement: Record<string, unknown>;
  source: string;
  notes: string;
  origin?: string;
  import_filename?: string;
  [key: string]: unknown;
};
export type Facility = {
  id: string;
  kind: string;
  x: number;
  y: number;
  end_x?: number;
  end_y?: number;
  vertices?: Position[];
  rotation?: number;
  route_id?: string;
  confirmed?: boolean;
  template: CatalogEntry;
  [key: string]: unknown;
};
export type RouteSection = {
  left_lanes: number[];
  right_lanes: number[];
  median_width: number;
  left_emergency_width: number;
  right_emergency_width: number;
  left_shoulder_width: number;
  right_shoulder_width: number;
  left_slope_width: number;
  right_slope_width: number;
  [key: string]: unknown;
};
export type RoadProject = {
  schema_version: 2;
  input_version: number;
  route_id: string;
  crs: string;
  route_points: Position[];
  route_source: string;
  section: RouteSection;
  manual_section?: unknown;
  source_mapping?: unknown;
  mapping_null_fallback?: unknown;
  mapped_attributes?: unknown;
  source_fields?: unknown;
  source_label?: unknown;
  source_binding?: import("./workbench/connections").SourceBinding | null;
  scene_options?: Record<string, unknown>;
  basemap_view?: Record<string, unknown>;
  manual_facilities: Facility[];
  display_adaptation?: boolean;
  file_basemaps?: unknown[];
  rasters?: unknown[];
  input_unknown?: Record<string, unknown>;
  output: { input_version: number; response: unknown } | null;
  view: {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  };
  catalog: { schema_version: 1; entries: CatalogEntry[] };
  [key: string]: unknown;
};

export const demoRequest = {
  route_id: "example-metric",
  points: [
    [448000, 4420000],
    [448100, 4420050],
    [448220, 4420090],
    [448350, 4420075],
    [448500, 4420000],
  ] as Position[],
  crs: "EPSG:32650",
  source: "synthetic_fixture",
  section: {
    left_lanes: [3.5, 3.5],
    right_lanes: [3.5, 3.5],
    median_width: 1.5,
    left_emergency_width: 2.5,
    right_emergency_width: 2.5,
    left_shoulder_width: 0.5,
    right_shoulder_width: 0.5,
    left_slope_width: 0,
    right_slope_width: 0,
  },
};

export const basicCatalog: CatalogEntry[] = [
  ["sign", "标志", "警告标志", "Point"],
  ["sign", "标志", "禁令标志", "Point"],
  ["sign", "标志", "指示标志", "Point"],
  ["sign", "标志", "指路标志", "Point"],
  ["marking", "标线", "纵向标线", "LineString"],
  ["marking", "标线", "导向箭头", "Point"],
  ["guardrail", "防护", "波形梁护栏", "LineString"],
  ["delineator", "视线诱导", "轮廓标", "Point"],
  ["lighting", "照明", "单臂路灯", "Point"],
  ["lighting", "照明", "双臂路灯", "Point"],
  ["signal", "信号控制", "机动车信号灯", "Point"],
  ["monitor", "监控与检测", "监控摄像机", "Point"],
  ["drain", "排水与配套", "排水沟", "LineString"],
  ["other", "其他附属", "避险车道", "Polygon"],
].map(([id, category, subtype, geometry], index) => ({
  id: `system.basic.${id}.${index}`,
  revision: 1,
  name: `${subtype} · 基础模板`,
  category,
  subtype,
  geometry: geometry as GeometryType,
  specification: { support_type: "", mounting_height_m: null },
  placement: { layout: "manual", spacing_m: null, offset_m: null },
  source: "",
  notes: "分类生产模板，规格待填写；不表示已完成工程设计或规范校核。",
  origin: "system",
}));

export function defaultProject(): RoadProject {
  return {
    schema_version: 2,
    input_version: 1,
    route_id: demoRequest.route_id,
    crs: demoRequest.crs,
    route_points: structuredClone(demoRequest.points),
    route_source: "synthetic_fixture",
    section: structuredClone(demoRequest.section),
    manual_facilities: [],
    output: null,
    view: {
      center: [116.39144941, 39.92851159],
      zoom: 14,
      pitch: 0,
      bearing: 0,
    },
    catalog: { schema_version: 1, entries: structuredClone(basicCatalog) },
  };
}

export function normalizeProject(input: unknown): RoadProject {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("项目文件必须是 JSON 对象");
  const raw = structuredClone(input as Record<string, unknown>);
  if (raw.schema_version !== 1 && raw.schema_version !== 2)
    throw new Error("不支持的项目 JSON 版本");
  const points = raw.route_points;
  if (
    !Array.isArray(points) ||
    points.length === 1 ||
    points.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((n) => typeof n !== "number" || !Number.isFinite(n)),
    )
  )
    throw new Error("路线点无效：须为空路线或至少 2 个有限投影坐标点");
  const isEngineSection = (value: unknown): value is RouteSection =>
    Boolean(
      value &&
        typeof value === "object" &&
        Array.isArray((value as any).left_lanes) &&
        Array.isArray((value as any).right_lanes),
    );
  const section = (
    isEngineSection(raw.section) ? raw.section : raw.manual_section
  ) as RouteSection;
  if (
    !section ||
    !Array.isArray(section.left_lanes) ||
    !Array.isArray(section.right_lanes)
  )
    throw new Error("项目横断面缺少逐车道宽度字段");
  const oldFacilities = Array.isArray(raw.manual_facilities)
    ? (raw.manual_facilities as Facility[])
    : [];
  const facilities = oldFacilities.map((item) => {
    if (item.template) return item;
    const legacy: Record<string, [string, string, GeometryType]> = {
      sign: ["标志", "警告标志", "Point"],
      lighting: ["照明", "单臂路灯", "Point"],
      milestone: ["其他附属", "里程牌", "Point"],
      delineator: ["视线诱导", "轮廓标", "Point"],
      guardrail: ["防护", "波形梁护栏", "LineString"],
    };
    const values = legacy[item.kind];
    if (!values)
      throw new Error(`旧项目设施类型 ${item.kind} 缺少模板快照，无法安全迁移`);
    const [category, subtype, geometry] = values;
    return {
      ...item,
      template: {
        id: `system.legacy.${item.kind}`,
        revision: 1,
        name: `${subtype} · 旧项目快照`,
        category,
        subtype,
        geometry,
        specification: {},
        placement: { layout: "manual", spacing_m: null, offset_m: null },
        source: "schema 1 manual facility",
        notes: "由旧项目人工设施记录补建兼容快照；规格未推定。",
        origin: "system",
      } as CatalogEntry,
    };
  });
  const migrated: RoadProject = {
    ...raw,
    schema_version: 2,
    input_version:
      typeof raw.input_version === "number" ? raw.input_version : 1,
    route_id: typeof raw.route_id === "string" ? raw.route_id : "route-1",
    crs: typeof raw.crs === "string" ? raw.crs : "EPSG:32650",
    route_points: points as Position[],
    route_source:
      typeof raw.route_source === "string" ? raw.route_source : "project",
    section: structuredClone(section),
    manual_facilities: facilities,
    output:
      raw.output && typeof raw.output === "object"
        ? (raw.output as RoadProject["output"])
        : null,
    view: {
      ...defaultProject().view,
      ...(raw.view && typeof raw.view === "object" ? (raw.view as object) : {}),
      ...(raw.basemap_view &&
      typeof raw.basemap_view === "object" &&
      "center" in (raw.basemap_view as object)
        ? (raw.basemap_view as object)
        : {}),
    },
    catalog:
      raw.catalog && typeof raw.catalog === "object"
        ? (raw.catalog as RoadProject["catalog"])
        : { schema_version: 1, entries: structuredClone(basicCatalog) },
  };
  if (
    migrated.output &&
    migrated.output.input_version !== migrated.input_version
  )
    migrated.output = null;
  return migrated;
}

const UTM_32650 = "+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs";
proj4.defs("EPSG:32650", UTM_32650);
proj4.defs(
  "EPSG:32649",
  "+proj=utm +zone=49 +datum=WGS84 +units=m +no_defs +type=crs",
);
proj4.defs(
  "EPSG:32651",
  "+proj=utm +zone=51 +datum=WGS84 +units=m +no_defs +type=crs",
);
proj4.defs(
  "EPSG:32749",
  "+proj=utm +zone=49 +south +datum=WGS84 +units=m +no_defs +type=crs",
);
proj4.defs(
  "EPSG:32750",
  "+proj=utm +zone=50 +south +datum=WGS84 +units=m +no_defs +type=crs",
);
proj4.defs(
  "EPSG:32751",
  "+proj=utm +zone=51 +south +datum=WGS84 +units=m +no_defs +type=crs",
);

export function transformPosition(
  point: Position,
  from: string,
  to: string,
): Position {
  if (from === to) return [point[0], point[1]];
  let result: number[];
  try {
    result = proj4(from, to, point) as number[];
  } catch {
    throw new Error(`未知坐标系 ${from} 或 ${to}，请连接本地引擎解析 CRS 定义`);
  }
  if (!result.every(Number.isFinite)) throw new Error("坐标转换结果无效");
  return [result[0], result[1]];
}

export function registerCrsDefinition(crs: string, definition: string) {
  proj4.defs(crs, definition);
}
export function hasCrsDefinition(crs: string) {
  return Boolean(proj4.defs(crs));
}
export function utmCrsForWgs84(point: Position): string {
  const zone = Math.max(1, Math.min(60, Math.floor((point[0] + 180) / 6) + 1));
  const code = (point[1] < 0 ? 32700 : 32600) + zone;
  const crs = `EPSG:${code}`;
  if (!proj4.defs(crs))
    proj4.defs(
      crs,
      `+proj=utm +zone=${zone}${point[1] < 0 ? " +south" : ""} +datum=WGS84 +units=m +no_defs +type=crs`,
    );
  return crs;
}

export function routeToGeoJSON(
  points: Position[],
  crs: string,
): GeoJSON.FeatureCollection {
  const coords = points.map((p) => transformPosition(p, crs, "EPSG:4326"));
  return {
    type: "FeatureCollection",
    features:
      coords.length >= 2
        ? [
            {
              type: "Feature",
              properties: { layer: "参考线" },
              geometry: { type: "LineString", coordinates: coords },
            },
          ]
        : [],
  };
}

export function facilityFeature(item: Facility, crs: string): GeoJSON.Feature {
  const p = (x: number, y: number) =>
    transformPosition([x, y], crs, "EPSG:4326");
  let geometry: GeoJSON.Geometry;
  const geometryType =
    item.template?.geometry ??
    (item.kind === "guardrail" ? "LineString" : "Point");
  if (geometryType === "LineString")
    geometry = {
      type: "LineString",
      coordinates: [p(item.x, item.y), p(item.end_x!, item.end_y!)],
    };
  else if (geometryType === "Polygon") {
    const ring = (item.vertices ?? []).map((v) => p(...v));
    if (ring.length) ring.push(ring[0]);
    geometry = { type: "Polygon", coordinates: [ring] };
  } else geometry = { type: "Point", coordinates: p(item.x, item.y) };
  return {
    type: "Feature",
    id: item.id,
    properties: {
      id: item.id,
      kind: item.kind,
      name: item.template?.name ?? item.kind,
      category: item.template?.category ?? "",
      template_id: item.template?.id ?? null,
      template_revision: item.template?.revision ?? null,
      source: "manual_placement",
      confirmed: item.confirmed === true,
      route_id: item.route_id,
      specification: item.template?.specification ?? {},
      rotation: item.rotation ?? 0,
    },
    geometry,
  };
}

export function markInputEdited(project: RoadProject): RoadProject {
  return { ...project, input_version: project.input_version + 1, output: null };
}
export function resolveMappedValue(
  attributes: Record<string, unknown>,
  field: string | null | undefined,
  fallbackAllowed: boolean,
  fallbackValue: unknown,
) {
  if (!field)
    return { value: fallbackValue, mode: "manual" as const, field: null };
  const value = attributes[field];
  if (value == null) {
    if (!fallbackAllowed)
      throw new Error(
        `映射字段 ${field} 的值为空；请修正数据或显式启用手动回退。`,
      );
    return { value: fallbackValue, mode: "manual" as const, field };
  }
  return { value, mode: "field" as const, field };
}
export function acceptGeneration(
  project: RoadProject,
  jobId: string,
  currentJobId: string | null,
  response: unknown,
  expectedInputVersion = project.input_version,
): RoadProject {
  if (
    !currentJobId ||
    jobId !== currentJobId ||
    expectedInputVersion !== project.input_version
  )
    return project;
  return {
    ...project,
    output: { input_version: project.input_version, response },
  };
}

export function demoFeatureCollection(): GeoJSON.FeatureCollection {
  const collection = routeToGeoJSON(demoRequest.points, demoRequest.crs);
  const line = collection.features[0];
  if (!line) return collection;
  const coords = (line.geometry as GeoJSON.LineString).coordinates;
  const roads = coords.map((p, i) => ({
    type: "Feature" as const,
    properties: {
      component: i % 2 ? "lane" : "shoulder",
      label: i % 2 ? "车行道" : "路肩",
    },
    geometry: { type: "Point" as const, coordinates: p },
  }));
  return { type: "FeatureCollection", features: [line, ...roads] };
}
