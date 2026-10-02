import { useEffect, useState } from "react";
import { NumericField } from "./EditorFields";
const kinds = [
  ["guardrail", "护栏"],
  ["delineator", "轮廓标"],
  ["lighting", "照明"],
  ["sign", "标志"],
  ["milestone", "里程牌"],
  ["markings", "道路标线"],
];
export function AlongRouteTools({
  value,
  ready,
  busy,
  onApply,
  onClear,
}: {
  value: Record<string, unknown>;
  ready: boolean;
  busy: boolean;
  onApply: (options: Record<string, unknown>) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const enabled = Array.isArray(draft.enabled)
    ? (draft.enabled as string[])
    : [];
  return (
    <section className="section-block along-route-tools">
      <h3>沿线自动布设</h3>
      <p className="section-intro">
        按参考线几何里程与铺装外缘生成参数模板设施，独立于手动实例。
      </p>
      <div className="along-route-kinds">
        {kinds.map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={enabled.includes(key)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  enabled: event.target.checked
                    ? [...enabled, key]
                    : enabled.filter((item) => item !== key),
                })
              }
            />
            {label}
          </label>
        ))}
      </div>
      <NumericField
        label="点设施间距"
        value={Number(draft.spacing_m ?? 50)}
        min={0.1}
        max={10000}
        unit="m"
        onCommit={(value) =>
          value !== null && setDraft({ ...draft, spacing_m: value })
        }
      />
      <NumericField
        label="距铺装外缘偏移"
        value={Number(draft.offset_m ?? 1)}
        min={0}
        max={100}
        unit="m"
        onCommit={(value) =>
          value !== null && setDraft({ ...draft, offset_m: value })
        }
      />
      <label className="field-label">
        布设侧别
        <select
          className="text-input"
          value={String(draft.side ?? "both")}
          onChange={(event) => setDraft({ ...draft, side: event.target.value })}
        >
          <option value="both">左右两侧</option>
          <option value="left">左侧</option>
          <option value="right">右侧</option>
        </select>
      </label>
      <div className="inline-actions">
        <button
          className="button primary"
          disabled={!ready || busy}
          onClick={() => onApply({ ...draft, enabled })}
        >
          应用沿线布设
        </button>
        <button
          className="button outline"
          disabled={busy}
          onClick={() => setDraft(value)}
        >
          还原参数
        </button>
      </div>
      <button
        className="text-action"
        disabled={!ready || busy}
        onClick={onClear}
      >
        清除自动设施
      </button>
      <p className="micro-note">
        未应用参数不会保存或导出。生成设施均为待核验示意；几何里程不是业务桩号。
      </p>
    </section>
  );
}
