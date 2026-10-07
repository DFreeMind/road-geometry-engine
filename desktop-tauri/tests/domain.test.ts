import { describe, expect, it } from "vitest";
import type * as GeoJSON from "geojson";
import {
  acceptGeneration,
  basicCatalog,
  defaultProject,
  emptyProject,
  facilityFeature,
  markInputEdited,
  normalizeProject,
  resolveMappedValue,
  transformPosition,
} from "../src/domain";

describe("工程纯 domain 规则", () => {
  it("新建空工程不携带示例路线，并可保存恢复和独立修改断面", () => {
    const first = emptyProject(),
      second = emptyProject();
    expect(first.route_points).toEqual([]);
    expect(first.route_id).toBe("");
    expect(first.route_source).toBe("");
    expect(first.output).toBeNull();
    expect(
      normalizeProject(JSON.parse(JSON.stringify(first))).route_points,
    ).toEqual([]);
    first.section.left_lanes[0] = 4;
    expect(second.section.left_lanes[0]).toBe(3.5);
  });
  it("将 EPSG:32650 米制路线转换到 WGS84 并可往返", () => {
    const original: [number, number] = [448000, 4420000];
    const geographic = transformPosition(original, "EPSG:32650", "EPSG:4326");
    expect(geographic[0]).toBeCloseTo(116.39144941, 6);
    expect(geographic[1]).toBeCloseTo(39.92851159, 6);
    const roundTrip = transformPosition(geographic, "EPSG:4326", "EPSG:32650");
    expect(roundTrip[0]).toBeCloseTo(original[0], 5);
    expect(roundTrip[1]).toBeCloseTo(original[1], 5);
  });

  it("迁移旧 schema 1 并保留未知配置和空值映射", () => {
    const legacy = normalizeProject({
      schema_version: 1,
      route_id: "legacy",
      crs: "EPSG:32650",
      route_points: [
        [448000, 4420000],
        [448100, 4420050],
      ],
      route_source: "legacy-file",
      section: {
        left_lanes: [3.25, 3.5],
        right_lanes: [3.5],
        median_width: 1.2,
      },
      manual_section: { left_lanes: [3.5], right_lanes: [3.5] },
      manual_facilities: [
        {
          id: "m1",
          kind: "sign",
          x: 448010,
          y: 4420010,
          route_id: "legacy",
          vendor_note: null,
        },
      ],
      mapping_null_fallback: null,
      mapped_attributes: { route_id: null, width: 3.5 },
      future_plugin_data: { preserve: true },
    });
    expect(legacy.schema_version).toBe(2);
    expect(legacy.section.left_lanes).toEqual([3.25, 3.5]);
    expect(legacy.manual_facilities[0].template.subtype).toBe("警告标志");
    expect(legacy.manual_facilities[0].vendor_note).toBeNull();
    expect(legacy.mapping_null_fallback).toBeNull();
    expect(legacy.future_plugin_data).toEqual({ preserve: true });
  });

  it("将人工设施导出为 WGS84 并带模板来源快照", () => {
    const template = structuredClone(
      basicCatalog.find((entry) => entry.category === "标志")!,
    );
    const feature = facilityFeature(
      {
        id: "sign-1",
        kind: "catalog_abc",
        x: 448000,
        y: 4420000,
        confirmed: false,
        template,
      },
      "EPSG:32650",
    );
    expect(feature.geometry.type).toBe("Point");
    expect((feature.geometry as GeoJSON.Point).coordinates[0]).toBeCloseTo(
      116.39144941,
      6,
    );
    expect(feature.properties).toMatchObject({
      source: "manual_placement",
      confirmed: false,
      template_id: template.id,
      template_revision: 1,
    });
  });

  it("只接受当前生成 job 与当前输入版本的结果", () => {
    const project = defaultProject();
    const dirty = markInputEdited(project);
    const oldResult = acceptGeneration(
      dirty,
      "job-1",
      "job-1",
      { feature_collection: { type: "FeatureCollection", features: [] } },
      project.input_version,
    );
    expect(oldResult.output).toBeNull();
    const cancelled = acceptGeneration(dirty, "job-1", null, { stale: true });
    expect(cancelled.output).toBeNull();
    const accepted = acceptGeneration(
      dirty,
      "job-2",
      "job-2",
      { ok: true },
      dirty.input_version,
    );
    expect(accepted.output).toEqual({
      input_version: dirty.input_version,
      response: { ok: true },
    });
  });

  it("字段映射保留 nullable 语义，只有明确启用回退才使用手动值", () => {
    expect(
      resolveMappedValue({ width: 3.2 }, "width", false, 3.5),
    ).toMatchObject({ value: 3.2, mode: "field" });
    expect(() =>
      resolveMappedValue({ width: null }, "width", false, 3.5),
    ).toThrow("显式启用手动回退");
    expect(
      resolveMappedValue({ width: null }, "width", true, null),
    ).toMatchObject({ value: null, mode: "manual" });
  });
});
