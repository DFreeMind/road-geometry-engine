import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  GenerationIssuesPanel,
  type GenerationIssueRow,
} from "./GenerationIssuesPanel";

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

const EMPTY_SNAPSHOT: IssueSnapshot = {
  revision: -1,
  working: false,
  rows: [],
};

function displayRows(snapshot: IssueSnapshot): GenerationIssueRow[] {
  return snapshot.rows.map((row) => ({
    id: row.id,
    dataset_id: row.datasetId,
    feature_key: row.featureKey,
    part_index: row.partIndex,
    stage: row.stage,
    message: row.message,
    code: row.code,
    sourceLabel: row.sourceLabel,
    routeLabel: row.routeLabel,
  }));
}

export function GenerationIssuesWindow() {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const applySnapshot = (next: IssueSnapshot | null) => {
      if (disposed || !next) return;
      setLoadError(null);
      setSnapshot((current) =>
        next.revision >= current.revision ? next : current,
      );
    };

    // 先监听后读取，避免窗口初始化期间遗漏主窗口更新；失败时明确显示原因。
    void (async () => {
      try {
        const stop = await listen<IssueSnapshot>(
          "generation-issues:snapshot",
          ({ payload }) => applySnapshot(payload),
        );
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        const initial = await invoke<IssueSnapshot | null>(
          "get_generation_issues_snapshot",
        );
        if (!initial)
          throw new Error("主窗口尚未提供问题摘要，请关闭后重新打开。");
        applySnapshot(initial);
      } catch (error) {
        if (!disposed) setLoadError(String(error));
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  function sendAction(action: Record<string, unknown>) {
    void invoke("submit_generation_issue_action", { action });
  }

  const rows = displayRows(snapshot);
  return (
    <main className="generation-issues-detached-root">
      {loadError && (
        <div className="generation-issues-window__load-error" role="alert">
          生成问题加载失败：{loadError}
        </div>
      )}
      <GenerationIssuesPanel
        rows={rows}
        working={snapshot.working}
        detached
        onLocate={(row) => sendAction({ kind: "locate", id: row.id })}
        onEdit={(row) => sendAction({ kind: "edit", id: row.id })}
        onMapping={(row) => sendAction({ kind: "mapping", id: row.id })}
        onRetry={(retryRows) =>
          sendAction({ kind: "retryMany", ids: retryRows.map((row) => row.id) })
        }
      />
    </main>
  );
}
