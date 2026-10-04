import type { Feature, FeatureCollection } from "geojson";
import type { RouteSection } from "../domain";
import type { SourceDataset } from "./sourceBatch";

/** 删除选择器按成果属性匹配；part_index 始终限定所属路线部件。 */
export type ComponentSelector = {
  part_index: number;
  component?: string;
  side?: string;
  lane_index?: number;
};

export type GeneratedComponentLayer = {
  name: string;
  collection: FeatureCollection;
  crs: string;
};

export type GeneratedTargetScope = {
  dataset_id: string;
  feature_key: string;
  part_index: number;
};

export type GeneratedComponentTarget = {
  selector: ComponentSelector;
  layer_name: string;
  feature_index: number;
  feature: Feature;
};

function propertiesOf(feature: Feature): Record<string, unknown> {
  return (feature.properties ?? {}) as Record<string, unknown>;
}

function componentOf(
  feature: Feature,
  fallbackComponent?: string,
): string | undefined {
  const properties = propertiesOf(feature);
  const value =
    properties.component ??
    properties.layer ??
    properties.layer_name ??
    fallbackComponent;
  return value == null ? undefined : String(value);
}

/** 按选择器中提供的所有属性精确匹配成果要素。 */
export function featureMatchesSelector(
  feature: Feature,
  selector: ComponentSelector,
  fallbackComponent?: string,
): boolean {
  const properties = propertiesOf(feature);
  if (Number(properties.part_index ?? 0) !== selector.part_index) return false;
  if (
    selector.component !== undefined &&
    componentOf(feature, fallbackComponent) !== selector.component
  )
    return false;
  if (
    selector.side !== undefined &&
    String(properties.side ?? "") !== selector.side
  )
    return false;
  if (
    selector.lane_index !== undefined &&
    Number(properties.lane_index) !== selector.lane_index
  )
    return false;
  return true;
}

/** 过滤已生成的显示副本，不修改输入图层、属性对象或几何。 */
export function filterGeneratedComponentLayers<
  T extends GeneratedComponentLayer,
>(layers: T[], selectors: ComponentSelector[]): T[] {
  if (selectors.length === 0) return layers;
  return layers.map((layer) => {
    const features = layer.collection.features as Feature[];
    const kept = features.filter(
      (feature) =>
        !selectors.some((selector) =>
          featureMatchesSelector(feature, selector, layer.name),
        ),
    );
    return kept.length === features.length
      ? layer
      : {
          ...layer,
          collection: { ...layer.collection, features: kept },
        };
  });
}

/** 解析某来源、记录和部件下可供删除的成果要素及其选择器。 */
export function resolveGeneratedComponentTargets(
  layers: GeneratedComponentLayer[],
  scope: GeneratedTargetScope,
): GeneratedComponentTarget[] {
  const targets: GeneratedComponentTarget[] = [];
  for (const layer of layers) {
    (layer.collection.features as Feature[]).forEach(
      (feature, featureIndex) => {
        const properties = propertiesOf(feature);
        if (
          properties.source_dataset_id !== scope.dataset_id ||
          properties.source_feature_key !== scope.feature_key ||
          Number(properties.part_index) !== scope.part_index
        )
          return;
        targets.push({
          selector: {
            part_index: scope.part_index,
            component: componentOf(feature, layer.name),
            ...(properties.side == null
              ? {}
              : { side: String(properties.side) }),
            ...(properties.lane_index == null
              ? {}
              : { lane_index: Number(properties.lane_index) }),
          },
          layer_name: layer.name,
          feature_index: featureIndex,
          feature,
        });
      },
    );
  }
  return targets;
}

function updateOverride(
  dataset: SourceDataset,
  featureKey: string,
  update: (
    current: NonNullable<SourceDataset["route_overrides"]>[string],
  ) => NonNullable<SourceDataset["route_overrides"]>[string],
): SourceDataset {
  const overrides = { ...(dataset.route_overrides ?? {}) };
  const current = overrides[featureKey] ?? {};
  overrides[featureKey] = update(current);
  return {
    ...dataset,
    route_overrides: overrides,
    revision: (dataset.revision ?? 0) + 1,
  };
}

/** 为单个路线部件保存独立横断面覆盖。 */
export function setPartSection(
  dataset: SourceDataset,
  featureKey: string,
  partIndex: number,
  section: RouteSection,
): SourceDataset {
  return updateOverride(dataset, featureKey, (current) => ({
    ...current,
    part_sections: {
      ...(current.part_sections ?? {}),
      [String(partIndex)]: structuredClone(section),
    },
  }));
}

/** 持久化或恢复某个生成成果组件的删除状态。 */
export function setPartComponentExclusion(
  dataset: SourceDataset,
  featureKey: string,
  partIndex: number,
  selector: Omit<ComponentSelector, "part_index">,
  excluded: boolean,
): SourceDataset {
  const normalized = {
    ...selector,
    part_index: partIndex,
  } as ComponentSelector;
  return updateOverride(dataset, featureKey, (current) => {
    const existing = current.component_exclusions ?? [];
    const matches = (candidate: ComponentSelector) =>
      candidate.part_index === normalized.part_index &&
      candidate.component === normalized.component &&
      candidate.side === normalized.side &&
      candidate.lane_index === normalized.lane_index;
    const next = excluded
      ? existing.some(matches)
        ? existing
        : [...existing, normalized]
      : existing.filter((candidate) => !matches(candidate));
    return { ...current, component_exclusions: next };
  });
}

/** 隐藏或恢复整个路线部件，仍保留来源原始记录。 */
export function setPartExcluded(
  dataset: SourceDataset,
  featureKey: string,
  partIndex: number,
  excluded: boolean,
): SourceDataset {
  return setPartComponentExclusion(
    dataset,
    featureKey,
    partIndex,
    {},
    excluded,
  );
}

/** 只清除单个部件的横断面和成果删除规则。 */
export function resetPartEdits(
  dataset: SourceDataset,
  featureKey: string,
  partIndex: number,
): SourceDataset {
  const current = dataset.route_overrides?.[featureKey];
  if (!current) return dataset;
  const partSections = { ...(current.part_sections ?? {}) };
  delete partSections[String(partIndex)];
  const componentExclusions = (current.component_exclusions ?? []).filter(
    (selector) => selector.part_index !== partIndex,
  );
  return updateOverride(dataset, featureKey, (value) => ({
    ...value,
    part_sections: partSections,
    component_exclusions: componentExclusions,
  }));
}

/** 删除某条记录的全部人工覆盖和成果排除规则。 */
export function dropOverride(
  dataset: SourceDataset,
  featureKey: string,
): SourceDataset {
  if (!dataset.route_overrides?.[featureKey]) return dataset;
  const overrides = { ...dataset.route_overrides };
  delete overrides[featureKey];
  return {
    ...dataset,
    route_overrides: overrides,
    revision: (dataset.revision ?? 0) + 1,
  };
}
