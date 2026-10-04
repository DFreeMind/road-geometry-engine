import { describe, expect, it } from "vitest";
import { transformPosition } from "../src/domain";
import {
  prepareOutputDisplay,
  type OutputDisplayLayer,
} from "../src/workbench/mapDisplay";
import { processMapDisplayWorkerMessage } from "../src/workbench/mapDisplayWorker";

const projectedCrs = "EPSG:32650";

function lineFeature(
  coordinates: number[][],
  properties: Record<string, unknown> = {},
): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    properties,
    geometry: { type: "LineString", coordinates },
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freezeDeep);
  }
  return value;
}

describe("prepareOutputDisplay", () => {
  it("将投影坐标转为 WGS84，并只复制地图绘制与追溯属性", () => {
    const source: OutputDisplayLayer = {
      name: "车道",
      crs: projectedCrs,
      collection: {
        type: "FeatureCollection",
        features: [
          lineFeature(
            [
              [500000, 0],
              [500100, 0],
            ],
            {
              component: "lane",
              side: "left",
              lane_index: 1,
              source_dataset_id: "dataset-a",
              source_feature_key: "feature-a",
              part_index: 0,
              route_id: "route-a",
              source_attributes: { wide: "attribute payload" },
              arbitrary_field: "discard me",
            },
          ),
        ],
      },
    };
    const result = prepareOutputDisplay([source]);
    const feature = result.collection.features[0];
    const expected = transformPosition([500000, 0], projectedCrs, "EPSG:4326");

    expect(feature.geometry?.type).toBe("LineString");
    if (feature.geometry?.type !== "LineString")
      throw new Error("应为 LineString");
    expect(feature.geometry.coordinates[0][0]).toBeCloseTo(expected[0], 8);
    expect(feature.geometry.coordinates[0][1]).toBeCloseTo(expected[1], 8);
    expect(feature.properties).toEqual({
      component: "lane",
      side: "left",
      lane_index: 1,
      source_dataset_id: "dataset-a",
      source_feature_key: "feature-a",
      part_index: 0,
      route_id: "route-a",
      __output_layer: 0,
      __output_feature: 0,
    });
    expect(result.metrics).toEqual({
      feature_count: 1,
      coordinate_count: 2,
      source_layer_count: 1,
    });
  });

  it("合并多个来源、跳过空几何，并保留可追溯的来源与要素索引", () => {
    const layers: OutputDisplayLayer[] = [
      {
        name: "车道",
        crs: projectedCrs,
        collection: {
          type: "FeatureCollection",
          features: [
            lineFeature([
              [500000, 0],
              [500010, 0],
            ]),
            {
              type: "Feature",
              properties: { route_id: "empty" },
              geometry: null as unknown as GeoJSON.Geometry,
            },
            lineFeature([
              [500020, 0],
              [500030, 0],
            ]),
          ],
        },
      },
      {
        name: "路肩",
        crs: projectedCrs,
        collection: {
          type: "FeatureCollection",
          features: [
            lineFeature([
              [500040, 0],
              [500050, 0],
            ]),
          ],
        },
      },
      {
        name: "空成果图层",
        crs: projectedCrs,
        collection: { type: "FeatureCollection", features: [] },
      },
    ];

    const result = prepareOutputDisplay(layers);

    expect(result.collection.features).toHaveLength(3);
    expect(
      result.collection.features.map((feature) => feature.properties),
    ).toEqual([
      { __output_layer: 0, __output_feature: 0 },
      { __output_layer: 0, __output_feature: 2 },
      { __output_layer: 1, __output_feature: 0 },
    ]);
    expect(result.metrics).toEqual({
      feature_count: 3,
      coordinate_count: 6,
      source_layer_count: 3,
    });
  });

  it("不修改源成果对象或属性，并返回独立的几何与属性副本", () => {
    const source: OutputDisplayLayer = {
      name: "完整性检查",
      crs: projectedCrs,
      collection: {
        type: "FeatureCollection",
        features: [
          lineFeature(
            [
              [500000, 0],
              [500025, 0],
            ],
            {
              component: "lane",
              source_attributes: { nested: [1, 2, 3] },
            },
          ),
        ],
      },
    };
    const original = structuredClone(source);
    freezeDeep(source);

    const result = prepareOutputDisplay([source]);

    expect(source).toEqual(original);
    expect(result.collection).not.toBe(source.collection);
    expect(result.collection.features[0]).not.toBe(
      source.collection.features[0],
    );
    expect(result.collection.features[0].geometry).not.toBe(
      source.collection.features[0].geometry,
    );
  });

  it("完整保留长线的全部顶点，不在显示转换中简化", () => {
    const coordinates: [number, number][] = Array.from(
      { length: 12000 },
      (_, index) => [500000 + index, index % 3],
    );
    const result = prepareOutputDisplay([
      {
        name: "长路线",
        crs: projectedCrs,
        collection: {
          type: "FeatureCollection",
          features: [lineFeature(coordinates)],
        },
      },
    ]);
    const geometry = result.collection.features[0].geometry;

    expect(geometry?.type).toBe("LineString");
    if (geometry?.type !== "LineString") throw new Error("应为 LineString");
    expect(geometry.coordinates).toHaveLength(coordinates.length);
    expect(result.metrics.coordinate_count).toBe(coordinates.length);
    expect(geometry.coordinates[0]).toEqual(
      transformPosition(coordinates[0], projectedCrs, "EPSG:4326"),
    );
    expect(geometry.coordinates.at(-1)).toEqual(
      transformPosition(coordinates.at(-1)!, projectedCrs, "EPSG:4326"),
    );
  });

  it("递归转换 Point、Multi*、Polygon 与 GeometryCollection 的全部坐标", () => {
    const geometries: GeoJSON.Geometry[] = [
      { type: "Point", coordinates: [500000, 0] },
      {
        type: "MultiPoint",
        coordinates: [
          [500001, 0],
          [500002, 0],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [500003, 0],
          [500004, 0],
        ],
      },
      {
        type: "MultiLineString",
        coordinates: [
          [
            [500005, 0],
            [500006, 0],
          ],
          [
            [500007, 0],
            [500008, 0],
            [500009, 0],
          ],
        ],
      },
      {
        type: "Polygon",
        coordinates: [
          [
            [500010, 0],
            [500011, 0],
            [500011, 1],
            [500010, 0],
          ],
        ],
      },
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [500012, 0],
              [500013, 0],
              [500013, 1],
              [500012, 0],
            ],
          ],
          [
            [
              [500014, 0],
              [500015, 0],
              [500015, 1],
              [500014, 0],
            ],
          ],
        ],
      },
      {
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [500016, 0] },
          {
            type: "LineString",
            coordinates: [
              [500017, 0],
              [500018, 0],
            ],
          },
        ],
      },
    ];
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: geometries.map((geometry) => ({
        type: "Feature",
        properties: {},
        geometry,
      })),
    };

    const result = prepareOutputDisplay([
      { name: "多几何", crs: projectedCrs, collection },
    ]);

    expect(
      result.collection.features.map((feature) => feature.geometry?.type),
    ).toEqual(geometries.map((geometry) => geometry.type));
    expect(result.metrics.feature_count).toBe(geometries.length);
    expect(result.metrics.coordinate_count).toBe(25);
    for (const feature of result.collection.features) {
      expect(feature.geometry).not.toBeNull();
    }
  });

  it("在 Worker 内注册主线程传入的自定义 CRS 定义后再转换", () => {
    const crs = "CUSTOM:worker-mercator-test";
    const response = processMapDisplayWorkerMessage({
      revision: 19,
      crs_definitions: {
        [crs]: "+proj=merc +a=6378137 +b=6378137 +units=m +no_defs +type=crs",
      },
      layers: [
        {
          name: "自定义投影成果",
          crs,
          collection: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [111319.490793, 0] },
              },
            ],
          },
        },
      ],
    });

    expect(response.revision).toBe(19);
    if (!("value" in response)) throw new Error(response.error);
    const geometry = response.value.collection.features[0].geometry;
    expect(geometry?.type).toBe("Point");
    if (geometry?.type !== "Point") throw new Error("应为 Point");
    expect(geometry.coordinates[0]).toBeCloseTo(1, 5);
    expect(geometry.coordinates[1]).toBeCloseTo(0, 5);
  });

  it("自动支持非内置定义的北、南半球 WGS84 UTM CRS", () => {
    const samples = [
      {
        crs: "EPSG:32644",
        coordinate: [500000, 4649776.22482] as [number, number],
      },
      { crs: "EPSG:32756", coordinate: [500000, 10000000] as [number, number] },
    ];
    const result = prepareOutputDisplay(
      samples.map((sample) => ({
        name: sample.crs,
        crs: sample.crs,
        collection: {
          type: "FeatureCollection" as const,
          features: [
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "Point" as const,
                coordinates: sample.coordinate,
              },
            },
          ],
        },
      })),
    );

    const north = result.collection.features[0].geometry;
    const south = result.collection.features[1].geometry;
    if (north?.type !== "Point" || south?.type !== "Point") {
      throw new Error("应保留 Point 几何");
    }
    for (const [index, sample] of samples.entries()) {
      const point = result.collection.features[index].geometry;
      if (point?.type !== "Point") throw new Error("应保留 Point 几何");
      const expected = transformPosition(
        sample.coordinate,
        sample.crs,
        "EPSG:4326",
      );
      expect(point.coordinates[0]).toBeCloseTo(expected[0], 8);
      expect(point.coordinates[1]).toBeCloseTo(expected[1], 8);
    }
    expect(north.coordinates[0]).toBeCloseTo(81, 6);
    expect(north.coordinates[1]).toBeCloseTo(42, 5);
    expect(south.coordinates[0]).toBeCloseTo(153, 6);
    expect(south.coordinates[1]).toBeCloseTo(0, 6);
  });

  it("保留投影转换后的高程维度", () => {
    const result = prepareOutputDisplay([
      {
        name: "带高程点",
        crs: projectedCrs,
        collection: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: [500000, 0, 123.45] },
            },
          ],
        },
      },
    ]);
    const geometry = result.collection.features[0].geometry;

    expect(geometry?.type).toBe("Point");
    if (geometry?.type !== "Point") throw new Error("应为 Point");
    expect(geometry.coordinates[2]).toBe(123.45);
  });
});
