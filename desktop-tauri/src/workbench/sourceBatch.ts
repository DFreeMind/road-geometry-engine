import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
} from "geojson";
import {
  transformPosition,
  utmCrsForWgs84,
  type Position,
  type RouteSection,
  type RoadProject,
} from "../domain";
import type { SourceBinding, FieldMapping } from "./connections";
import type { Field } from "./DataSourceTools";
import {
  filterGeneratedComponentLayers,
  type ComponentSelector,
} from "./generatedSurfaceEdits";

export type SourceDataset = {
  id: string;
  kind: "route-source";
  source_label: string;
  label: string;
  collection: FeatureCollection;
  fields: Field[];
  binding?: SourceBinding | null;
  visible: boolean;
  feature_keys: string[];
  excluded_keys?: string[];
  mapping?: FieldMapping;
  manual_section?: RouteSection;
  route_overrides?: Record<
    string,
    {
      parts?: Record<string, Position[]>;
      section?: RouteSection;
      part_sections?: Record<string, RouteSection>;
      component_exclusions?: ComponentSelector[];
    }
  >;
  revision?: number;
  [key: string]: unknown;
};

export type SourceDatasetDefaults = {
  manual_section?: RouteSection;
  scene_options?: Record<string, unknown>;
  mapping?: FieldMapping;
};

export type EngineGenerationRequest = {
  route_id: string;
  points: Position[];
  crs: string;
  source: string;
  section: RouteSection;
  scene_options: Record<string, unknown>;
};

export type SourceBatchTask = {
  key: string;
  dataset_id: string;
  feature_key: string;
  part_index: number;
  request: EngineGenerationRequest;
  input_signature: string;
  source_properties: Record<string, unknown>;
};

export type SourceBatchIssue = {
  dataset_id: string;
  feature_key?: string;
  part_index?: number;
  code: string;
  message: string;
};

export type SourceBatchResult = {
  key: string;
  dataset_id: string;
  feature_key: string;
  part_index: number;
  input_signature: string;
  source_properties: Record<string, unknown>;
  response?: unknown;
  error?: string;
};

export type SourceBatchOutput = {
  results: SourceBatchResult[];
  total: number;
  completed: number;
  dataset_revisions: Record<string, number>;
  scene_key: string;
  issues: SourceBatchIssue[];
};

type DatasetLike = Partial<SourceDataset> & {
  id?: string;
  source_label?: string;
  label?: string;
  collection?: FeatureCollection;
  fields?: Field[];
  binding?: SourceBinding | null;
};

const sectionWidths = [
  "median_width",
  "left_emergency_width",
  "right_emergency_width",
  "left_shoulder_width",
  "right_shoulder_width",
  "left_slope_width",
  "right_slope_width",
] as const;
const sectionKeys = [
  "left_lane_count",
  "left_lane_width",
  "right_lane_count",
  "right_lane_width",
  ...sectionWidths,
] as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function hash(value: string): string {
  // 使用两个 32 位滚动哈希生成紧凑稳定键，避免逐字符的大整数运算。
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

const collectionFingerprints = new WeakMap<FeatureCollection, string>();

function collectionFingerprint(collection: FeatureCollection): string {
  const cached = collectionFingerprints.get(collection);
  if (cached) return cached;
  const fingerprint = hash(canonical(collection.features));
  collectionFingerprints.set(collection, fingerprint);
  return fingerprint;
}

type FeatureIdentity = { base: string; fingerprint: string };

const featureIdentities = new WeakMap<Feature, FeatureIdentity>();
function featureIdentity(feature: Feature): FeatureIdentity {
  const cached = featureIdentities.get(feature);
  if (cached) return cached;
  const fingerprint = hash(canonical(feature));
  const identity =
    feature.id !== undefined && feature.id !== null
      ? {
          base: `fid:${encodeURIComponent(String(feature.id))}:${fingerprint}`,
          fingerprint,
        }
      : { base: `content:${fingerprint}`, fingerprint };
  featureIdentities.set(feature, identity);
  return identity;
}

const featureKeyCache = new WeakMap<
  Feature[],
  { preferred?: string[]; keys: string[] }
>();
const featureLookupCache = new WeakMap<
  Feature[],
  { byReference: Map<Feature, number>; byId: Map<string, number[]> }
>();
const featureKeyIndexes = new WeakMap<string[], Map<string, number>>();

function featureKeyIndex(keys: string[]): Map<string, number> {
  const cached = featureKeyIndexes.get(keys);
  if (cached) return cached;
  const index = new Map<string, number>();
  keys.forEach((key, position) => {
    if (!index.has(key)) index.set(key, position);
  });
  featureKeyIndexes.set(keys, index);
  return index;
}

/** 先按稳定键或对象引用查找；结构回退只检查同 ID、同指纹候选。 */
export function findSourceFeatureIndex(
  dataset: Pick<SourceDataset, "collection" | "feature_keys">,
  feature: Feature,
  requestedKey?: string,
): number {
  if (requestedKey !== undefined)
    return featureKeyIndex(dataset.feature_keys).get(requestedKey) ?? -1;

  const features = dataset.collection.features as Feature[];
  let lookup = featureLookupCache.get(features);
  if (!lookup) {
    const byReference = new Map<Feature, number>();
    const byId = new Map<string, number[]>();
    features.forEach((candidate, index) => {
      byReference.set(candidate, index);
      if (candidate.id === undefined || candidate.id === null) return;
      const id = String(candidate.id);
      const candidates = byId.get(id);
      if (candidates) candidates.push(index);
      else byId.set(id, [index]);
    });
    lookup = { byReference, byId };
    featureLookupCache.set(features, lookup);
  }
  const referenced = lookup.byReference.get(feature);
  if (referenced !== undefined) return referenced;
  if (feature.id === undefined || feature.id === null) return -1;

  const candidates = lookup.byId.get(String(feature.id)) ?? [];
  if (!candidates.length) return -1;
  const fingerprint = featureIdentity(feature).fingerprint;
  const content = canonical(feature);
  return (
    candidates.find((index) => {
      const candidate = features[index];
      return (
        featureIdentity(candidate).fingerprint === fingerprint &&
        canonical(candidate) === content
      );
    }) ?? -1
  );
}

function uniqueFeatureKeys(
  features: Feature[],
  preferred?: string[],
): string[] {
  const cached = featureKeyCache.get(features);
  if (cached && cached.preferred === preferred) return cached.keys;
  const used = new Set<string>();
  const keys = features.map((feature, index) => {
    const raw = preferred?.[index];
    const base =
      typeof raw === "string" && raw ? raw : featureIdentity(feature).base;
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base}~${suffix++}`;
    used.add(key);
    return key;
  });
  featureKeyCache.set(features, { preferred, keys });
  featureKeyIndexes.set(keys, new Map(keys.map((key, index) => [key, index])));
  return keys;
}

function fieldsUnion(first: Field[], second: Field[]): Field[] {
  const result = [...first];
  const seen = new Set(
    first.map((field) => (typeof field === "string" ? field : field.name)),
  );
  for (const field of second) {
    const name = typeof field === "string" ? field : field.name;
    if (!seen.has(name)) {
      result.push(field);
      seen.add(name);
    }
  }
  return result;
}

function sameSource(
  dataset: DatasetLike,
  label: string,
  binding?: SourceBinding | null,
) {
  const existingFingerprint = dataset.binding?.fingerprint;
  const incomingFingerprint = binding?.fingerprint;
  if (existingFingerprint && incomingFingerprint)
    return existingFingerprint === incomingFingerprint;
  return dataset.source_label === label;
}

/** 将历史项目中的 route-source layer 补齐稳定 feature key 和可选的默认字段。 */
export function normalizeSourceDataset(
  layer: DatasetLike,
  defaults: SourceDatasetDefaults = {},
): SourceDataset {
  const collection =
    layer.collection?.type === "FeatureCollection" &&
    Array.isArray(layer.collection.features)
      ? layer.collection
      : ({ type: "FeatureCollection", features: [] } as FeatureCollection);
  const features = collection.features as Feature[];
  const featureKeys = uniqueFeatureKeys(features, layer.feature_keys);
  const layerDefaults = layer as Record<string, unknown>;
  const manual =
    layer.manual_section ??
    (layerDefaults.defaults as SourceDatasetDefaults | undefined)
      ?.manual_section ??
    defaults.manual_section;
  return {
    ...layer,
    id:
      typeof layer.id === "string" && layer.id
        ? layer.id
        : `route-source-${hash(canonical(collection))}`,
    kind: "route-source",
    source_label: layer.source_label ?? layer.label ?? "路线数据源",
    label: layer.label ?? layer.source_label ?? "路线数据源",
    collection,
    fields: Array.isArray(layer.fields) ? layer.fields : [],
    binding: layer.binding ?? null,
    visible: layer.visible !== false,
    feature_keys: featureKeys,
    excluded_keys: Array.isArray(layer.excluded_keys)
      ? [
          ...new Set(
            layer.excluded_keys.filter(
              (key): key is string =>
                typeof key === "string" && featureKeys.includes(key),
            ),
          ),
        ]
      : [],
    ...(layer.mapping || layer.binding?.mapping || defaults.mapping
      ? { mapping: layer.mapping ?? layer.binding?.mapping ?? defaults.mapping }
      : {}),
    ...(manual ? { manual_section: structuredClone(manual) } : {}),
    ...(layer.route_overrides
      ? { route_overrides: layer.route_overrides }
      : {}),
    revision:
      Number.isInteger(layer.revision) && (layer.revision ?? 0) >= 0
        ? layer.revision
        : 1,
  };
}

export function normalizeSourceDatasets(
  layers: unknown,
  defaults: SourceDatasetDefaults = {},
): SourceDataset[] {
  if (!Array.isArray(layers)) return [];
  return layers
    .filter((layer) =>
      Boolean(
        layer &&
          typeof layer === "object" &&
          (layer as DatasetLike).kind === "route-source",
      ),
    )
    .map((layer) => normalizeSourceDataset(layer as DatasetLike, defaults));
}

/** 同一来源追加；完全相同的 FID+内容或无 FID 内容只保留一份。冲突 FID 的异内容以内容指纹分别保留。 */
export function appendDataset(
  existing: DatasetLike | undefined,
  incomingFeatures: Feature[],
  label: string,
  fields: Field[],
  binding: SourceBinding | null | undefined,
  defaults: SourceDatasetDefaults,
  newId: () => string,
): SourceDataset {
  const canAppend = existing && sameSource(existing, label, binding);
  const base = canAppend
    ? normalizeSourceDataset(existing, defaults)
    : normalizeSourceDataset(
        {
          id: newId(),
          kind: "route-source",
          source_label: label,
          label,
          collection: { type: "FeatureCollection", features: [] },
          fields: [],
          binding: binding ?? null,
          visible: true,
          feature_keys: [],
        },
        defaults,
      );
  const features = [...base.collection.features] as Feature[];
  const featureKeys = [...base.feature_keys];
  const existingExact = new Map<string, Feature[]>();
  for (const feature of features) {
    const fingerprint = featureIdentity(feature).fingerprint;
    const matches = existingExact.get(fingerprint);
    if (matches) matches.push(feature);
    else existingExact.set(fingerprint, [feature]);
  }
  const usedKeys = new Set(featureKeys);
  for (const feature of incomingFeatures) {
    const identity = featureIdentity(feature);
    const matches = existingExact.get(identity.fingerprint);
    const content = matches?.length ? canonical(feature) : undefined;
    if (matches?.some((candidate) => canonical(candidate) === content))
      continue;
    let key = identity.base;
    let suffix = 2;
    while (usedKeys.has(key)) key = `${identity.base}~${suffix++}`;
    const copy = structuredClone(feature);
    featureIdentities.set(copy, identity);
    features.push(copy);
    featureKeys.push(key);
    usedKeys.add(key);
    const nextMatches = existingExact.get(identity.fingerprint);
    if (nextMatches) nextMatches.push(copy);
    else existingExact.set(identity.fingerprint, [copy]);
  }
  const excluded = new Set(base.excluded_keys ?? []);
  const validKeys = new Set(featureKeys);
  return {
    ...base,
    ...(canAppend ? {} : { id: base.id, source_label: label, label }),
    collection: { ...base.collection, features },
    feature_keys: featureKeys,
    fields: fieldsUnion(base.fields, fields),
    binding: binding ?? base.binding ?? null,
    ...(defaults.manual_section && !base.manual_section
      ? { manual_section: structuredClone(defaults.manual_section) }
      : {}),
    ...(defaults.mapping && !base.mapping
      ? { mapping: { ...defaults.mapping } }
      : {}),
    excluded_keys: [...excluded].filter((key) => validKeys.has(key)),
    revision: (base.revision ?? 0) + 1,
  };
}

export function removeDatasetFeatures(
  dataset: SourceDataset,
  featureKeys: string[],
): SourceDataset {
  const remove = new Set(featureKeys);
  const keepIndexes = dataset.feature_keys
    .map((key, index) => ({ key, index }))
    .filter(({ key }) => !remove.has(key));
  const keep = new Set(keepIndexes.map(({ index }) => index));
  return {
    ...dataset,
    collection: {
      ...dataset.collection,
      features: dataset.collection.features.filter((_feature, index) =>
        keep.has(index),
      ),
    },
    feature_keys: keepIndexes.map(({ key }) => key),
    excluded_keys: (dataset.excluded_keys ?? []).filter(
      (key) => !remove.has(key),
    ),
    revision: (dataset.revision ?? 0) + 1,
  };
}

export function setDatasetIncluded(
  dataset: SourceDataset,
  featureKeys: string[],
  included: boolean,
): SourceDataset {
  const valid = new Set(
    featureKeys.filter((key) => dataset.feature_keys.includes(key)),
  );
  const excluded = new Set(dataset.excluded_keys ?? []);
  for (const key of valid) included ? excluded.delete(key) : excluded.add(key);
  return {
    ...dataset,
    excluded_keys: [...excluded].filter((key) =>
      dataset.feature_keys.includes(key),
    ),
    revision: (dataset.revision ?? 0) + 1,
  };
}

function numeric(value: unknown, key: string): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    throw new Error(`${key} 必须是有限非负数值。`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${key} 必须是有限非负数值。`);
  return parsed;
}

function readMapped(
  properties: Record<string, unknown>,
  mapping: FieldMapping,
  key: string,
  fallbackAllowed: boolean,
  fallback: unknown,
): unknown {
  const field = mapping[key];
  if (typeof field !== "string" || !field) return fallback;
  if (!Object.hasOwn(properties, field))
    throw new Error(`映射字段 ${field} 不存在；请检查该来源字段映射。`);
  const value = properties[field];
  if (value == null) {
    if (!fallbackAllowed)
      throw new Error(
        `映射字段 ${field} 的值为空；请修正数据或显式启用手动回退。`,
      );
    return fallback;
  }
  return value;
}

function sectionForFeature(
  properties: Record<string, unknown>,
  mapping: FieldMapping,
  manual: RouteSection | undefined,
): RouteSection {
  const fallbackAllowed = mapping.mapping_null_fallback === true;
  const base = manual;
  const manualLane = (side: "left" | "right") => base?.[`${side}_lanes`] ?? [];
  const valueFor = (key: (typeof sectionKeys)[number], fallback: unknown) =>
    numeric(
      readMapped(properties, mapping, key, fallbackAllowed, fallback),
      key,
    );
  const result: RouteSection = {
    left_lanes: [],
    right_lanes: [],
    median_width: 0,
    left_emergency_width: 0,
    right_emergency_width: 0,
    left_shoulder_width: 0,
    right_shoulder_width: 0,
    left_slope_width: 0,
    right_slope_width: 0,
  };
  for (const side of ["left", "right"] as const) {
    const lanes = manualLane(side);
    const countKey = `${side}_lane_count` as const;
    const widthKey = `${side}_lane_width` as const;
    const count = valueFor(countKey, lanes.length);
    const width = valueFor(widthKey, lanes[0] ?? 3.5);
    if (!Number.isInteger(count) || count > 8)
      throw new Error(
        `${side === "left" ? "左" : "右"}侧车道数必须为0～8的整数。`,
      );
    const hasCount =
      typeof mapping[countKey] === "string" && Boolean(mapping[countKey]);
    const hasWidth =
      typeof mapping[widthKey] === "string" && Boolean(mapping[widthKey]);
    if (hasCount || hasWidth)
      result[`${side}_lanes`] = Array.from({ length: count }, () => width);
    else {
      if (!base)
        throw new Error(
          "该来源没有人工横断面默认模板；请设置来源级 manual_section。",
        );
      if (lanes.length > 8) throw new Error("默认横断面每侧车道数必须为0～8。");
      result[`${side}_lanes`] = lanes.map((laneWidth) =>
        numeric(laneWidth, `${side}_lanes`),
      );
    }
  }
  for (const key of sectionWidths) {
    const value = valueFor(key, base?.[key]);
    if (!base && typeof mapping[key] !== "string")
      throw new Error(
        "该来源没有人工横断面默认模板；请设置来源级 manual_section。",
      );
    result[key] = value;
  }
  return result;
}

function validateSection(section: RouteSection): RouteSection {
  const copy = structuredClone(section);
  for (const side of ["left", "right"] as const) {
    const lanes = copy[`${side}_lanes`];
    if (!Array.isArray(lanes) || lanes.length > 8)
      throw new Error("横断面每侧车道数必须为0～8。");
    copy[`${side}_lanes`] = lanes.map((width) =>
      numeric(width, `${side}_lanes`),
    );
  }
  for (const key of sectionWidths) copy[key] = numeric(copy[key], key);
  return copy;
}

export function mappedSectionForFeature(
  feature: Feature,
  mapping: FieldMapping = {},
  manualSection?: RouteSection,
): RouteSection {
  return sectionForFeature(
    (feature.properties ?? {}) as Record<string, unknown>,
    mapping,
    manualSection,
  );
}

function routeIdForFeature(
  feature: Feature,
  featureKey: string,
  mapping: FieldMapping,
): string {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const field = mapping.route_id;
  if (typeof field === "string" && field) {
    if (!Object.hasOwn(properties, field))
      throw new Error(`映射字段 ${field} 不存在；请检查该来源字段映射。`);
    const value = properties[field];
    if (value != null && String(value).trim()) return String(value);
    if (mapping.mapping_null_fallback !== true)
      throw new Error(
        `映射字段 ${field} 的值为空；请修正数据或显式启用手动回退。`,
      );
  }
  for (const value of [
    properties.route_id,
    properties.name,
    feature.id,
    properties.rawid,
    properties.raw_id,
    properties.id,
  ])
    if (value != null && String(value).trim()) return String(value);
  return featureKey;
}

function validateMappedFields(
  properties: Record<string, unknown>,
  mapping: FieldMapping,
) {
  for (const key of sectionKeys) {
    const field = mapping[key];
    if (typeof field === "string" && field && !Object.hasOwn(properties, field))
      throw new Error(`映射字段 ${field} 不存在；请检查该来源字段映射。`);
  }
}

function sourceMapping(
  dataset: SourceDataset,
  project: RoadProject,
): FieldMapping {
  if (dataset.mapping) return dataset.mapping;
  if (dataset.binding?.mapping) return dataset.binding.mapping;
  const projectBinding = project.source_binding;
  if (
    project.source_label === dataset.source_label &&
    (!projectBinding ||
      !dataset.binding ||
      projectBinding.fingerprint === dataset.binding.fingerprint)
  )
    return (project.source_mapping as FieldMapping | undefined) ?? {};
  return {};
}

export function sourceBatchInputSignature(
  dataset: SourceDataset,
  project: RoadProject,
): string {
  return hash(
    canonical({
      dataset_id: dataset.id,
      source_label: dataset.source_label,
      binding_fingerprint: dataset.binding?.fingerprint ?? null,
      revision: dataset.revision ?? 0,
      collection_fingerprint: collectionFingerprint(dataset.collection),
      feature_keys: dataset.feature_keys,
      excluded_keys: dataset.excluded_keys ?? [],
      mapping: sourceMapping(dataset, project),
      manual_section: dataset.manual_section ?? project.manual_section ?? null,
      route_overrides: dataset.route_overrides ?? {},
      scene_options: project.scene_options ?? {},
    }),
  );
}

function lineParts(geometry: Geometry | null): Position[][] | null {
  if (!geometry) return null;
  if (geometry.type === "LineString")
    return [(geometry as LineString).coordinates as Position[]];
  if (geometry.type === "MultiLineString")
    return (geometry as MultiLineString).coordinates as Position[][];
  return null;
}

export function prepareSourceBatch(
  datasets: SourceDataset[],
  project: RoadProject,
): { tasks: SourceBatchTask[]; issues: SourceBatchIssue[] } {
  const tasks: SourceBatchTask[] = [];
  const issues: SourceBatchIssue[] = [];
  for (const rawDataset of datasets) {
    const dataset = normalizeSourceDataset(rawDataset);
    const mapping = sourceMapping(dataset, project);
    const excluded = new Set(dataset.excluded_keys ?? []);
    dataset.collection.features.forEach((rawFeature, featureIndex) => {
      const feature = rawFeature as Feature;
      const featureKey =
        dataset.feature_keys[featureIndex] ?? featureIdentity(feature).base;
      if (excluded.has(featureKey)) return;
      const parts = lineParts(feature.geometry);
      if (!parts) {
        issues.push({
          dataset_id: dataset.id,
          feature_key: featureKey,
          code: "unsupported_geometry",
          message: "仅支持 LineString 或 MultiLineString 路线几何。",
        });
        return;
      }
      let routeId: string;
      try {
        validateMappedFields(
          (feature.properties ?? {}) as Record<string, unknown>,
          mapping,
        );
        routeId = routeIdForFeature(feature, featureKey, mapping);
      } catch (error) {
        issues.push({
          dataset_id: dataset.id,
          feature_key: featureKey,
          code: "mapping_error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      parts.forEach((part, partIndex) => {
        const key = `${encodeURIComponent(dataset.id)}/${encodeURIComponent(featureKey)}/${partIndex}`;
        const override = dataset.route_overrides?.[featureKey];
        const coordinates = override?.parts?.[String(partIndex)] ?? part;
        if (!Array.isArray(coordinates) || coordinates.length < 2) {
          issues.push({
            dataset_id: dataset.id,
            feature_key: featureKey,
            part_index: partIndex,
            code: "invalid_part",
            message: "线部件至少需要两个坐标点。",
          });
          return;
        }
        if (
          coordinates.some(
            (point) =>
              !Array.isArray(point) ||
              point.length < 2 ||
              !Number.isFinite(point[0]) ||
              !Number.isFinite(point[1]) ||
              Math.abs(point[0]) > 180 ||
              Math.abs(point[1]) > 90,
          )
        ) {
          issues.push({
            dataset_id: dataset.id,
            feature_key: featureKey,
            part_index: partIndex,
            code: "invalid_coordinate",
            message: "线部件含无效 WGS84 经纬度坐标。",
          });
          return;
        }
        let section: RouteSection;
        try {
          const partSection = override?.part_sections?.[String(partIndex)];
          section = partSection
            ? validateSection(partSection)
            : override?.section
              ? validateSection(override.section)
              : mappedSectionForFeature(
                  feature,
                  mapping,
                  dataset.manual_section ??
                    (project.manual_section as RouteSection | undefined),
                );
        } catch (error) {
          issues.push({
            dataset_id: dataset.id,
            feature_key: featureKey,
            part_index: partIndex,
            code: "mapping_error",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        try {
          const crs = utmCrsForWgs84(
            coordinates[Math.floor(coordinates.length / 2)],
          );
          const points = coordinates.map((point) =>
            transformPosition([point[0], point[1]], "EPSG:4326", crs),
          );
          const request: EngineGenerationRequest = {
            route_id: routeId,
            points,
            crs,
            source: dataset.source_label,
            section,
            scene_options: structuredClone(project.scene_options ?? {}),
          };
          tasks.push({
            key,
            dataset_id: dataset.id,
            feature_key: featureKey,
            part_index: partIndex,
            input_signature: hash(
              canonical({
                // 几何规则升级后不复用旧算法成果，源数据与人工覆盖保持不变。
                geometry_rule_version:
                  "offset-local-loops-v5-crossing-span-iterative-outer-round-join",
                request: {
                  ...request,
                  scene_options: {
                    enabled: request.scene_options.enabled ?? [],
                    spacing_m: request.scene_options.spacing_m ?? 50,
                    offset_m: request.scene_options.offset_m ?? 1,
                    side: request.scene_options.side ?? "both",
                  },
                },
                properties: feature.properties ?? {},
              }),
            ),
            source_properties: structuredClone(
              (feature.properties ?? {}) as Record<string, unknown>,
            ),
            request,
          });
        } catch (error) {
          issues.push({
            dataset_id: dataset.id,
            feature_key: featureKey,
            part_index: partIndex,
            code: "projection_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
  }
  return { tasks, issues };
}

export function makeSourceBatchOutput(
  results: SourceBatchResult[],
  total: number,
  metadata: {
    datasets?: SourceDataset[];
    scene_key?: string;
    issues?: SourceBatchIssue[];
  } = {},
): SourceBatchOutput {
  return {
    results,
    total,
    completed: results.length,
    dataset_revisions: Object.fromEntries(
      (metadata.datasets ?? []).map((dataset) => [
        dataset.id,
        dataset.revision ?? 0,
      ]),
    ),
    scene_key: metadata.scene_key ?? "",
    issues: metadata.issues ?? [],
  };
}

/** 按来源和成果组件聚合批量结果，结果属性含完整源属性及来源/部件追溯字段。 */
export function batchOutputLayers(
  output: SourceBatchOutput | null | undefined,
  datasets: SourceDataset[] = [],
): { name: string; collection: FeatureCollection; crs: string }[] {
  if (!output) return [];
  const labels = new Map(
    datasets.map((dataset) => [dataset.id, dataset.label]),
  );
  const groups = new Map<
    string,
    { name: string; crs: string; features: Feature[] }
  >();
  for (const result of output.results) {
    if (result.error || !result.response) continue;
    const response = result.response as any;
    const rawLayers: any[] = Array.isArray(response.layers)
      ? [...response.layers]
      : Array.isArray(response.outputs?.layers)
        ? [...response.outputs.layers]
        : response.feature_collection?.type === "FeatureCollection"
          ? componentGroups(
              response.feature_collection,
              response.projected_crs ?? "EPSG:4326",
            )
          : response.type === "FeatureCollection"
            ? componentGroups(response, "EPSG:4326")
            : [];
    if (Array.isArray(response.ancillary_layers))
      rawLayers.push(...response.ancillary_layers);
    for (const layer of rawLayers) {
      const collection =
        layer.collection ?? layer.geojson ?? layer.feature_collection;
      if (collection?.type !== "FeatureCollection") continue;
      const componentName = String(
        layer.name ?? layer.layer_name ?? "道路成果",
      );
      const crs = String(
        layer.crs ?? response.crs ?? response.projected_crs ?? "EPSG:4326",
      );
      const name = `${labels.get(result.dataset_id) ?? result.dataset_id} · ${componentName}`;
      const groupKey = canonical([result.dataset_id, componentName, crs]);
      const group = groups.get(groupKey) ?? { name, crs, features: [] };
      groups.set(groupKey, group);
      const taggedFeatures = (collection.features as Feature[]).map(
        (rawFeature) => {
          // 成果几何不可变；只包装属性以携带可追溯来源和部件信息。
          const feature = { ...rawFeature };
          feature.properties = {
            ...result.source_properties,
            ...(feature.properties ?? {}),
            // 来源属性不可变，所有组件共享追溯对象，避免每条车道重复深拷贝整行。
            source_attributes: result.source_properties,
            source_dataset_id: result.dataset_id,
            source_feature_key: result.feature_key,
            part_index: result.part_index,
          };
          return feature;
        },
      );
      const visibleFeatures = filterGeneratedComponentLayers(
        [
          {
            name: componentName,
            crs,
            collection: {
              ...(collection as FeatureCollection),
              features: taggedFeatures,
            },
          },
        ],
        datasets.find((dataset) => dataset.id === result.dataset_id)
          ?.route_overrides?.[result.feature_key]?.component_exclusions ?? [],
      )[0]?.collection.features as Feature[] | undefined;
      for (const feature of visibleFeatures ?? []) group.features.push(feature);
    }
  }
  const outputGroups = [...groups.values()];
  const namesByBase = new Map<string, Set<string>>();
  for (const group of outputGroups) {
    const crsSet = namesByBase.get(group.name) ?? new Set<string>();
    crsSet.add(group.crs);
    namesByBase.set(group.name, crsSet);
  }
  return outputGroups.map(({ name, crs, features }) => ({
    name: (namesByBase.get(name)?.size ?? 0) > 1 ? `${name} (${crs})` : name,
    collection: { type: "FeatureCollection", features },
    crs,
  }));
}

function componentGroups(
  collection: FeatureCollection,
  crs: string,
): { name: string; collection: FeatureCollection; crs: string }[] {
  const groups = new Map<string, Feature[]>();
  for (const feature of collection.features as Feature[]) {
    const name = String(
      feature.properties?.component ??
        feature.properties?.layer ??
        feature.properties?.layer_name ??
        "道路成果",
    );
    const features = groups.get(name);
    if (features) features.push(feature);
    else groups.set(name, [feature]);
  }
  return [...groups].map(([name, features]) => ({
    name,
    crs,
    collection: { type: "FeatureCollection", features },
  }));
}
