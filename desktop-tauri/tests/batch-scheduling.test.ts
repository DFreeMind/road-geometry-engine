import { describe, expect, it } from "vitest";
import {
  generationChunks,
  reusableResults,
} from "../src/workbench/batchScheduling";
import type { SourceBatchTask } from "../src/workbench/sourceBatch";

const task = (key: string, signature = key): SourceBatchTask => ({
  key,
  dataset_id: "source",
  feature_key: key,
  part_index: 0,
  input_signature: signature,
  source_properties: {},
  request: {
    route_id: key,
    points: [
      [1, 2],
      [3, 4],
    ],
    crs: "EPSG:32650",
    source: "test",
    section: {
      left_lanes: [3],
      right_lanes: [],
      median_width: 0,
      left_emergency_width: 0,
      right_emergency_width: 0,
      left_shoulder_width: 0,
      right_shoulder_width: 0,
      left_slope_width: 0,
      right_slope_width: 0,
    },
    scene_options: {},
  },
});

describe("complete generation scheduling", () => {
  it("schedules every fragment beyond the former 10000 limit", () => {
    const tasks = Array.from({ length: 10001 }, (_, index) =>
      task(String(index)),
    );
    const chunks = generationChunks(tasks);
    expect(chunks.flat()).toEqual(tasks);
    expect(chunks.every((chunk) => chunk.length <= 256)).toBe(true);
  });
  it("bounds bytes without silently dropping a large single route", () => {
    const tasks = [task("一"), task("二"), task("三")];
    expect(generationChunks(tasks, 256, 1)).toEqual(
      tasks.map((item) => [item]),
    );
  });
  it("reuses only successful unchanged fragments", () => {
    const tasks = [task("a"), task("b", "changed"), task("c"), task("d")];
    const previous = tasks.map((item) => ({
      ...item,
      input_signature: item.key,
      response: {},
    }));
    Object.assign(previous[2], { error: "failed" });
    Object.assign(previous[3], { response: undefined });
    expect([...reusableResults(tasks, previous).keys()]).toEqual(["a"]);
  });
});
