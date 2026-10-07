import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useEditorValidation } from "./EditorValidation";
import "./EditorFields.css";

type NumericFieldProps = {
  value: number | null;
  onCommit: (value: number | null) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
  unit?: string;
  precision?: number;
};

type NumericParseResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

export type NumericDraftTransaction = {
  draft: string;
  edited: boolean;
  completed: boolean;
};

type NumericCommitResolution =
  | { status: "unchanged"; transaction: NumericDraftTransaction }
  | {
      status: "commit";
      value: number | null;
      transaction: NumericDraftTransaction;
    }
  | {
      status: "error";
      error: string;
      transaction: NumericDraftTransaction;
    };

export function beginNumericDraftTransaction(
  value: number | null,
): NumericDraftTransaction {
  return {
    draft: value === null ? "" : String(value),
    edited: false,
    completed: false,
  };
}

export function editNumericDraftTransaction(
  transaction: NumericDraftTransaction,
  draft: string,
): NumericDraftTransaction {
  return { draft, edited: true, completed: false };
}

/** 决定一次数值草稿事务是否需要提交；重复 blur/Enter 不会重复提交。 */
export function resolveNumericDraftTransaction(
  transaction: NumericDraftTransaction,
  originalValue: number | null,
  options: Pick<NumericFieldProps, "min" | "max" | "nullable"> = {},
): NumericCommitResolution {
  if (transaction.completed || !transaction.edited)
    return {
      status: "unchanged",
      transaction: { ...transaction, completed: true },
    };

  const parsed = parseNumericDraft(transaction.draft, options);
  if (!parsed.ok) return { status: "error", error: parsed.error, transaction };
  const completed = { ...transaction, completed: true };
  if (parsed.value === originalValue)
    return { status: "unchanged", transaction: completed };
  return { status: "commit", value: parsed.value, transaction: completed };
}

/** 解析可清空的数值草稿，范围和空值规则由字段调用方明确传入。 */
export function parseNumericDraft(
  draft: string,
  options: Pick<NumericFieldProps, "min" | "max" | "nullable"> = {},
): NumericParseResult {
  const trimmed = draft.trim();
  if (!trimmed) {
    return options.nullable
      ? { ok: true, value: null }
      : { ok: false, error: "此项不能为空" };
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value))
    return { ok: false, error: "请输入有效的有限数值" };
  if (options.min !== undefined && value < options.min)
    return { ok: false, error: `数值不能小于 ${options.min}` };
  if (options.max !== undefined && value > options.max)
    return { ok: false, error: `数值不能大于 ${options.max}` };
  return { ok: true, value };
}

/** 数字输入显示适量小数位；保存仍使用解析后的完整数值。 */
export function formatNumericDraft(
  value: number | null,
  precision = 2,
): string {
  if (value === null || !Number.isFinite(value)) return "";
  const digits = Math.min(12, Math.max(0, precision));
  return value
    .toFixed(digits)
    .replace(/(?:\.0+|(?<=[0-9])0+)$/, "")
    .replace(/\.$/, "");
}

export function NumericField({
  value,
  onCommit,
  label,
  min,
  max,
  step = 0.01,
  nullable = false,
  unit,
  precision = 2,
}: NumericFieldProps) {
  const [draft, setDraft] = useState(() =>
    formatNumericDraft(value, precision),
  );
  const [focused, setFocused] = useState(false);
  const [edited, setEdited] = useState(false);
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const transactionRef = useRef(beginNumericDraftTransaction(value));
  const { setFieldInvalid, unregisterField } = useEditorValidation();
  const parsedDraft = parseNumericDraft(draft, { min, max, nullable });
  const draftError = parsedDraft.ok ? "" : parsedDraft.error;

  useEffect(() => {
    if (!focused && !draftError && !edited)
      setDraft(formatNumericDraft(value, precision));
  }, [focused, value, precision, draftError, edited]);

  useLayoutEffect(() => {
    setFieldInvalid(errorId, Boolean(draftError));
    return () => unregisterField(errorId);
  }, [draftError, errorId, setFieldInvalid, unregisterField]);

  const commit = () => {
    const resolution = resolveNumericDraftTransaction(
      transactionRef.current,
      value,
      { min, max, nullable },
    );
    transactionRef.current = resolution.transaction;
    if (resolution.status === "error") return;
    setEdited(false);
    if (resolution.status === "commit") onCommit(resolution.value);
  };

  return (
    <label className="editor-field">
      <span className="editor-field__label">{label}</span>
      <span className="editor-field__control-wrap">
        <input
          ref={inputRef}
          className="editor-field__control"
          type="number"
          inputMode="decimal"
          value={draft}
          min={min}
          max={max}
          step={step}
          aria-label={label}
          aria-invalid={Boolean(draftError)}
          aria-describedby={draftError ? errorId : undefined}
          onFocus={() => {
            if (!draftError) {
              transactionRef.current = beginNumericDraftTransaction(value);
              setDraft(transactionRef.current.draft);
              setEdited(false);
            }
            setFocused(true);
          }}
          onWheel={(event) => event.currentTarget.blur()}
          onChange={(event) => {
            const nextDraft = event.currentTarget.value;
            transactionRef.current = editNumericDraftTransaction(
              transactionRef.current,
              nextDraft,
            );
            setDraft(nextDraft);
            setEdited(true);
          }}
          onBlur={() => {
            commit();
            setFocused(false);
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              inputRef.current?.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              transactionRef.current = {
                ...beginNumericDraftTransaction(value),
                completed: true,
              };
              setDraft(formatNumericDraft(value, precision));
              setEdited(false);
              inputRef.current?.blur();
            }
          }}
        />
        {unit ? <span className="editor-field__unit">{unit}</span> : null}
      </span>
      {draftError ? (
        <span className="editor-field__error" id={errorId} role="alert">
          {draftError}
        </span>
      ) : null}
    </label>
  );
}

type SpecificationFormProps = {
  specification: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
};

const labels: Record<string, { label: string; unit?: string }> = {
  sign_code: { label: "标志编码" },
  panel_width_m: { label: "面板宽度", unit: "m" },
  panel_height_m: { label: "面板高度", unit: "m" },
  support_type: { label: "支撑形式" },
  reflective_material: { label: "反光材料" },
  color: { label: "颜色" },
  line_width_m: { label: "标线宽度", unit: "m" },
  dash_length_m: { label: "实线段长度", unit: "m" },
  gap_length_m: { label: "间隔长度", unit: "m" },
  material: { label: "材料" },
  protection_level: { label: "防护等级" },
  height_m: { label: "高度", unit: "m" },
  post_spacing_m: { label: "立柱间距", unit: "m" },
  foundation: { label: "基础形式" },
  transition_type: { label: "过渡形式" },
  reflective_color: { label: "反光颜色" },
  mounting_type: { label: "安装形式" },
  mesh_size_m: { label: "网孔尺寸", unit: "m" },
  performance_basis: { label: "性能依据" },
  mounting_height_m: { label: "安装高度", unit: "m" },
  power_w: { label: "功率", unit: "W" },
  arm_length_m: { label: "悬臂长度", unit: "m" },
  photometry_file: { label: "配光文件" },
  luminaire_model: { label: "灯具型号" },
  signal_group: { label: "信号组" },
  controller_scheme: { label: "控制器方案" },
  device_model: { label: "设备型号" },
  field_of_view_deg: { label: "视场角", unit: "°" },
  power_supply: { label: "供电方式" },
  system_id: { label: "系统编号" },
  communication_type: { label: "通信方式" },
  diameter_m: { label: "直径", unit: "m" },
  depth_m: { label: "深度", unit: "m" },
  connection_id: { label: "连接编号" },
  product_model: { label: "产品型号" },
  width_m: { label: "宽度", unit: "m" },
  business_station: { label: "业务桩号" },
};

const enumOptions: Record<string, string[]> = {
  support_type: ["柱式", "悬臂式", "门架式", "附着式"],
  reflective_material: ["工程级", "高强级", "超强级", "微棱镜型", "玻璃珠型"],
  material: ["钢材", "混凝土", "铝合金", "热塑性材料", "复合材料"],
  protection_level: ["A级", "B级", "C级", "Am级", "SB级", "SA级", "SS级"],
  foundation: ["独立基础", "条形基础", "桩基础", "直接埋设"],
  transition_type: ["端头式", "渐变式", "搭接式"],
  reflective_color: ["白色", "黄色", "红色", "蓝色", "绿色"],
  mounting_type: ["柱式", "悬臂式", "门架式", "附着式", "落地式"],
};

const numericFields = new Set(
  Object.keys(labels).filter((key) => /_(?:m|w|deg)$/.test(key)),
);
const codeFields = new Set([
  "sign_code",
  "system_id",
  "connection_id",
  "business_station",
]);

/** 将一个字段写入新对象，避免把编号或其他输入值隐式转换成数字。 */
export function updateSpecificationValue(
  specification: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return { ...specification, [key]: value };
}

/** JSON 高级字段必须解析为与原字段相同的数组或对象类型。 */
export function parseStructuredDraft(
  draft: string,
  expected: "array" | "object",
):
  | { ok: true; value: unknown[] | Record<string, unknown> }
  | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(draft);
  } catch {
    return { ok: false, error: "JSON 格式无效，请检查括号、引号和逗号" };
  }
  const isArray = Array.isArray(value);
  if (
    expected === "array"
      ? !isArray
      : !value || typeof value !== "object" || isArray
  )
    return {
      ok: false,
      error:
        expected === "array" ? "此字段需要 JSON 数组" : "此字段需要 JSON 对象",
    };
  return {
    ok: true,
    value: value as unknown[] | Record<string, unknown>,
  };
}

function displayValue(key: string, value: unknown) {
  return codeFields.has(key) && typeof value === "string"
    ? value
    : String(value ?? "");
}

function StructuredField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: unknown[] | Record<string, unknown>;
  onCommit: (value: unknown[] | Record<string, unknown>) => void;
}) {
  const expected = Array.isArray(value) ? "array" : "object";
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing && !error) setDraft(JSON.stringify(value, null, 2));
  }, [editing, value, error]);
  const commit = () => {
    const parsed = parseStructuredDraft(draft, expected);
    if (!parsed.ok) {
      setError(parsed.error);
      return false;
    }
    setError("");
    if (JSON.stringify(parsed.value) !== JSON.stringify(value))
      onCommit(parsed.value);
    return true;
  };
  return (
    <label className="editor-field editor-field--structured">
      <span className="editor-field__label">{label} · JSON</span>
      <textarea
        className="editor-field__control editor-field__json"
        value={draft}
        aria-label={`${label} JSON`}
        aria-invalid={Boolean(error)}
        onFocus={() => setEditing(true)}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError("");
        }}
        onBlur={() => {
          commit();
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDraft(JSON.stringify(value, null, 2));
            setError("");
            event.currentTarget.blur();
          }
        }}
      />
      {error ? (
        <span className="editor-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function SpecificationForm({
  specification,
  onChange,
}: SpecificationFormProps) {
  const keys = Object.keys(specification);
  const knownKeys = keys.filter((key) => key in labels);
  const extraKeys = keys.filter((key) => !(key in labels));
  const update = (key: string, value: unknown) =>
    onChange(updateSpecificationValue(specification, key, value));

  const renderField = (key: string) => {
    const value = specification[key];
    const fieldLabel = labels[key]?.label ?? key;
    if (
      numericFields.has(key) ||
      (typeof value === "number" && !codeFields.has(key))
    ) {
      return (
        <NumericField
          key={key}
          label={fieldLabel}
          unit={labels[key]?.unit}
          value={
            typeof value === "number" && Number.isFinite(value) ? value : null
          }
          nullable={
            numericFields.has(key) || value === null || value === undefined
          }
          precision={3}
          min={
            /(?:width|height|diameter|length|spacing|depth).*_m$/.test(key)
              ? 0
              : undefined
          }
          step={labels[key]?.unit === "°" ? 1 : 0.01}
          onCommit={(next) => update(key, next)}
        />
      );
    }
    if (typeof value === "boolean") {
      return (
        <label className="editor-field editor-field--check" key={key}>
          <input
            type="checkbox"
            checked={value}
            aria-label={fieldLabel}
            onChange={(event) => update(key, event.currentTarget.checked)}
          />
          <span className="editor-field__label">{fieldLabel}</span>
        </label>
      );
    }
    if (Array.isArray(value) || (value !== null && typeof value === "object")) {
      return (
        <StructuredField
          key={key}
          label={fieldLabel}
          value={value as unknown[] | Record<string, unknown>}
          onCommit={(next) => update(key, next)}
        />
      );
    }
    if (enumOptions[key]) {
      const options = enumOptions[key];
      const current = typeof value === "string" ? value : "";
      return (
        <label className="editor-field" key={key}>
          <span className="editor-field__label">{fieldLabel}</span>
          <select
            className="editor-field__control"
            value={current}
            aria-label={fieldLabel}
            onChange={(event) => update(key, event.currentTarget.value)}
          >
            <option value="">未指定</option>
            {current && !options.includes(current) ? (
              <option value={current}>{current}（现有值）</option>
            ) : null}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );
    }
    if (typeof value === "string" || value === null || value === undefined) {
      return (
        <label className="editor-field" key={key}>
          <span className="editor-field__label">{fieldLabel}</span>
          <input
            className="editor-field__control"
            type="text"
            value={displayValue(key, value)}
            aria-label={fieldLabel}
            onChange={(event) => update(key, event.currentTarget.value)}
          />
        </label>
      );
    }
    return (
      <StructuredField
        key={key}
        label={fieldLabel}
        value={{ value }}
        onCommit={(next) =>
          update(key, (next as Record<string, unknown>).value)
        }
      />
    );
  };

  return (
    <div className="specification-form">
      {knownKeys.length ? (
        <div className="specification-form__grid">
          {knownKeys.map(renderField)}
        </div>
      ) : null}
      {extraKeys.length ? (
        <details className="specification-form__advanced">
          <summary>高级字段（{extraKeys.length}）</summary>
          <div className="specification-form__grid">
            {extraKeys.map(renderField)}
          </div>
        </details>
      ) : null}
    </div>
  );
}
