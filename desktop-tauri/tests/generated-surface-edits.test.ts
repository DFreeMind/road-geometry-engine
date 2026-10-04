import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection } from "geojson";
import { defaultProject, type RouteSection } from "../src/domain";
import {
  batchOutputLayers,
  normalizeSourceDataset,
  prepareSourceBatch,
  type SourceBatchResult,
  type SourceDataset,
} from "../src/workbench/sourceBatch";
import {
  dropOverride,
  featureMatchesSelector,
  filterGeneratedComponentLayers,
  resolveGeneratedComponentTargets,
  resetPartEdits,
  setPartComponentExclusion,
  setPartExcluded,
  setPartSection,
} from "../src/workbench/generatedSurfaceEdits";

const section: RouteSection = {
  left_lanes: [3.5],
  right_lanes: [3.5],
  median_width: 1,
  left_emergency_width: 0,
  right_emergency_width: 0,
  left_shoulder_width: 0.5,
  right_shoulder_width: 0.5,
  left_slope_width: 0,
  right_slope_width: 0,
};

function makeDataset(): SourceDataset {
  const feature: Feature = {
    type: "Feature",
    id: "multi",
    properties: { route_id: "R-1", untouched: "source" },
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [
          [116, 40],
          [116.01, 40],
        ],
        [
          [117, 40],
          [117.01, 40],
        ],
      ],
    },
  };
  return normalizeSourceDataset({
    id: "roads",
    kind: "route-source",
    source_label: "道路来源",
    label: "道路来源",
    collection: { type: "FeatureCollection", features: [feature] },
    fields: [],
    visible: true,
    feature_keys: [],
    manual_section: section,
  });
}

function polygonFeature(properties: Record<string, unknown>): Feature {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [] },
  };
}

function resultFor(
  dataset: SourceDataset,
  partIndex: number,
): SourceBatchResult {
  const task = prepareSourceBatch([dataset], defaultProject()).tasks[partIndex];
  return {
    key: task.key,
    dataset_id: task.dataset_id,
    feature_key: task.feature_key,
    part_index: task.part_index,
    input_signature: task.input_signature,
    source_properties: task.source_properties,
    response: {
      projected_crs: task.request.crs,
      layers: [
        {
          name: "车道",
          crs: task.request.crs,
          collection: {
            type: "FeatureCollection",
            features: [
              polygonFeature({
                component: "车道",
                side: "left",
                lane_index: 0,
              }),
              polygonFeature({ component: "路肩", side: "left" }),
            ],
          },
        },
      ],
    },
  };
}

describe("generated surface edits", () => {
  it("persists a part section override without changing the original geometry", () => {
    const original = makeDataset();
    const originalGeometry = structuredClone(
      original.collection.features[0].geometry,
    );
    const key = original.feature_keys[0];
    const wider = { ...section, left_lanes: [4.25, 3.75] };
    const edited = setPartSection(original, key, 1, wider);
    const reloaded = normalizeSourceDataset(edited);
    const tasks = prepareSourceBatch([reloaded], defaultProject()).tasks;

    expect(tasks[0].request.section.left_lanes).toEqual(section.left_lanes);
    expect(tasks[1].request.section.left_lanes).toEqual(wider.left_lanes);
    expect(reloaded.route_overrides?.[key].part_sections?.["1"]).toEqual(wider);
    expect(original.collection.features[0].geometry).toEqual(originalGeometry);
    expect(edited.collection.features[0].geometry).toBe(
      original.collection.features[0].geometry,
    );
  });

  it("deletes only the selected lane, preserves the shoulder, and persists on regeneration", () => {
    const original = makeDataset();
    const key = original.feature_keys[0];
    const sourceSnapshot = structuredClone(original.collection);
    const edited = setPartComponentExclusion(
      original,
      key,
      0,
      { component: "车道", side: "left", lane_index: 0 },
      true,
    );
    const result = resultFor(edited, 0);
    const output = {
      results: [result],
      total: 1,
      completed: 1,
      dataset_revisions: { roads: edited.revision ?? 1 },
      scene_key: "scene",
      issues: [],
    };

    const layers = batchOutputLayers(output, [edited]);
    expect(
      layers[0].collection.features.map(
        (feature) => feature.properties?.component,
      ),
    ).toEqual(["路肩"]);
    expect(original.collection).toEqual(sourceSnapshot);
    expect(edited.collection).toEqual(sourceSnapshot);
    expect(
      batchOutputLayers(output, [normalizeSourceDataset(edited)])[0].collection
        .features,
    ).toHaveLength(1);
  });

  it("resolves generated targets and supports whole-part exclusion and clearing overrides", () => {
    const source = makeDataset();
    const key = source.feature_keys[0];
    const result = resultFor(source, 1);
    const output = {
      results: [result],
      total: 1,
      completed: 1,
      dataset_revisions: { roads: source.revision ?? 1 },
      scene_key: "scene",
      issues: [],
    };
    const layers = batchOutputLayers(output, [source]);
    const targets = resolveGeneratedComponentTargets(layers, {
      dataset_id: "roads",
      feature_key: key,
      part_index: 1,
    });
    expect(targets).toHaveLength(2);
    expect(targets[0].selector).toMatchObject({
      component: "车道",
      part_index: 1,
      lane_index: 0,
    });
    expect(
      featureMatchesSelector(targets[0].feature, targets[0].selector, "车道"),
    ).toBe(true);

    const excluded = setPartExcluded(source, key, 1, true);
    expect(
      batchOutputLayers(output, [excluded])[0].collection.features,
    ).toHaveLength(0);
    expect(dropOverride(excluded, key).route_overrides?.[key]).toBeUndefined();
  });

  it("filters plain layers immutably", () => {
    const lane = polygonFeature({ component: "lane", part_index: 2 });
    const shoulder = polygonFeature({ component: "shoulder", part_index: 2 });
    const features = [lane, shoulder];
    const layer = {
      name: "roads",
      crs: "EPSG:32650",
      collection: { type: "FeatureCollection", features } as FeatureCollection,
    };
    const filtered = filterGeneratedComponentLayers(
      [layer],
      [{ component: "lane", part_index: 2 }],
    );
    expect(filtered[0].collection.features).toEqual([shoulder]);
    expect(layer.collection.features).toEqual(features);
  });

  it("resets only one part and treats missing part indexes as the single line part", () => {
    const source = makeDataset();
    const key = source.feature_keys[0];
    const sectionForPart = { ...section, right_lanes: [4] };
    const withPartEdits = setPartComponentExclusion(
      setPartComponentExclusion(
        setPartSection(source, key, 0, sectionForPart),
        key,
        0,
        { component: "lane" },
        true,
      ),
      key,
      1,
      { component: "shoulder" },
      true,
    );
    const reset = resetPartEdits(withPartEdits, key, 0);
    expect(reset.route_overrides?.[key]).toMatchObject({
      part_sections: {},
      component_exclusions: [{ component: "shoulder", part_index: 1 }],
    });

    const simple = polygonFeature({ component: "lane" });
    expect(
      featureMatchesSelector(simple, { component: "lane", part_index: 0 }),
    ).toBe(true);
    expect(
      featureMatchesSelector(simple, { component: "lane", part_index: 1 }),
    ).toBe(false);
  });
});
