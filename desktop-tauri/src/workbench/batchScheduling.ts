import type { SourceBatchResult, SourceBatchTask } from "./sourceBatch";

// 分批限制仅用于控制单次 IPC 大小，不限制整次生成的数据总量。
export function generationChunks(
  tasks: SourceBatchTask[],
  maxCount = 256,
  maxBytes = 8 * 1024 * 1024,
): SourceBatchTask[][] {
  const chunks: SourceBatchTask[][] = [];
  let chunk: SourceBatchTask[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const task of tasks) {
    const size = encoder.encode(JSON.stringify(task)).byteLength;
    if (chunk.length && (chunk.length >= maxCount || bytes + size > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(task);
    bytes += size;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export function reusableResults(
  tasks: SourceBatchTask[],
  previous: SourceBatchResult[],
): Map<string, SourceBatchResult> {
  const byKey = new Map(previous.map((result) => [result.key, result]));
  const reusable = new Map<string, SourceBatchResult>();
  for (const task of tasks) {
    const result = byKey.get(task.key);
    if (
      result?.response &&
      !result.error &&
      result.input_signature === task.input_signature
    )
      reusable.set(task.key, result);
  }
  return reusable;
}
