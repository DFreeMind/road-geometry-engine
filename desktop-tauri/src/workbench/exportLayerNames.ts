/** 显示名称可含路径；导出名称必须有界且唯一，不能直接作为文件路径。 */
export function exportLayerNames(names: string[]): string[] {
  const used = new Set<string>();
  const encoder = new TextEncoder();
  return names.map((name, index) => {
    const clean =
      name.replace(/[\\/\u0000]/g, "_").trim() || `图层_${index + 1}`;
    let base = "";
    for (const char of clean) {
      if (encoder.encode(base + char).length > 108) break;
      base += char;
    }
    let result = base || `图层_${index + 1}`;
    let suffix = 2;
    while (used.has(result.toLocaleLowerCase())) result = `${base}_${suffix++}`;
    used.add(result.toLocaleLowerCase());
    return result;
  });
}
