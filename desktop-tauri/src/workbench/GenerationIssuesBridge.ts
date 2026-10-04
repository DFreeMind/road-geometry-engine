import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { GenerationIssueRow } from "./GenerationIssuesPanel";

type IssueSnapshot = {
  revision: number;
  working: boolean;
  rows: Array<{
    id: string;
    datasetId: string;
    featureKey?: string;
    partIndex?: number;
    stage: GenerationIssueRow["stage"];
    message: string;
    code: string;
    sourceLabel: string;
    routeLabel: string;
  }>;
};

type GenerationIssueCallbacks = {
  onRetry: (rows: GenerationIssueRow[]) => void;
  onLocate: (row: GenerationIssueRow) => void;
  onEdit: (row: GenerationIssueRow) => void;
  onMapping: (row: GenerationIssueRow) => void;
};

type IssueAction =
  | { kind: "locate" | "edit" | "mapping" | "retry"; id: string }
  | { kind: "retryMany"; ids: string[] };

let lastRevision = 0;

export function createIssueSnapshot(
  rows: GenerationIssueRow[],
  working: boolean,
): IssueSnapshot {
  lastRevision = Math.max(Date.now(), lastRevision + 1);
  return {
    revision: lastRevision,
    working,
    rows: rows.map((row) => ({
      id: row.id,
      datasetId: row.dataset_id,
      featureKey: row.feature_key,
      partIndex: row.part_index,
      stage: row.stage,
      message: row.message,
      code: row.code,
      sourceLabel: row.sourceLabel,
      routeLabel: row.routeLabel,
    })),
  };
}

export function useGenerationIssuesBridge(
  rows: GenerationIssueRow[],
  working: boolean,
  callbacks: GenerationIssueCallbacks,
) {
  const currentRef = useRef({ rows, working, ...callbacks });
  currentRef.current = { rows, working, ...callbacks };

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<IssueAction>("generation-issues:action", ({ payload }) => {
      const current = currentRef.current;
      if (payload.kind === "locate") {
        const row = current.rows.find((item) => item.id === payload.id);
        if (row) current.onLocate(row);
        return;
      }

      if (current.working) return;
      if (payload.kind === "retryMany") {
        const wanted = new Set(payload.ids);
        const selected = current.rows.filter(
          (row) => wanted.has(row.id) && row.stage !== "review",
        );
        if (selected.length > 0) current.onRetry(selected);
        return;
      }

      const row = current.rows.find((item) => item.id === payload.id);
      if (!row) return;
      if (payload.kind === "edit") current.onEdit(row);
      else if (payload.kind === "mapping") current.onMapping(row);
      else if (payload.kind === "retry" && row.stage !== "review") {
        current.onRetry([row]);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("sync_generation_issues_window", {
      snapshot: createIssueSnapshot(rows, working),
    }).catch((error) => {
      console.error("同步生成问题摘要失败", error);
    });
  }, [rows, working]);
}
