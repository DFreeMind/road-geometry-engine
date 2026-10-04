import type {
  SourceBatchIssue,
  SourceBatchResult,
  SourceBatchTask,
  SourceDataset,
} from "./sourceBatch";

export type GenerationTarget = Pick<
  SourceBatchIssue,
  "dataset_id" | "feature_key" | "part_index"
>;

// 编译查找表，避免大量失败重试时对每个任务遍历整个错误列表。
export function generationTargetMatcher(targets: GenerationTarget[]) {
  const keys = new Set(
    targets.map((target) =>
      JSON.stringify([
        target.dataset_id,
        target.feature_key ?? null,
        target.part_index ?? null,
      ]),
    ),
  );
  return (item: GenerationTarget) =>
    keys.has(
      JSON.stringify([
        item.dataset_id,
        item.feature_key ?? null,
        item.part_index ?? null,
      ]),
    ) ||
    keys.has(
      JSON.stringify([item.dataset_id, item.feature_key ?? null, null]),
    ) ||
    keys.has(
      JSON.stringify([item.dataset_id, null, item.part_index ?? null]),
    ) ||
    keys.has(JSON.stringify([item.dataset_id, null, null]));
}

export function matchesGenerationTarget(
  item: GenerationTarget,
  targets: GenerationTarget[],
): boolean {
  return targets.some(
    (target) =>
      target.dataset_id === item.dataset_id &&
      (target.feature_key === undefined ||
        target.feature_key === item.feature_key) &&
      (target.part_index === undefined ||
        target.part_index === item.part_index),
  );
}

export function participatingIssue(
  issue: GenerationTarget,
  datasets: SourceDataset[],
): boolean {
  const dataset = datasets.find((item) => item.id === issue.dataset_id);
  return Boolean(
    dataset &&
      (issue.feature_key === undefined ||
        (dataset.feature_keys.includes(issue.feature_key) &&
          !dataset.excluded_keys?.includes(issue.feature_key))),
  );
}

function issueDatasetIndex(datasets: SourceDataset[]) {
  return new Map(
    datasets.map((dataset) => [
      dataset.id,
      {
        dataset,
        indexes: new Map(
          dataset.feature_keys.map((key, index) => [key, index]),
        ),
        excluded: new Set(dataset.excluded_keys ?? []),
      },
    ]),
  );
}

// 重试只清理本次实际处理的部件；其他失败不因刷新结果而消失。
export function mergeGenerationFailures(
  previous: SourceBatchIssue[],
  attempted: SourceBatchTask[],
  results: SourceBatchResult[],
  datasets: SourceDataset[],
): SourceBatchIssue[] {
  const attemptedTarget = generationTargetMatcher(attempted);
  const index = issueDatasetIndex(datasets);
  return [
    ...previous.filter((issue) => {
      const source = index.get(issue.dataset_id);
      return (
        source &&
        (issue.feature_key === undefined ||
          (source.indexes.has(issue.feature_key) &&
            !source.excluded.has(issue.feature_key))) &&
        !attemptedTarget(issue)
      );
    }),
    ...results
      .filter((result) => result.error || !result.response)
      .map((result) => ({
        dataset_id: result.dataset_id,
        feature_key: result.feature_key,
        part_index: result.part_index,
        code: "engine_error",
        message: result.error || "引擎未返回该部件成果。",
      })),
  ];
}

export function generationIssueRows(
  datasets: SourceDataset[],
  validation: SourceBatchIssue[],
  failures: SourceBatchIssue[],
  reviews: SourceBatchIssue[] = [],
) {
  const sourceIndex = issueDatasetIndex(datasets);
  return [
    ...validation.map((issue) => ({ ...issue, stage: "validation" as const })),
    ...failures.map((issue) => ({ ...issue, stage: "generation" as const })),
    ...reviews.map((issue) => ({ ...issue, stage: "review" as const })),
  ]
    .filter((issue) => {
      const source = sourceIndex.get(issue.dataset_id);
      return (
        source &&
        (issue.feature_key === undefined ||
          (source.indexes.has(issue.feature_key) &&
            !source.excluded.has(issue.feature_key)))
      );
    })
    .map((issue, index) => {
      const source = sourceIndex.get(issue.dataset_id)!;
      const dataset = source.dataset;
      const featureIndex = source.indexes.get(issue.feature_key ?? "") ?? -1;
      const properties =
        dataset.collection.features[featureIndex]?.properties ?? {};
      const mapped = dataset.mapping?.route_id;
      const label =
        (typeof mapped === "string" ? properties[mapped] : undefined) ??
        properties.roadname ??
        properties.name ??
        properties.route_id ??
        issue.feature_key ??
        "来源任务";
      return {
        ...issue,
        id: `${issue.stage}/${issue.dataset_id}/${issue.feature_key ?? ""}/${issue.part_index ?? ""}/${index}`,
        sourceLabel: dataset.label,
        routeLabel:
          featureIndex >= 0
            ? `${String(label)} · 记录 ${featureIndex + 1}`
            : String(label),
      };
    });
}

// 修复提示仍是成功成果的质量记录，不能混入失败重试队列。
export function generationReviewIssues(
  output:
    | {
        results: SourceBatchResult[];
        dataset_revisions: Record<string, number>;
      }
    | null
    | undefined,
  datasets: SourceDataset[],
): SourceBatchIssue[] {
  if (!output) return [];
  const revisions = new Map(
    datasets.map((dataset) => [dataset.id, dataset.revision ?? 0]),
  );
  return output.results.flatMap((result) => {
    if (
      result.error ||
      !result.response ||
      revisions.get(result.dataset_id) !==
        output.dataset_revisions[result.dataset_id]
    )
      return [];
    const warnings = (result.response as { geometry_warnings?: unknown[] })
      .geometry_warnings;
    if (!Array.isArray(warnings)) return [];
    return warnings.flatMap((raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        !("message" in raw) ||
        typeof raw.message !== "string"
      )
        return [];
      const warning = raw as Record<string, unknown>;
      const extent =
        typeof warning.station_start_m === "number" &&
        typeof warning.station_end_m === "number"
          ? `；几何里程估算 ${warning.station_start_m.toFixed(2)}–${warning.station_end_m.toFixed(2)} m（非业务桩号）`
          : "";
      const offset =
        typeof warning.offset_m === "number"
          ? `；偏移 ${warning.offset_m.toFixed(2)} m`
          : "";
      const indexes =
        typeof warning.source_point_start === "number" &&
        typeof warning.source_point_end === "number"
          ? `；源控制点 ${warning.source_point_start + 1}–${warning.source_point_end + 1}`
          : "";
      return [
        {
          ...raw,
          dataset_id: result.dataset_id,
          feature_key: result.feature_key,
          part_index: result.part_index,
          code:
            "code" in raw && typeof raw.code === "string"
              ? raw.code
              : "geometry_review",
          message: raw.message + offset + indexes + extent,
        },
      ];
    });
  });
}
