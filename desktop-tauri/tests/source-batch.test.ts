import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection } from "geojson";
import { defaultProject, type RouteSection } from "../src/domain";
import type { SourceBinding } from "../src/workbench/connections";
import {
  appendDataset,
  batchOutputLayers,
  makeSourceBatchOutput,
  mappedSectionForFeature,
  normalizeSourceDataset,
  prepareSourceBatch,
  removeDatasetFeatures,
  setDatasetIncluded,
  type SourceDataset,
} from "../src/workbench/sourceBatch";

const manual: RouteSection = {
  left_lanes: [3.5, 3.5],
  right_lanes: [3.5],
  median_width: 1.5,
  left_emergency_width: 2,
  right_emergency_width: 2,
  left_shoulder_width: 0.5,
  right_shoulder_width: 0.5,
  left_slope_width: 0,
  right_slope_width: 0,
};

function feature(
  id: string | number,
  coordinates: number[][],
  properties: Record<string, unknown> = { route_id: "R-1" },
): Feature {
  return {
    type: "Feature",
    id,
    properties,
    geometry: { type: "LineString", coordinates },
  };
}

function dataset(
  features: Feature[],
  overrides: Partial<SourceDataset> = {},
): SourceDataset {
  const collection: FeatureCollection = { type: "FeatureCollection", features };
  return normalizeSourceDataset({
    id: "roads",
    kind: "route-source",
    source_label: "路网",
    label: "路网图层",
    collection,
    fields: [],
    binding: null,
    visible: true,
    manual_section: manual,
    ...overrides,
  });
}

describe("source dataset maintenance", () => {
  it("keeps unchanged task signatures across appends and invalidates only edited attributes", () => {
    const first = feature("a", [
      [116, 40],
      [116.01, 40],
    ]);
    const initial = dataset([first]);
    const project = defaultProject();
    const before = prepareSourceBatch([initial], project).tasks;
    const appended = appendDataset(
      initial,
      [
        feature("b", [
          [116.02, 40],
          [116.03, 40],
        ]),
      ],
      "路网",
      [],
      undefined,
      { manual_section: manual },
      () => "unused",
    );
    const after = prepareSourceBatch([appended], project).tasks;
    expect(after[0].input_signature).toBe(before[0].input_signature);
    const edited = structuredClone(appended);
    edited.collection.features[0].properties = {
      route_id: "R-1",
      note: "changed",
    };
    const changed = prepareSourceBatch([edited], project).tasks;
    expect(changed[0].input_signature).not.toBe(after[0].input_signature);
    expect(changed[1].input_signature).toBe(after[1].input_signature);
    const displayOnly = {
      ...project,
      scene_options: {
        ...project.scene_options,
        surface_type: "concrete",
        render_mode: "components",
      },
    };
    expect(
      prepareSourceBatch([appended], displayOnly).tasks[0].input_signature,
    ).toBe(after[0].input_signature);
  });
  it("normalizes legacy route layers with stable keys and appends same-source data without overwriting", () => {
    const first = feature("a", [
      [116, 40],
      [116.01, 40],
    ]);
    const legacy = dataset([first]);
    const appended = appendDataset(
      legacy,
      [
        first,
        feature("a", [
          [116, 40],
          [116.02, 40],
        ]),
      ],
      "路网",
      ["route_id"],
      undefined,
      { manual_section: manual },
      () => "new-id",
    );

    expect(appended.id).toBe("roads");
    expect(appended.collection.features).toHaveLength(2);
    expect(new Set(appended.feature_keys).size).toBe(2);
    expect(appended.collection.features[0]).toEqual(first);
  });

  it("uses content fingerprints without FID and keeps conflicting FIDs as separate records", () => {
    const first = feature("same", [
      [116, 40],
      [116.01, 40],
    ]);
    const changed = feature("same", [
      [116, 40],
      [116.02, 40],
    ]);
    const result = appendDataset(
      dataset([]),
      [first, first, changed],
      "路网",
      [],
      undefined,
      { manual_section: manual },
      () => "new-id",
    );
    expect(result.collection.features).toHaveLength(2);
    expect(result.feature_keys[0]).not.toBe(result.feature_keys[1]);

    const noId = feature("ignored", [
      [116, 40],
      [116.01, 40],
    ]);
    delete noId.id;
    const noIdResult = appendDataset(
      dataset([]),
      [noId, structuredClone(noId)],
      "路网",
      [],
      undefined,
      {},
      () => "new-id",
    );
    expect(noIdResult.collection.features).toHaveLength(1);
  });

  it("removes selected records and toggles participation by stable feature key", () => {
    const source = dataset([
      feature("a", [
        [116, 40],
        [116.01, 40],
      ]),
      feature("b", [
        [117, 40],
        [117.01, 40],
      ]),
    ]);
    const excluded = setDatasetIncluded(
      source,
      [source.feature_keys[0]],
      false,
    );
    expect(excluded.excluded_keys).toEqual([source.feature_keys[0]]);
    const removed = removeDatasetFeatures(excluded, [source.feature_keys[1]]);
    expect(removed.feature_keys).toEqual([source.feature_keys[0]]);
    expect(removed.collection.features).toHaveLength(1);
    expect(removed.excluded_keys).toEqual([source.feature_keys[0]]);
  });
});

describe("source batch preparation", () => {
  it("makes one UTM task per multiline part and preserves the 2D part boundaries", () => {
    const source = dataset([
      {
        type: "Feature",
        id: "multi",
        properties: { route_id: "R-M" },
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
              [117.02, 40],
            ],
          ],
        },
      },
    ]);
    const { tasks, issues } = prepareSourceBatch([source], defaultProject());
    expect(issues).toEqual([]);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.part_index)).toEqual([0, 1]);
    expect(tasks[0].request.route_id).toBe("R-M");
    expect(tasks[0].request.crs).toMatch(/^EPSG:326/);
    expect(tasks[0].request.points).toHaveLength(2);
    expect(tasks[1].request.points).toHaveLength(3);
  });

  it("maps each feature strictly and honors per-feature part and section overrides", () => {
    const source = dataset(
      [
        feature(
          "a",
          [
            [116, 40],
            [116.01, 40],
          ],
          { route_id: "R-A", left_count: null, left_width: 3.5 },
        ),
      ],
      {
        mapping: {
          route_id: "route_id",
          left_lane_count: "left_count",
          left_lane_width: "left_width",
          mapping_null_fallback: true,
        },
        route_overrides: {
          [dataset([
            feature(
              "a",
              [
                [116, 40],
                [116.01, 40],
              ],
              { route_id: "R-A", left_count: null, left_width: 3.5 },
            ),
          ]).feature_keys[0]]: {
            parts: {
              "0": [
                [118, 40],
                [118.01, 40],
                [118.02, 40],
              ],
            },
            section: { ...manual, left_lanes: [4] },
          },
        },
      },
    );
    const result = prepareSourceBatch([source], defaultProject());
    expect(result.issues).toEqual([]);
    expect(result.tasks[0].request.points).toHaveLength(3);
    expect(result.tasks[0].request.section.left_lanes).toEqual([4]);
    expect(result.tasks[0].request.route_id).toBe("R-A");

    const missingMapping = dataset(
      [
        feature(
          "b",
          [
            [116, 40],
            [116.01, 40],
          ],
          { route_id: "R-B" },
        ),
      ],
      { mapping: { left_lane_width: "missing_column" } },
    );
    const failed = prepareSourceBatch([missingMapping], defaultProject());
    expect(failed.tasks).toHaveLength(0);
    expect(failed.issues[0].message).toContain("missing_column");
  });

  it("prefers a per-part section and changes only that part's generation signature", () => {
    const source = dataset([
      {
        type: "Feature",
        id: "multi-section",
        properties: { route_id: "R-M" },
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
      },
    ]);
    const key = source.feature_keys[0];
    const baseline = prepareSourceBatch([source], defaultProject()).tasks;
    const partSection = {
      ...manual,
      left_lanes: [4, 4],
      right_lanes: [3],
      left_shoulder_width: 1.25,
    };
    const edited = {
      ...source,
      route_overrides: {
        [key]: {
          section: { ...manual },
          part_sections: { "1": partSection },
        },
      },
    };
    const tasks = prepareSourceBatch([edited], defaultProject()).tasks;
    expect(tasks[0].request.section.left_lanes).toEqual([3.5, 3.5]);
    expect(tasks[1].request.section).toEqual(partSection);
    expect(tasks[0].input_signature).toBe(baseline[0].input_signature);
    expect(tasks[1].input_signature).not.toBe(baseline[1].input_signature);
  });

  it("preserves long parts completely and filters excluded keys", () => {
    const long = Array.from({ length: 2_001 }, (_item, index) => [
      116 + index / 1_000_000,
      40,
    ]);
    const source = dataset([
      feature("long", long),
      feature("excluded", [
        [117, 40],
        [117.01, 40],
      ]),
    ]);
    const selected = setDatasetIncluded(
      source,
      [source.feature_keys[1]],
      false,
    );
    const result = prepareSourceBatch([selected], defaultProject());
    expect(result.tasks).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
    expect(result.tasks[0].request.points).toHaveLength(2_001);
    expect(
      (selected.collection.features[0].geometry as any).coordinates,
    ).toHaveLength(2_001);
  });

  it("uses raw feature identity as fallback route ID and carries output provenance", () => {
    const source = dataset([
      feature(
        42,
        [
          [116, 40],
          [116.01, 40],
        ],
        {},
      ),
    ]);
    const task = prepareSourceBatch([source], defaultProject()).tasks[0];
    expect(task.request.route_id).toBe("42");
    const output = makeSourceBatchOutput(
      [
        {
          key: task.key,
          dataset_id: task.dataset_id,
          feature_key: task.feature_key,
          part_index: task.part_index,
          input_signature: task.input_signature,
          source_properties: task.source_properties,
          response: {
            projected_crs: task.request.crs,
            feature_collection: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: { component: "lane" },
                  geometry: { type: "Polygon", coordinates: [] },
                },
              ],
            },
          },
        },
      ],
      1,
      { datasets: [source], scene_key: "scene-v1" },
    );
    const layers = batchOutputLayers(output, [source]);
    expect(output).toMatchObject({
      total: 1,
      completed: 1,
      scene_key: "scene-v1",
      dataset_revisions: { roads: 1 },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0].crs).toBe(task.request.crs);
    expect(layers[0].collection.features[0].properties).toMatchObject({
      source_dataset_id: "roads",
      source_feature_key: task.feature_key,
      part_index: 0,
      source_attributes: {},
    });
  });

  it("groups response components, keeps CRS-specific layers separate, and does not mutate native output", () => {
    const source = dataset([
      feature("group", [
        [116, 40],
        [116.01, 40],
      ]),
    ]);
    const task = prepareSourceBatch([source], defaultProject()).tasks[0];
    const sameNameLayers = [
      {
        name: "车道",
        crs: "EPSG:32650",
        collection: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Polygon", coordinates: [] },
            },
          ],
        },
      },
      {
        name: "车道",
        crs: "EPSG:32651",
        collection: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Polygon", coordinates: [] },
            },
          ],
        },
      },
    ];
    const ancillary = [
      {
        name: "中心线",
        crs: "EPSG:4326",
        collection: { type: "FeatureCollection", features: [] },
      },
    ];
    const result = {
      key: task.key,
      dataset_id: task.dataset_id,
      feature_key: task.feature_key,
      part_index: task.part_index,
      input_signature: task.input_signature,
      source_properties: task.source_properties,
      response: {
        layers: sameNameLayers,
        ancillary_layers: ancillary,
      },
    };
    const layers = batchOutputLayers(makeSourceBatchOutput([result], 1), [
      source,
    ]);
    expect(layers.map((layer) => layer.name)).toEqual([
      "路网图层 · 车道 (EPSG:32650)",
      "路网图层 · 车道 (EPSG:32651)",
      "路网图层 · 中心线",
    ]);
    expect(sameNameLayers).toHaveLength(2);
    expect(ancillary).toHaveLength(1);
  });
});

describe("section mapping validation", () => {
  it("enforces lane count and finite non-negative widths", () => {
    const featureValue = feature(
      "x",
      [
        [116, 40],
        [116.01, 40],
      ],
      {
        count: 9,
        width: 3.5,
      },
    );
    expect(() =>
      mappedSectionForFeature(
        featureValue,
        { left_lane_count: "count", left_lane_width: "width" },
        manual,
      ),
    ).toThrow("0～8");
    expect(() =>
      mappedSectionForFeature(
        featureValue,
        { median_width: "missing" },
        manual,
      ),
    ).toThrow("不存在");
    expect(() =>
      mappedSectionForFeature(
        feature(
          "x",
          [
            [116, 40],
            [116.01, 40],
          ],
          { median: Infinity },
        ),
        { median_width: "median" },
        manual,
      ),
    ).toThrow("有限非负");
  });
});
