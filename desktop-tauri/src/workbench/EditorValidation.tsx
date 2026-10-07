import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type EditorValidationContextValue = {
  hasInvalidFields: boolean;
  /** 在事件处理器或延迟任务中同步读取，不依赖 React render 闭包。 */
  isInvalid: () => boolean;
  getInvalidFields: () => string[];
  setFieldInvalid: (fieldId: string, invalid: boolean) => void;
  unregisterField: (fieldId: string) => void;
};

const noOp = () => undefined;
const optionalContext: EditorValidationContextValue = {
  hasInvalidFields: false,
  isInvalid: () => false,
  getInvalidFields: () => [],
  setFieldInvalid: noOp,
  unregisterField: noOp,
};
const EditorValidationContext = createContext(optionalContext);

/** 以字段 ID 维护当前无效草稿，避免页面卸载后残留禁用状态。 */
export function setEditorFieldValidity(
  invalidFields: ReadonlySet<string>,
  fieldId: string,
  invalid: boolean,
): ReadonlySet<string> {
  const alreadyInvalid = invalidFields.has(fieldId);
  if (alreadyInvalid === invalid) return invalidFields;
  const next = new Set(invalidFields);
  if (invalid) next.add(fieldId);
  else next.delete(fieldId);
  return next;
}

/** 字段卸载时移除其无效标记。 */
export function unregisterEditorField(
  invalidFields: ReadonlySet<string>,
  fieldId: string,
): ReadonlySet<string> {
  if (!invalidFields.has(fieldId)) return invalidFields;
  const next = new Set(invalidFields);
  next.delete(fieldId);
  return next;
}

export function EditorValidationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const invalidFieldsRef = useRef<ReadonlySet<string>>(invalidFields);
  const setFieldInvalid = useCallback((fieldId: string, invalid: boolean) => {
    const next = setEditorFieldValidity(
      invalidFieldsRef.current,
      fieldId,
      invalid,
    );
    invalidFieldsRef.current = next;
    setInvalidFields(next);
  }, []);
  const unregisterField = useCallback((fieldId: string) => {
    const next = unregisterEditorField(invalidFieldsRef.current, fieldId);
    invalidFieldsRef.current = next;
    setInvalidFields(next);
  }, []);
  const isInvalid = useCallback(() => invalidFieldsRef.current.size > 0, []);
  const getInvalidFields = useCallback(() => [...invalidFieldsRef.current], []);
  const value = useMemo(
    () => ({
      hasInvalidFields: invalidFields.size > 0,
      isInvalid,
      getInvalidFields,
      setFieldInvalid,
      unregisterField,
    }),
    [
      invalidFields,
      isInvalid,
      getInvalidFields,
      setFieldInvalid,
      unregisterField,
    ],
  );

  return (
    <EditorValidationContext.Provider value={value}>
      {children}
    </EditorValidationContext.Provider>
  );
}

/** 读取当前编辑器的无效草稿状态。未接入 Provider 时字段校验仍可独立工作。 */
export function useEditorValidation() {
  return useContext(EditorValidationContext);
}
