import { useEffect, useMemo, useState } from "react";
import type { RouteSection } from "../domain";
import { Trash2, X } from "./Iconfont";
import "./GeneratedSurfaceEditor.css";

export type GeneratedSurfaceSelection = {
  label: string;
  componentLabel: string;
  partIndex?: number;
  scopeLabel?: string;
};

export type GeneratedSurfaceEditorProps = {
  selection: GeneratedSurfaceSelection;
  section: RouteSection;
  busy: boolean;
  onApply: (section: RouteSection) => void | Promise<void>;
  onDeleteComponent: () => void;
  onDeletePart: () => void;
  onReset: () => void;
  onClose: () => void;
};

export type GeneratedSurfaceDraft = {
  left_lanes: string[] | string;
  right_lanes: string[] | string;
  median_width: string;
  left_emergency_width: string;
  right_emergency_width: string;
  left_shoulder_width: string;
  right_shoulder_width: string;
  left_slope_width: string;
  right_slope_width: string;
};

export type GeneratedSurfaceValidation = {
  section?: RouteSection;
  errors: string[];
};

const WIDTH_FIELDS = [
  ["median_width", "中央隔离带宽度"],
  ["left_emergency_width", "左应急车道"],
  ["right_emergency_width", "右应急车道"],
  ["left_shoulder_width", "左路肩"],
  ["right_shoulder_width", "右路肩"],
  ["left_slope_width", "左边坡水平投影"],
  ["right_slope_width", "右边坡水平投影"],
] as const;

function sectionToDraft(section: RouteSection): GeneratedSurfaceDraft {
  return {
    left_lanes: [...section.left_lanes].map(String),
    right_lanes: [...section.right_lanes].map(String),
    median_width: String(section.median_width),
    left_emergency_width: String(section.left_emergency_width),
    right_emergency_width: String(section.right_emergency_width),
    left_shoulder_width: String(section.left_shoulder_width),
    right_shoulder_width: String(section.right_shoulder_width),
    left_slope_width: String(section.left_slope_width),
    right_slope_width: String(section.right_slope_width),
  };
}

function parseWidth(value: string, label: string, errors: string[]) {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed)) {
    errors.push(`${label}请输入有限数值。`);
    return 0;
  }
  if (parsed < 0) {
    errors.push(`${label}不能小于 0。`);
    return 0;
  }
  return parsed;
}

export function validateGeneratedSurfaceDraft(
  draft: GeneratedSurfaceDraft,
): GeneratedSurfaceValidation {
  const errors: string[] = [];
  const section = {} as RouteSection;
  for (const side of ["left", "right"] as const) {
    const lanes = draft[`${side}_lanes`];
    const laneText = Array.isArray(lanes) ? lanes.join(",") : lanes;
    const tokens = laneText.trim() ? laneText.split(",") : [];
    const parsedLanes: number[] = [];
    if (tokens.length > 8) {
      errors.push(`${side === "left" ? "左" : "右"}侧车道数不能超过 8 条。`);
    }
    tokens.forEach((token, index) => {
      const value = parseWidth(
        token,
        `${side === "left" ? "左" : "右"}车道 ${index + 1}`,
        errors,
      );
      if (token.trim() && value === 0) {
        const numeric = Number(token.trim());
        if (Number.isFinite(numeric) && numeric === 0) {
          errors.push(`${side === "left" ? "左" : "右"}车道宽度必须大于 0。`);
        }
      }
      parsedLanes.push(value);
    });
    section[`${side}_lanes`] = parsedLanes;
  }
  for (const [key, label] of WIDTH_FIELDS) {
    section[key] = parseWidth(String(draft[key]), label, errors);
  }
  const total =
    section.left_lanes.reduce((sum, value) => sum + value, 0) +
    section.right_lanes.reduce((sum, value) => sum + value, 0) +
    section.median_width +
    section.left_emergency_width +
    section.right_emergency_width +
    section.left_shoulder_width +
    section.right_shoulder_width +
    section.left_slope_width +
    section.right_slope_width;
  if (total <= 0) errors.push("横断面总宽度必须大于 0。至少填写一项非零宽度。");
  return errors.length ? { errors } : { section, errors };
}

function formatLaneWidths(widths: string[]) {
  return widths.join(", ");
}

export function GeneratedSurfaceEditor({
  selection,
  section,
  busy,
  onApply,
  onDeleteComponent,
  onDeletePart,
  onReset,
  onClose,
}: GeneratedSurfaceEditorProps) {
  const [draft, setDraft] = useState<GeneratedSurfaceDraft>(() =>
    sectionToDraft(section),
  );
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const selectionKey = `${selection.label}\u0000${selection.componentLabel}\u0000${selection.partIndex ?? ""}\u0000${selection.scopeLabel ?? ""}`;

  // 选中目标或外部规则真正改变时再同步草稿，普通重渲染不打断输入。
  useEffect(() => {
    setDraft(sectionToDraft(section));
    setApplyError("");
  }, [selectionKey, section]);

  const validation = useMemo(
    () => validateGeneratedSurfaceDraft(draft),
    [draft],
  );
  const parsedSection = validation.section;
  const totalWidth = parsedSection
    ? parsedSection.left_lanes.reduce((sum, width) => sum + width, 0) +
      parsedSection.right_lanes.reduce((sum, width) => sum + width, 0) +
      parsedSection.median_width +
      parsedSection.left_emergency_width +
      parsedSection.right_emergency_width +
      parsedSection.left_shoulder_width +
      parsedSection.right_shoulder_width +
      parsedSection.left_slope_width +
      parsedSection.right_slope_width
    : null;
  const locked = busy || applying;

  const update = (
    key: keyof GeneratedSurfaceDraft,
    value: string | string[],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setApplyError("");
  };

  const apply = async () => {
    if (locked || !validation.section) return;
    setApplying(true);
    setApplyError("");
    try {
      await onApply(validation.section);
    } catch (error) {
      setApplyError(
        error instanceof Error
          ? error.message
          : "重生成失败，请检查任务状态后重试。",
      );
    } finally {
      setApplying(false);
    }
  };

  const scope =
    selection.scopeLabel ??
    (selection.partIndex === undefined
      ? "当前手绘路线"
      : `来源部件 ${selection.partIndex + 1}`);

  return (
    <aside className="generated-surface-editor" aria-label="生成面成果编辑">
      <header className="generated-surface-editor__header">
        <div>
          <p className="generated-surface-editor__eyebrow">成果属性</p>
          <h2>编辑生成面</h2>
        </div>
        <button
          className="generated-surface-editor__close"
          type="button"
          onClick={onClose}
          aria-label="关闭成果编辑面板"
          title="关闭"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>

      <section
        className="generated-surface-editor__selection"
        aria-label="当前选中对象"
      >
        <div className="generated-surface-editor__selection-top">
          <span
            className="generated-surface-editor__route-mark"
            aria-hidden="true"
          >
            线
          </span>
          <div className="generated-surface-editor__selection-copy">
            <strong title={selection.label}>{selection.label}</strong>
            <span title={selection.componentLabel}>
              {selection.componentLabel}
            </span>
          </div>
          {selection.partIndex !== undefined && (
            <span className="generated-surface-editor__part">
              部件 {selection.partIndex + 1}
            </span>
          )}
        </div>
        <div
          className="generated-surface-editor__status"
          aria-label="左右车道状态"
        >
          <span>
            <i className="generated-surface-editor__dot generated-surface-editor__dot--left" />
            左侧 {section.left_lanes.length} 车道
          </span>
          <span>
            <i className="generated-surface-editor__dot generated-surface-editor__dot--right" />
            右侧 {section.right_lanes.length} 车道
          </span>
        </div>
      </section>

      <div className="generated-surface-editor__scope-note">
        正在编辑：{scope}。更改仅作用于当前部件的规则与成果。
      </div>

      <form
        className="generated-surface-editor__form"
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
        noValidate
      >
        <div className="generated-surface-editor__section-heading">
          <div>
            <h3>横断面宽度</h3>
            <span>按路线正向定义左右 · 单位 m</span>
          </div>
          {totalWidth !== null && (
            <output aria-label="总宽度">总宽 {totalWidth.toFixed(2)} m</output>
          )}
        </div>

        <div className="generated-surface-editor__lanes">
          <label className="generated-surface-editor__field">
            <span>
              <b className="generated-surface-editor__side-dot generated-surface-editor__side-dot--left" />
              左侧车道宽度
            </span>
            <input
              aria-label="左侧车道宽度，逗号分隔"
              value={
                Array.isArray(draft.left_lanes)
                  ? formatLaneWidths(draft.left_lanes)
                  : draft.left_lanes
              }
              onChange={(event) => update("left_lanes", event.target.value)}
              placeholder="3.5, 3.5"
              inputMode="decimal"
              autoComplete="off"
              disabled={locked}
            />
            <small>内侧到外侧；留空表示无车道</small>
          </label>
          <label className="generated-surface-editor__field">
            <span>
              <b className="generated-surface-editor__side-dot generated-surface-editor__side-dot--right" />
              右侧车道宽度
            </span>
            <input
              aria-label="右侧车道宽度，逗号分隔"
              value={
                Array.isArray(draft.right_lanes)
                  ? formatLaneWidths(draft.right_lanes)
                  : draft.right_lanes
              }
              onChange={(event) => update("right_lanes", event.target.value)}
              placeholder="3.5, 3.5"
              inputMode="decimal"
              autoComplete="off"
              disabled={locked}
            />
            <small>内侧到外侧；留空表示无车道</small>
          </label>
        </div>

        <label className="generated-surface-editor__field generated-surface-editor__median">
          <span>中央隔离带宽度</span>
          <span className="generated-surface-editor__input-wrap">
            <input
              aria-label="中央隔离带宽度（米）"
              type="number"
              min="0"
              step="0.01"
              value={draft.median_width}
              onChange={(event) => update("median_width", event.target.value)}
              disabled={locked}
            />
            <i>m</i>
          </span>
        </label>

        <details className="generated-surface-editor__details">
          <summary>
            应急车道、路肩与边坡 <span>辅助宽度</span>
          </summary>
          <div className="generated-surface-editor__aux-grid">
            {WIDTH_FIELDS.filter(([key]) => key !== "median_width").map(
              ([key, label]) => (
                <label className="generated-surface-editor__field" key={key}>
                  <span>{label}</span>
                  <span className="generated-surface-editor__input-wrap">
                    <input
                      aria-label={`${label}（米）`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft[key]}
                      onChange={(event) => update(key, event.target.value)}
                      disabled={locked}
                    />
                    <i>m</i>
                  </span>
                </label>
              ),
            )}
          </div>
        </details>

        {validation.errors.length > 0 && (
          <div
            className="generated-surface-editor__errors"
            role="alert"
            aria-live="polite"
          >
            {validation.errors.slice(0, 4).map((error, index) => (
              <p key={`${index}-${error}`}>{error}</p>
            ))}
            {validation.errors.length > 4 && (
              <p>另有 {validation.errors.length - 4} 项需要修正。</p>
            )}
          </div>
        )}
        {applyError && (
          <p className="generated-surface-editor__apply-error" role="alert">
            {applyError}
          </p>
        )}

        <button
          className="generated-surface-editor__apply"
          type="submit"
          disabled={locked || !validation.section}
        >
          {locked ? (
            <>
              <span
                className="generated-surface-editor__spinner"
                aria-hidden="true"
              />
              正在计算…
            </>
          ) : (
            "应用宽度并重生成"
          )}
        </button>
        <button
          className="generated-surface-editor__reset"
          type="button"
          onClick={onReset}
          disabled={locked}
        >
          恢复此路段原规则
        </button>
      </form>

      <div className="generated-surface-editor__limits">
        本面板用于编辑宽度规则，不支持拖动自由多边形顶点或任意切割。
      </div>

      <footer className="generated-surface-editor__delete-actions">
        <button
          type="button"
          onClick={onDeleteComponent}
          disabled={locked}
          aria-label={`删除选中组成：${selection.componentLabel}`}
        >
          <Trash2 size={18} aria-hidden="true" />
          删除选中组成
        </button>
        <button
          type="button"
          onClick={onDeletePart}
          disabled={locked}
          aria-label="删除此路段成果"
        >
          <Trash2 size={18} aria-hidden="true" />
          删除此路段成果
        </button>
        <p>只删除生成成果，不删除路线来源。修改随工程保存，可撤销。</p>
      </footer>
    </aside>
  );
}
