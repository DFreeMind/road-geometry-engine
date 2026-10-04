import { describe, expect, it } from "vitest";
import {
  generationIssueRows,
  generationReviewIssues,
  generationTargetMatcher,
  matchesGenerationTarget,
  mergeGenerationFailures,
} from "./generationIssues";
import type {
  SourceDataset,
  SourceBatchTask,
  SourceBatchResult,
} from "./sourceBatch";

const dataset: SourceDataset = {
  id: "source",
  kind: "route-source",
  label: "测试表",
  source_label: "本地",
  visible: true,
  fields: [],
  feature_keys: ["a", "b"],
  collection: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { roadname: "整条路" },
        geometry: {
          type: "LineString",
          coordinates: [
            [116, 40],
            [116.01, 40],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "碎段" },
        geometry: {
          type: "LineString",
          coordinates: [
            [116, 40],
            [116.01, 40],
          ],
        },
      },
    ],
  },
};
const target = { dataset_id: "source", feature_key: "a", part_index: 0 };
const failure = { ...target, code: "engine_error", message: "无效几何" };

describe("生成问题与定向重试", () => {
  it("局部修复提示属于复核，不冒充失败或恢复过期成果提示", () => {
    const output = {
      dataset_revisions: { source: 0 },
      results: [
        {
          ...target,
          key: "a",
          response: {
            geometry_warnings: [
              {
                code: "offset_local_loop_trimmed",
                message: "局部修剪需复核",
                source_point_start: 2,
                source_point_end: 4,
              },
            ],
          },
        } as SourceBatchResult,
      ],
    };
    const reviews = generationReviewIssues(output, [dataset]);
    const rows = generationIssueRows([dataset], [], [], reviews);
    expect(rows[0].stage).toBe("review");
    expect(rows[0].code).toBe("offset_local_loop_trimmed");
    expect(
      generationReviewIssues(output, [{ ...dataset, revision: 1 }]),
    ).toEqual([]);
    expect(
      generationIssueRows(
        [{ ...dataset, excluded_keys: ["a"] }],
        [],
        [],
        reviews,
      ),
    ).toEqual([]);
  });
  it("部件重试不扩大到其他部件或来源，记录级重试涵盖所有部件", () => {
    for (const targets of [
      [target],
      [{ dataset_id: "source" }],
      [{ dataset_id: "source", part_index: 1 }],
      [{ ...target, part_index: 1 }],
    ]) {
      const matcher = generationTargetMatcher(targets);
      for (const item of [
        target,
        { ...target, part_index: 1 },
        { ...target, feature_key: "b" },
        { ...target, dataset_id: "other" },
      ])
        expect(matcher(item)).toBe(matchesGenerationTarget(item, targets));
    }
    expect(
      matchesGenerationTarget(target, [{ ...target, part_index: 1 }]),
    ).toBe(false);
    expect(
      matchesGenerationTarget(target, [
        { dataset_id: "source", feature_key: "a" },
      ]),
    ).toBe(true);
    expect(matchesGenerationTarget(target, [{ dataset_id: "other" }])).toBe(
      false,
    );
  });
  it("成功重试移除对应失败，保留未处理部件并更新新原因", () => {
    const second = { ...failure, part_index: 1 };
    const task = { ...target, key: "a/0" } as SourceBatchTask;
    const success = {
      ...task,
      response: { features: [] },
    } as SourceBatchResult;
    expect(
      mergeGenerationFailures([failure, second], [task], [success], [dataset]),
    ).toEqual([second]);
    const result = { ...task, error: "新原因" } as SourceBatchResult;
    expect(
      mergeGenerationFailures(
        [failure, second],
        [task],
        [result],
        [dataset],
      ).map((row) => row.message),
    ).toEqual(["无效几何", "新原因"]);
  });
  it("移除或排除记录后不再显示其失败，仍参与的记录保留", () => {
    expect(
      generationIssueRows(
        [{ ...dataset, excluded_keys: ["a"] }],
        [],
        [failure],
      ),
    ).toEqual([]);
    expect(generationIssueRows([], [], [failure])).toEqual([]);
    const rows = generationIssueRows(
      [dataset],
      [{ ...failure, code: "mapping_error" }],
      [failure],
    );
    expect(rows.map((row) => row.stage)).toEqual(["validation", "generation"]);
    expect(rows[0].routeLabel).toBe("整条路 · 记录 1");
    expect(rows[0].sourceLabel).toBe("测试表");
  });
  it("超过100条仍保留完整记录及完整原因", () => {
    const issues = Array.from({ length: 125 }, (_, index) => ({
      ...failure,
      part_index: index,
      message: `原因${index}`,
    }));
    const rows = generationIssueRows([dataset], issues, []);
    expect(rows).toHaveLength(125);
    expect(rows[124].message).toBe("原因124");
    expect(new Set(rows.map((row) => row.id)).size).toBe(125);
  });
});
