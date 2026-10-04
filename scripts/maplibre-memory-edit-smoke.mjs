import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [endpointArg, outputArg, workspaceArg, cyclesArg] = process.argv.slice(2);
const endpoint = endpointArg ?? "http://127.0.0.1:9226";
const workspace = workspaceArg ?? process.cwd();
const cycles = Number(cyclesArg ?? 30);
assert(Number.isInteger(cycles) && cycles >= 1, "cycles 须为正整数");
const outputDirectory = path.resolve(
  outputArg ??
    path.join(
      workspace,
      "artifacts",
      "private-validation",
      `maplibre-memory-edit-${new Date().toISOString().replaceAll(":", "-")}`,
    ),
);
await fs.mkdir(outputDirectory, { recursive: true });

let mainTarget;
for (let attempt = 0; attempt < 80; attempt++) {
  const targets = await (await fetch(`${endpoint}/json`)).json();
  mainTarget = targets.find(
    (item) =>
      item.type === "page" &&
      item.url.includes("tauri") &&
      !item.url.includes("window=generation-issues"),
  );
  if (mainTarget?.webSocketDebuggerUrl) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert(mainTarget?.webSocketDebuggerUrl, `未找到工作台 WebView：${endpoint}`);

function connect(target, label) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onclose = (event) => {
    for (const handler of pending.values())
      handler.reject(
        new Error(`${label} 调试连接关闭：${event.code} ${event.reason}`),
      );
    pending.clear();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error)
        handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(
        message.params.exceptionDetails.text +
          ":" +
          (message.params.exceptionDetails.exception?.description ?? ""),
      );
    } else if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    ) {
      errors.push(
        message.params.args
          .map((item) => item.description ?? item.value ?? "")
          .join(" "),
      );
    }
  };
  const command = (method, params = {}, timeout = 90000) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeout);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression, timeout = 90000) => {
    const result = await command(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeout,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.exception?.value ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  return { socket, opened, command, evaluate, errors };
}

const main = connect(mainTarget, "工作台");
await main.opened;
const command = main.command;
const evaluate = main.evaluate;
const waitFor = async (
  expression,
  timeoutSeconds = 90,
  evaluateIn = evaluate,
) => {
  const limit = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < limit) {
    if (await evaluateIn(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`等待超时：${expression}`);
};

async function findIssueTarget(present = true) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const targets = await (await fetch(`${endpoint}/json`)).json();
    const target = targets.find(
      (item) =>
        item.type === "page" &&
        item.id !== mainTarget.id &&
        /window=generation-issues/.test(item.url),
    );
    if (present ? target : !target) return target;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(present ? "未发现生成问题窗口" : "生成问题窗口未能关闭");
}

let issue;
let originalProject;
let originalLayout;
const samples = [];
const timings = { edit_ms: [], undo_ms: [], redo_ms: [] };
const checks = [];
let processMemoryAvailable = false;

const check = (name, details) => checks.push({ name, passed: true, details });
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))
  ];
};
const timingSummary = (values) => ({
  count: values.length,
  median_ms: percentile(values, 0.5),
  p95_ms: percentile(values, 0.95),
  max_ms: Math.max(...values),
});

async function heapUsage() {
  try {
    const usage = await command("Runtime.getHeapUsage");
    return { used_bytes: usage.usedSize, total_bytes: usage.totalSize };
  } catch {
    const metrics = await command("Performance.getMetrics");
    const values = Object.fromEntries(
      (metrics.metrics ?? []).map((item) => [item.name, item.value]),
    );
    return {
      used_bytes: Math.round((values.JSHeapUsedSize ?? 0) * 1),
      total_bytes: Math.round((values.JSHeapTotalSize ?? 0) * 1),
    };
  }
}

function processWorkingSet() {
  if (process.platform !== "win32") return null;
  try {
    const port = new URL(endpoint).port;
    const script = `$ProgressPreference='SilentlyContinue'; $port=${Number(port)}; $roots=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); $all=@(Get-CimInstance Win32_Process); $ids=[System.Collections.Generic.HashSet[int]]::new(); foreach($id in $roots){[void]$ids.Add([int]$id)}; do {$changed=$false; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$changed=$true}}} while($changed); $items=@(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64); @{listener_process_ids=@($roots); processes=$items; total_working_set_bytes=($items | Measure-Object -Property WorkingSet64 -Sum).Sum} | ConvertTo-Json -Compress -Depth 4`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-EncodedCommand", encoded],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    ).trim();
    const parsed = JSON.parse(result);
    processMemoryAvailable = (parsed.listener_process_ids ?? []).length > 0;
    return parsed;
  } catch {
    return null;
  }
}

async function sampleMemory(label, includeProcess = false) {
  const sample = {
    label,
    at: new Date().toISOString(),
    ...(await heapUsage()),
  };
  if (includeProcess) sample.process_working_set = processWorkingSet();
  samples.push(sample);
  return sample;
}

async function collectGarbage() {
  try {
    await command("HeapProfiler.collectGarbage");
    return true;
  } catch {
    return false;
  }
}

async function diagnostics() {
  return evaluate("window.__ROAD_WORKBENCH__.getMemoryDiagnostics()");
}

async function waitForState(predicate, label, timeoutSeconds = 40) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let value;
  while (Date.now() < deadline) {
    value = await diagnostics();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`${label}状态未达到预期：${JSON.stringify(value)}`);
}

function syntheticProjectExpression(featureCount, pointsPerFeature) {
  return `(() => {
    const qa = window.__ROAD_WORKBENCH__;
    const project = qa.getProject();
    const featureCount = ${featureCount};
    const pointsPerFeature = ${pointsPerFeature};
    const section = {
      left_lanes: [3.5], right_lanes: [3.5], median_width: 0,
      left_emergency_width: 0, right_emergency_width: 0,
      left_shoulder_width: 0, right_shoulder_width: 0,
      left_slope_width: 0, right_slope_width: 0,
    };
    const canonical = value => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
      if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
      return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    };
    const hash = value => {
      let first = 0x811c9dc5, second = 0x9e3779b9;
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ (code + i), 0x85ebca6b);
      }
      return ((first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0'));
    };
    const lat0 = 39.9, lon0 = 116.3, longitudeScale = 111320 * Math.cos(lat0 * Math.PI / 180);
    const features = [];
    for (let route = 0; route < featureCount; route++) {
      const coordinates = new Array(pointsPerFeature);
      const routeLon = lon0 + route * 0.003;
      for (let i = 0; i < pointsPerFeature; i++) {
        const distance = i * 0.25;
        const east = distance + 18 * Math.sin(distance / 120 + route * 0.3);
        const north = 26 * Math.sin(distance / 85 + route * 0.17) + 0.0005 * distance * Math.sin(distance / 9);
        coordinates[i] = [routeLon + east / longitudeScale, lat0 + north / 111320];
      }
      if (route < 2) coordinates[5001] = coordinates[5000];
      const feature = {
        type: 'Feature', id: 'qa-memory-' + route,
        properties: { route_id: 'QA-MEMORY-' + route },
        geometry: { type: 'LineString', coordinates },
      };
      features.push(feature);
    }
    const datasetId = 'qa-memory-edit-source';
    const label = 'CDP 内存压测来源';
    const keys = features.map(feature => 'fid:' + encodeURIComponent(feature.id) + ':' + hash(canonical(feature)));
    const dataset = {
      id: datasetId, kind: 'route-source', source_label: label, label,
      collection: { type: 'FeatureCollection', features },
      fields: [{ name: 'route_id', type: 'text' }], binding: null,
      visible: true, feature_keys: keys, excluded_keys: [], revision: 1,
      mapping: { route_id: 'route_id' }, manual_section: section,
    };
    const sceneOptions = { ...(project.scene_options ?? {}), enabled: [] };
    const sceneKey = JSON.stringify([
      sceneOptions.enabled ?? [], sceneOptions.spacing_m ?? 50,
      sceneOptions.offset_m ?? 1, sceneOptions.side ?? 'both',
    ]);
    const results = features.map((feature, index) => ({
      key: 'qa-result-' + index, dataset_id: datasetId,
      feature_key: keys[index], part_index: 0,
      input_signature: 'qa-signature-' + index,
      source_properties: feature.properties,
      response: {
        projected_crs: 'EPSG:4326',
        layers: [{
          name: '压测成果线', crs: 'EPSG:4326',
          collection: {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature', id: 'qa-output-' + index,
              properties: { component: 'lane', lane_index: 1 },
              geometry: feature.geometry,
            }],
          },
        }],
      },
    }));
    project.schema_version = 2;
    project.input_version = 1;
    project.route_id = 'QA-MEMORY-EMPTY';
    project.crs = 'EPSG:32650';
    project.route_points = [];
    project.route_source = label;
    project.section = section;
    project.manual_section = section;
    project.output = null;
    project.last_generated_input_version = null;
    project.road_output_cleared = true;
    project.scene_options = sceneOptions;
    project.vector_basemaps = [dataset];
    project.source_mapping = { route_id: 'route_id' };
    project.source_binding = null;
    project.source_label = label;
    project.source_batch_output = {
      results, total: results.length, completed: results.length,
      dataset_revisions: { [datasetId]: 1 }, scene_key: sceneKey, issues: [],
    };
    project.source_batch_issues = [0, 1].map(index => ({
      dataset_id: datasetId, feature_key: keys[index], part_index: 0,
      code: 'duplicate_points',
      message: '压测路线包含重复控制点，检查并合并重复点后重新生成。',
    }));
    project.source_batch_failures = [];
    project.active_source_ref = undefined;
    qa.loadProject(project);
    return { feature_count: features.length, points_per_feature: pointsPerFeature, feature_keys: keys };
  })()`;
}

async function issueClick(routeIndex) {
  return issue.evaluate(`(() => {
    const row = [...document.querySelectorAll('.generation-issue')]
      .find(item => item.innerText.includes('QA-MEMORY-${routeIndex}'));
    const button = row?.querySelector('button[aria-label^="修改："]');
    if (!button || button.disabled) throw new Error('未找到路线 QA-MEMORY-${routeIndex} 的修改按钮');
    button.click();
    return true;
  })()`);
}

const issueIndex = (value) => value?.feature_key ?? value?.featureKey ?? null;

try {
  await command("Runtime.enable");
  await command("Page.enable");
  await command("Log.enable");
  await command("Performance.enable");
  await command("HeapProfiler.enable");
  await waitFor(
    "Boolean(window.__TAURI_INTERNALS__ && window.__ROAD_WORKBENCH__ && document.querySelector('.maplibregl-canvas'))",
  );
  await waitFor("window.__ROAD_WORKBENCH__.getMap()?.isStyleLoaded()");
  originalLayout = await evaluate(
    'localStorage.getItem("road-workbench-layout")',
  );
  originalProject = await evaluate(
    "window.__ROAD_WORKBENCH__.getProject()",
    120000,
  );

  const generated = await evaluate(
    syntheticProjectExpression(5, 10000),
    120000,
  );
  assert.equal(generated.feature_count * generated.points_per_feature, 50000);
  const baseGeometry = await diagnostics();
  assert.equal(baseGeometry.source_geometry.feature_count, 5);
  assert.equal(baseGeometry.source_geometry.coordinate_count, 50000);
  assert.equal(baseGeometry.batch_geometry.coordinate_count, 50000);
  await waitFor(
    "window.__ROAD_WORKBENCH__.getDisplayMetrics().coordinate_count===50000",
    120,
  );
  await collectGarbage();
  const baselineHeap = await sampleMemory("baseline_after_gc", true);

  const existingTargets = await (await fetch(`${endpoint}/json`)).json();
  let issueTarget = existingTargets.find(
    (item) =>
      item.type === "page" &&
      item.id !== mainTarget.id &&
      /window=generation-issues/.test(item.url),
  );
  if (!issueTarget) {
    await evaluate(
      '(()=>{const button=document.querySelector("[aria-label^=\\"查看生成问题\\"]");if(!button)throw new Error("找不到生成问题摘要");button.click();return true;})()',
    );
    issueTarget = await findIssueTarget(true);
  }
  issue = connect(issueTarget, "生成问题窗口");
  await issue.opened;
  await issue.command("Runtime.enable");
  await issue.command("Page.enable");
  await waitFor(
    "Boolean(document.querySelector('.generation-issues-window.is-detached'))",
    60,
    issue.evaluate,
  );
  await waitFor(
    "document.querySelectorAll('.generation-issue').length===2",
    60,
    issue.evaluate,
  );

  let previousKey = baseGeometry.active_source_ref?.feature_key ?? null;
  let previousPoints = baseGeometry.route_points_count;
  const operationSamples = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const route = cycle % 2;
    const expectedKey = generated.feature_keys[route];
    let started = performance.now();
    await issueClick(route);
    let state = await waitForState(
      (value) =>
        issueIndex(value.active_source_ref) === expectedKey &&
        value.route_points_count === 10000,
      `edit ${cycle + 1}`,
      45,
    );
    timings.edit_ms.push(performance.now() - started);
    const afterEdit = await sampleMemory(`cycle_${cycle + 1}_edit`);
    assert(
      state.history_shared_source_count > 0,
      `编辑 ${cycle + 1} 后历史未共享原始来源结构`,
    );
    assert(
      state.history_shared_batch_count > 0,
      `编辑 ${cycle + 1} 后历史未共享批量成果结构`,
    );

    started = performance.now();
    await evaluate("window.__ROAD_WORKBENCH__.undo()");
    state = await waitForState(
      (value) =>
        issueIndex(value.active_source_ref) === previousKey &&
        value.route_points_count === previousPoints,
      `undo ${cycle + 1}`,
      45,
    );
    timings.undo_ms.push(performance.now() - started);
    await sampleMemory(`cycle_${cycle + 1}_undo`);

    started = performance.now();
    await evaluate("window.__ROAD_WORKBENCH__.redo()");
    state = await waitForState(
      (value) =>
        issueIndex(value.active_source_ref) === expectedKey &&
        value.route_points_count === 10000,
      `redo ${cycle + 1}`,
      45,
    );
    timings.redo_ms.push(performance.now() - started);
    const afterRedo = await sampleMemory(
      `cycle_${cycle + 1}_redo`,
      (cycle + 1) % 5 === 0,
    );
    operationSamples.push({
      cycle: cycle + 1,
      edit_ms: timings.edit_ms.at(-1),
      undo_ms: timings.undo_ms.at(-1),
      redo_ms: timings.redo_ms.at(-1),
      heap_after_edit_bytes: afterEdit.used_bytes,
      heap_after_redo_bytes: afterRedo.used_bytes,
      history_count: state.history_count,
      history_shared_source_count: state.history_shared_source_count,
      history_shared_batch_count: state.history_shared_batch_count,
      route_points_count: state.route_points_count,
      active_feature_key: issueIndex(state.active_source_ref),
    });
    if ((cycle + 1) % 5 === 0 || cycle + 1 === cycles)
      console.log(
        `[压力压测] ${cycle + 1}/${cycles} 轮完成，JS heap ${(afterRedo.used_bytes / 1024 / 1024).toFixed(1)} MiB，编辑 ${timings.edit_ms.at(-1).toFixed(0)} ms。`,
      );
    previousKey = expectedKey;
    previousPoints = 10000;
  }

  const finalGeometry = await diagnostics();
  assert.deepEqual(
    finalGeometry.source_geometry,
    baseGeometry.source_geometry,
    "编辑/撤销/重做不得改写来源几何或丢失控制点",
  );
  assert.deepEqual(
    finalGeometry.batch_geometry,
    baseGeometry.batch_geometry,
    "编辑/撤销/重做不得改写或丢失批量成果几何",
  );
  assert.equal(finalGeometry.route_points_count, 10000);
  assert.equal(
    issueIndex(finalGeometry.active_source_ref),
    generated.feature_keys[(cycles - 1) % 2],
  );
  const collected = await collectGarbage();
  const finalHeap = await sampleMemory("final_after_gc", true);
  check("合成来源与批量成果均完整保留 50,000 个坐标", {
    source_geometry: finalGeometry.source_geometry,
    batch_geometry: finalGeometry.batch_geometry,
  });
  check("每轮真实问题按钮编辑、撤销、重做均完成，历史共享来源/成果引用", {
    cycles,
    final_history_count: finalGeometry.history_count,
    final_shared_source_count: finalGeometry.history_shared_source_count,
    final_shared_batch_count: finalGeometry.history_shared_batch_count,
    final_route_points_count: finalGeometry.route_points_count,
  });

  const browserErrors = [...main.errors, ...issue.errors];
  assert.equal(browserErrors.length, 0, browserErrors.join("\n"));
  const report = {
    passed: true,
    endpoint,
    cycles,
    synthetic_input: generated,
    checks,
    timings: {
      edit: timingSummary(timings.edit_ms),
      undo: timingSummary(timings.undo_ms),
      redo: timingSummary(timings.redo_ms),
    },
    heap: {
      baseline_after_gc_bytes: baselineHeap.used_bytes,
      observed_peak_bytes: Math.max(...samples.map((item) => item.used_bytes)),
      final_after_gc_bytes: finalHeap.used_bytes,
      gc_supported: collected,
      samples: samples.length,
    },
    process_memory: {
      available: processMemoryAvailable,
      measurement_scope:
        "CDP监听进程及可枚举子进程工作集；不代表机器上全部WebView或GPU内存",
      baseline: baselineHeap.process_working_set ?? null,
      final: finalHeap.process_working_set ?? null,
      observed_peak_bytes: Math.max(
        0,
        ...samples
          .map((item) => item.process_working_set?.total_working_set_bytes ?? 0)
          .filter(Number.isFinite),
      ),
    },
    operation_samples: operationSamples,
    browser_errors: browserErrors,
    limitations: [
      "JS heap 为 CDP renderer heap 采样；不会覆盖 WebGL/GPU、浏览器共享内存或未纳入 CDP 进程树的其他 WebView。",
      "输入与成果为合成 GeoJSON 线几何；本脚本测编辑历史和显示路径，不测 Rust 几何生成精度。",
    ],
  };
  await fs.writeFile(
    path.join(outputDirectory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.writeFile(
    path.join(outputDirectory, "memory-samples.json"),
    JSON.stringify(samples, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      cycles,
      outputDirectory,
      heap_peak_bytes: report.heap.observed_peak_bytes,
      timings: report.timings,
    }),
  );
} catch (error) {
  const report = {
    passed: false,
    endpoint,
    cycles,
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    timings: {
      edit: timingSummary(timings.edit_ms),
      undo: timingSummary(timings.undo_ms),
      redo: timingSummary(timings.redo_ms),
    },
    samples,
    checks,
  };
  await fs.writeFile(
    path.join(outputDirectory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  throw error;
} finally {
  if (originalProject) {
    await evaluate(
      `window.__ROAD_WORKBENCH__?.loadProject(${JSON.stringify(originalProject)})`,
      120000,
    ).catch(() => {});
  }
  if (originalLayout !== undefined) {
    await evaluate(
      `localStorage.${originalLayout === null ? 'removeItem("road-workbench-layout")' : `setItem("road-workbench-layout",${JSON.stringify(originalLayout)})`}`,
    ).catch(() => {});
  }
  if (issue) {
    await issue
      .evaluate(
        'document.querySelector("[aria-label=\\"关闭生成问题窗口\\"]")?.click()',
      )
      .catch(() => {});
    issue.socket.close();
  }
  main.socket.close();
}
