import { useMemo, useState } from "react";
import type { RouteSection } from "../domain";
import { NumericField } from "./EditorFields";
import {
  MAX_SECTION_LANES,
  MAX_SECTION_WIDTH_M,
  sectionFormIssue,
} from "./sectionFormValidation";
import "./CrossSectionEditor.css";

type Side = "left" | "right";
type Props = {
  section: RouteSection;
  onChange: (next: RouteSection) => void;
};

const MAX_LANES = MAX_SECTION_LANES;
const MAX_WIDTH_M = MAX_SECTION_WIDTH_M;
const laneDefault = 3.5;
const sideKeys = {
  left: {
    lanes: "left_lanes",
    emergency: "left_emergency_width",
    shoulder: "left_shoulder_width",
    slope: "left_slope_width",
  },
  right: {
    lanes: "right_lanes",
    emergency: "right_emergency_width",
    shoulder: "right_shoulder_width",
    slope: "right_slope_width",
  },
} as const;

function sideValues(section: RouteSection, side: Side) {
  const keys = sideKeys[side];
  return {
    lanes: [...section[keys.lanes]],
    emergency: section[keys.emergency],
    shoulder: section[keys.shoulder],
    slope: section[keys.slope],
  };
}

function copySide(section: RouteSection, from: Side): RouteSection {
  const values = sideValues(section, from);
  const to = from === "left" ? "right" : "left";
  const keys = sideKeys[to];
  return {
    ...section,
    [keys.lanes]: values.lanes,
    [keys.emergency]: values.emergency,
    [keys.shoulder]: values.shoulder,
    [keys.slope]: values.slope,
  };
}

function sideTotal(section: RouteSection, side: Side) {
  const keys = sideKeys[side];
  return (
    section[keys.lanes].reduce((sum, width) => sum + width, 0) +
    section[keys.emergency] +
    section[keys.shoulder] +
    section[keys.slope]
  );
}

function CrossSectionDiagram({ section }: { section: RouteSection }) {
  const total = useMemo(
    () =>
      sideTotal(section, "left") +
      section.median_width +
      sideTotal(section, "right"),
    [section],
  );
  const scale = Math.min(34, 850 / Math.max(total, 1));
  // 完整断面居中，参考线按左右宽度移动，避免单侧断面越出视口。
  const center =
    500 +
    ((sideTotal(section, "left") - sideTotal(section, "right")) * scale) / 2;
  const blocks: Array<{
    x: number;
    width: number;
    kind: "lane" | "median" | "emergency" | "shoulder" | "slope";
    label: string;
  }> = [];

  const buildSide = (side: Side) => {
    const keys = sideKeys[side];
    let distance = section.median_width / 2;
    const add = (
      width: number,
      kind: (typeof blocks)[number]["kind"],
      label: string,
    ) => {
      if (width <= 0) return;
      const x =
        side === "left"
          ? center - (distance + width) * scale
          : center + distance * scale;
      blocks.push({ x, width: width * scale, kind, label });
      distance += width;
    };
    section[keys.lanes].forEach((width, index) =>
      add(width, "lane", `车道 ${index + 1}`),
    );
    add(section[keys.emergency], "emergency", "应急");
    add(section[keys.shoulder], "shoulder", "路肩");
    add(section[keys.slope], "slope", "边坡");
  };

  buildSide("left");
  buildSide("right");
  const medianWidth = section.median_width * scale;

  return (
    <div className="cross-section__diagram-wrap">
      <div className="diagram-direction">
        <span>← 左侧</span>
        <strong>路线正向 ↑</strong>
        <span>右侧 →</span>
      </div>
      <svg
        className="cross-section__diagram"
        viewBox="0 0 1000 70"
        preserveAspectRatio="none"
        role="img"
        aria-label="按各组成部分实际水平宽度比例绘制的横断面示意图"
      >
        {blocks.map((block, index) => (
          <rect
            key={`${block.kind}-${index}`}
            x={block.x}
            y={10}
            width={block.width}
            height={48}
            rx={3}
            className={`cross-section__band cross-section__band--${block.kind}`}
          >
            <title>
              {block.label} · {(block.width / scale).toFixed(2)} m
            </title>
          </rect>
        ))}
        {medianWidth > 0 && (
          <rect
            x={center - medianWidth / 2}
            y={10}
            width={medianWidth}
            height={48}
            className="cross-section__band cross-section__band--median"
          />
        )}
        <line
          x1={center}
          x2={center}
          y1={3}
          y2={64}
          className="cross-section__reference"
        />
      </svg>
      <div className="cross-section__legend" aria-label="横断面组成图例">
        {(
          [
            ["lane", "车道"],
            ["median", "中央隔离带"],
            ["emergency", "应急带"],
            ["shoulder", "路肩"],
            ["slope", "边坡水平投影"],
          ] as const
        )
          .filter(([kind]) =>
            kind === "median"
              ? medianWidth > 0
              : blocks.some((block) => block.kind === kind),
          )
          .map(([kind, label]) => (
            <span key={kind}>
              <i
                className={`cross-section__swatch cross-section__swatch--${kind}`}
              />
              {label}
            </span>
          ))}
      </div>
      <p className="diagram-caption">水平宽度比例示意 · 非高程模型</p>
    </div>
  );
}

export function CrossSectionEditor({ section, onChange }: Props) {
  const [active, setActive] = useState<"left" | "center" | "right">("left");
  const [synchronized, setSynchronized] = useState(false);
  const [mirrorSide, setMirrorSide] = useState<Side>("left");

  const setSideValues = (side: Side, values: ReturnType<typeof sideValues>) => {
    const keys = sideKeys[side];
    let next: RouteSection = {
      ...section,
      [keys.lanes]: values.lanes,
      [keys.emergency]: values.emergency,
      [keys.shoulder]: values.shoulder,
      [keys.slope]: values.slope,
    };
    if (synchronized) {
      const other = side === "left" ? "right" : "left";
      const otherKeys = sideKeys[other];
      next = {
        ...next,
        [otherKeys.lanes]: [...values.lanes],
        [otherKeys.emergency]: values.emergency,
        [otherKeys.shoulder]: values.shoulder,
        [otherKeys.slope]: values.slope,
      };
    }
    onChange(next);
  };

  const setPart = (
    side: Side,
    part: keyof ReturnType<typeof sideValues>,
    value: number | null,
    laneIndex?: number,
  ) => {
    if (value === null || !Number.isFinite(value)) return;
    const values = sideValues(section, side);
    if (part === "lanes" && laneIndex !== undefined) {
      values.lanes[laneIndex] = value;
    } else if (part !== "lanes") {
      values[part] = value;
    }
    setSideValues(side, values);
  };

  const updateCount = (side: Side, count: number) => {
    const values = sideValues(section, side);
    values.lanes = Array.from(
      { length: count },
      (_, index) => values.lanes[index] ?? laneDefault,
    );
    setSideValues(side, values);
  };

  const switchSync = (enabled: boolean) => {
    setSynchronized(enabled);
    if (enabled) {
      const source = active === "right" ? "right" : "left";
      setMirrorSide(source);
      onChange(copySide(section, source));
    }
  };

  const leftLanes = section.left_lanes.reduce((sum, value) => sum + value, 0);
  const rightLanes = section.right_lanes.reduce((sum, value) => sum + value, 0);
  const paved =
    leftLanes +
    rightLanes +
    section.left_emergency_width +
    section.right_emergency_width +
    section.left_shoulder_width +
    section.right_shoulder_width;
  const total =
    paved +
    section.median_width +
    section.left_slope_width +
    section.right_slope_width;
  const side = active === "right" ? "right" : "left";

  const renderSideEditor = (selected: Side) => {
    const selectedValues = sideValues(section, selected);
    const keys = sideKeys[selected];
    const heading = selected === "left" ? "左侧" : "右侧";
    return (
      <div className="cross-section__fields">
        <div className="cross-section__field-row cross-section__lane-count">
          <div>
            <span className="cross-section__field-title">车道数</span>
            <span className="cross-section__field-help">
              0 至 8 条，按内侧至外侧排列
            </span>
          </div>
          <div
            className="cross-section__stepper"
            aria-label={`${heading}车道数`}
          >
            <button
              type="button"
              onClick={() =>
                updateCount(
                  selected,
                  Math.max(0, selectedValues.lanes.length - 1),
                )
              }
              disabled={selectedValues.lanes.length === 0}
              aria-label="减少车道"
            >
              −
            </button>
            <output>{selectedValues.lanes.length}</output>
            <button
              type="button"
              onClick={() =>
                updateCount(
                  selected,
                  Math.min(MAX_LANES, selectedValues.lanes.length + 1),
                )
              }
              disabled={selectedValues.lanes.length >= MAX_LANES}
              aria-label="增加车道"
            >
              +
            </button>
          </div>
        </div>
        {selectedValues.lanes.map((width, index) => (
          <div
            className="cross-section__numeric-row"
            key={`${selected}-lane-${index}`}
          >
            <NumericField
              label={`${heading}第 ${index + 1} 条车道宽度`}
              value={width}
              onCommit={(value) => setPart(selected, "lanes", value, index)}
              min={0.1}
              max={MAX_WIDTH_M}
              step={0.1}
              nullable={false}
              unit="m"
            />
            <span className="cross-section__field-help">
              内侧至外侧第 {index + 1} 条
            </span>
          </div>
        ))}
        <div className="cross-section__field-divider" />
        <NumericField
          label={`${heading}应急带宽度`}
          value={selectedValues.emergency}
          onCommit={(value) => setPart(selected, "emergency", value)}
          min={0}
          max={MAX_WIDTH_M}
          step={0.1}
          nullable={false}
          unit="m"
        />
        <NumericField
          label={`${heading}路肩宽度`}
          value={selectedValues.shoulder}
          onCommit={(value) => setPart(selected, "shoulder", value)}
          min={0}
          max={MAX_WIDTH_M}
          step={0.1}
          nullable={false}
          unit="m"
        />
        <NumericField
          label={`${heading}边坡水平投影宽度`}
          value={selectedValues.slope}
          onCommit={(value) => setPart(selected, "slope", value)}
          min={0}
          max={MAX_WIDTH_M}
          step={0.1}
          nullable={false}
          unit="m"
        />
      </div>
    );
  };

  return (
    <section className="cross-section" aria-label="道路横断面编辑">
      <header className="cross-section__header">
        <div>
          <h2>横断面</h2>
          <p>沿路线正向观察，左右以参考线方向为准</p>
        </div>
        <span className="cross-section__unit-tag">宽度单位：m</span>
      </header>
      <CrossSectionDiagram section={section} />

      <div className="cross-section__summary" aria-label="宽度汇总">
        <div title="铺装宽度：车道 + 应急带 + 路肩">
          <span>铺装宽度</span>
          <strong>
            {paved.toFixed(2)} <small>m</small>
          </strong>
          <em>车道 + 应急带 + 路肩</em>
        </div>
        <div title="总水平投影宽度：铺装 + 中央隔离带 + 两侧边坡">
          <span>总水平投影宽度</span>
          <strong>
            {total.toFixed(2)} <small>m</small>
          </strong>
          <em>铺装 + 中央隔离带 + 两侧边坡</em>
        </div>
      </div>
      {sectionFormIssue(section) && (
        <div className="cross-section__validation" role="alert">
          <span>{sectionFormIssue(section)}</span>
        </div>
      )}

      <div
        className="cross-section__tabs"
        role="tablist"
        aria-label="编辑横断面组成"
      >
        {(["left", "center", "right"] as const).map((tab) => {
          const label =
            tab === "left" ? "左侧" : tab === "right" ? "右侧" : "中央";
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active === tab}
              tabIndex={active === tab ? 0 : -1}
              className={active === tab ? "is-active" : ""}
              onClick={() => setActive(tab)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                const tabs = ["left", "center", "right"] as const;
                const index = tabs.indexOf(tab);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 2
                      : event.key === "ArrowRight"
                        ? (index + 1) % 3
                        : event.key === "ArrowLeft"
                          ? (index + 2) % 3
                          : null;
                if (next === null) return;
                event.preventDefault();
                setActive(tabs[next]);
                (
                  event.currentTarget.parentElement?.querySelectorAll("button")[
                    next
                  ] as HTMLButtonElement
                )?.focus();
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {active === "center" ? (
        <div
          className="cross-section__fields cross-section__center-fields"
          role="tabpanel"
        >
          <p className="cross-section__panel-help">
            中央隔离带横向宽度，计入总水平投影宽度，不计入铺装宽度。
          </p>
          <NumericField
            label="中央隔离带宽度"
            value={section.median_width}
            onCommit={(value) =>
              value !== null && onChange({ ...section, median_width: value })
            }
            min={0}
            max={MAX_WIDTH_M}
            step={0.1}
            nullable={false}
            unit="m"
          />
        </div>
      ) : (
        <div role="tabpanel">
          <div className="cross-section__sync-row">
            <label className="cross-section__sync-control">
              <input
                type="checkbox"
                checked={synchronized}
                onChange={(event) => switchSync(event.target.checked)}
              />
              <span>左右同步</span>
            </label>
            <span
              className="cross-section__sync-note"
              title="开启时会将当前侧完整复制到另一侧，此后编辑任一侧会同步更新。"
            >
              {synchronized
                ? `已将${mirrorSide === "left" ? "左侧" : "右侧"}值复制到另一侧；编辑任一侧会同步更新。`
                : "开启时复制当前侧"}
            </span>
          </div>
          {
            <details className="cross-section__copy-options">
              <summary>复制左右配置</summary>
              <div className="cross-section__sync-source" aria-label="同步来源">
                <button
                  type="button"
                  onClick={() => {
                    setMirrorSide("left");
                    onChange(copySide(section, "left"));
                  }}
                >
                  左复制到右
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMirrorSide("right");
                    onChange(copySide(section, "right"));
                  }}
                >
                  右复制到左
                </button>
              </div>
            </details>
          }
          {renderSideEditor(side)}
        </div>
      )}
    </section>
  );
}
