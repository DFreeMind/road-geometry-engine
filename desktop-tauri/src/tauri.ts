import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export { isTauri };
export const nativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => invoke<T>(command, args);
function debugHarnessEnabled() {
  return import.meta.env.DEV || import.meta.env.TAURI_ENV_DEBUG === "true";
}
export async function chooseFile(
  filters?: { name: string; extensions: string[] }[],
) {
  if (!isTauri()) return null;
  const qa = (window as any).__ROAD_WORKBENCH__;
  if (
    debugHarnessEnabled() &&
    Array.isArray(qa?.dialogs?.open) &&
    qa.dialogs.open.length
  )
    return qa.dialogs.open.shift() as string;
  const result = await open({ multiple: false, filters });
  return typeof result === "string" ? result : null;
}
export async function chooseSave(
  defaultPath: string,
  filters?: { name: string; extensions: string[] }[],
) {
  if (!isTauri()) return null;
  const qa = (window as any).__ROAD_WORKBENCH__;
  if (
    debugHarnessEnabled() &&
    Array.isArray(qa?.dialogs?.save) &&
    qa.dialogs.save.length
  )
    return qa.dialogs.save.shift() as string;
  return await save({ defaultPath, filters });
}
