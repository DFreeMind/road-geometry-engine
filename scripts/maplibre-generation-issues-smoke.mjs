import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// 复用桌面 WebView2/CDP 入口，通过真实 Tauri 命令和界面验证混合批量生成错误。
const [endpoint, outputDirectory, workspace] = process.argv.slice(2);
assert(endpoint && outputDirectory && workspace, '用法：node maplibre-generation-issues-smoke.mjs <endpoint> <outdir> <workspace>');
await fs.mkdir(outputDirectory, { recursive: true });
const require = createRequire(path.join(workspace, 'desktop-tauri', 'package.json'));
const proj4 = require('proj4');
proj4.defs('EPSG:32650', '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs');

let target;
for (let attempt = 0; attempt < 60; attempt++) {
  const targets = await (await fetch(`${endpoint}/json`)).json();
  target = targets.find(item => item.type === 'page' && item.url.includes('tauri') && !item.url.includes('window=generation-issues'));
  if (target?.webSocketDebuggerUrl) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
assert(target?.webSocketDebuggerUrl, '未找到桌面 WebView2 页面');
const mainTargetId = target.id;
// 用浏览器级 CDP 窗口 API 读取/移动真实原生顶层窗口，避免 WebView2 合成鼠标不产生 Windows 拖动消息。
const browserVersion = await (await fetch(`${endpoint}/json/version`)).json();
const browserSocket = new WebSocket(browserVersion.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { browserSocket.onopen = resolve; browserSocket.onerror = reject; });
let browserSequence = 0;
const browserPending = new Map();
browserSocket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const handler = browserPending.get(message.id);
  if (!handler) return;
  browserPending.delete(message.id);
  if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
  else handler.resolve(message.result);
};
const browserCommand = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++browserSequence;
  const timer = setTimeout(() => { browserPending.delete(id); reject(new Error(`浏览器级 CDP 命令超时：${method}`)); }, 15000);
  browserPending.set(id, {
    resolve: value => { clearTimeout(timer); resolve(value); },
    reject: error => { clearTimeout(timer); reject(error); },
  });
  browserSocket.send(JSON.stringify({ id, method, params }));
});
const nativeWindowFor = async targetId => browserCommand('Browser.getWindowForTarget', { targetId });
const setNativeWindowBounds = async (windowId, bounds) => browserCommand('Browser.setWindowBounds', { windowId, bounds });
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const browserErrors = [];
const issueErrors = [];
socket.onclose = event => {
  for (const handler of pending.values()) handler.reject(new Error(`WebView2 调试连接关闭：${event.code} ${event.reason}`));
  pending.clear();
};
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
    else handler.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    browserErrors.push(message.params.exceptionDetails.text + ':' + (message.params.exceptionDetails.exception?.description ?? ''));
  } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    browserErrors.push(message.params.args.map(item => item.description ?? item.value ?? '').join(' '));
  } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    browserErrors.push(message.params.entry.text);
  }
};
const command = (method, params = {}, timeout = 90000) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 命令超时：${method}`)); }, timeout);
  pending.set(id, {
    resolve: value => { clearTimeout(timer); resolve(value); },
    reject: error => { clearTimeout(timer); reject(error); },
  });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.exception?.value ?? result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = async (expression, seconds = 60) => {
  const limit = Date.now() + seconds * 1000;
  while (Date.now() < limit) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`等待超时：${expression}\n${await evaluate('document.body.innerText')}`);
};
const invoke = (name, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('找不到可用控件：'+${JSON.stringify(selector)});e.click();return true;})()`);
const clickText = text => evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw new Error('找不到可用按钮：'+${JSON.stringify(text)});e.click();return true;})()`);
const mouse = async (type, x, y, buttons = 0) => command('Input.dispatchMouseEvent', { type, x, y, button: type === 'mousePressed' || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mousePressed' ? 1 : 0 });
const dragMouse = async (start, end) => {
  await mouse('mouseMoved', start.x, start.y);
  await mouse('mousePressed', start.x, start.y, 1);
  await mouse('mouseMoved', end.x, end.y, 1);
  await mouse('mouseReleased', end.x, end.y);
  await new Promise(resolve => setTimeout(resolve, 100));
};
const rect = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('找不到元素：'+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()`);
const openIssuesWindow = async () => {
  if (!issuesSession) {
    const current = await (await fetch(`${endpoint}/json`)).json();
    let opened = current.find(item => item.type === 'page' && item.id !== mainTargetId && /window=generation-issues/.test(item.url));
    if (!opened) await click('[aria-label^="查看生成问题"]');
    opened ??= await issueTarget(true);
    issuesSession = await attachIssueTarget(opened);
  }
  await issueWaitFor('Boolean(document.querySelector(".generation-issues-window.is-detached"))');
  return issuesSession;
};
const setInputValue = async (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('找不到输入框：'+${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
const screenshot = async name => {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(outputDirectory, name), Buffer.from(result.data, 'base64'));
};
let issuesSession;
const attachIssueTarget = async issueTarget => {
  const issueSocket = new WebSocket(issueTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { issueSocket.onopen = resolve; issueSocket.onerror = reject; });
  let issueSequence = 0;
  const issuePending = new Map();
  const errors = issueErrors;
  issueSocket.onclose = event => {
    for (const handler of issuePending.values()) handler.reject(new Error(`独立问题窗口调试连接关闭：${event.code} ${event.reason}`));
    issuePending.clear();
  };
  issueSocket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const handler = issuePending.get(message.id);
      if (!handler) return;
      issuePending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text + ':' + (message.params.exceptionDetails.exception?.description ?? ''));
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map(item => item.description ?? item.value ?? '').join(' '));
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(message.params.entry.text);
    }
  };
  const issueCommand = (method, params = {}, timeout = 90000) => new Promise((resolve, reject) => {
    const id = ++issueSequence;
    const timer = setTimeout(() => { issuePending.delete(id); reject(new Error(`CDP 命令超时：${method}`)); }, timeout);
    issuePending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    issueSocket.send(JSON.stringify({ id, method, params }));
  });
  const issueEvaluate = async expression => {
    const result = await issueCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.exception?.value ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const issueWaitFor = async (expression, seconds = 60) => {
    const limit = Date.now() + seconds * 1000;
    while (Date.now() < limit) {
      if (await issueEvaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`等待独立窗口超时：${expression}\n${await issueEvaluate('document.body.innerText')}`);
  };
  const issueClick = selector => issueEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('找不到可用控件：'+${JSON.stringify(selector)});e.click();return true;})()`);
  const issueRect = selector => issueEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('找不到元素：'+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()`);
  const issueMouse = (type, x, y, buttons = 0) => issueCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mousePressed' || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mousePressed' ? 1 : 0 });
  const issueDragMouse = async (start, end) => {
    await issueMouse('mouseMoved', start.x, start.y);
    await issueMouse('mousePressed', start.x, start.y, 1);
    await new Promise(resolve => setTimeout(resolve, 180));
    await issueMouse('mouseMoved', end.x, end.y, 1);
    await issueMouse('mouseReleased', end.x, end.y);
    await new Promise(resolve => setTimeout(resolve, 500));
  };
  const issueScreenshot = async name => {
    const result = await issueCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(outputDirectory, name), Buffer.from(result.data, 'base64'));
  };
  const issueSetInputValue = (selector, value) => issueEvaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('找不到输入框：'+${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await issueCommand('Runtime.enable');
  await issueCommand('Page.enable');
  await issueCommand('Log.enable');
  return { id: issueTarget.id, socket: issueSocket, command: issueCommand, evaluate: issueEvaluate, waitFor: issueWaitFor, click: issueClick, rect: issueRect, screenshot: issueScreenshot, setInputValue: issueSetInputValue, dragMouse: issueDragMouse, errors };
};
const issueTarget = async (present = true) => {
  const limit = Date.now() + 20000;
  while (Date.now() < limit) {
    const targets = await (await fetch(`${endpoint}/json`)).json();
    const found = targets.find(item => item.type === 'page' && item.id !== mainTargetId && /window=generation-issues/.test(item.url));
    if (present ? found : !found) return found;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const targets = await (await fetch(`${endpoint}/json`)).json();
  throw new Error(present
    ? `未发现独立问题 WebView target：${targets.map(item => `${item.id} ${item.url}`).join('\n')}`
    : `关闭后独立问题 WebView target 仍存在：${targets.map(item => `${item.id} ${item.url}`).join('\n')}`);
};
const closeIssueConnection = () => {
  issuesSession?.socket.close();
  issuesSession = undefined;
};
const issueEvaluate = (...args) => issuesSession.evaluate(...args);
const issueWaitFor = (...args) => issuesSession.waitFor(...args);
const issueClick = (...args) => issuesSession.click(...args);
const issueRect = (...args) => issuesSession.rect(...args);
const issueScreenshot = (...args) => issuesSession.screenshot(...args);
const issueSetInputValue = (...args) => issuesSession.setInputValue(...args);
const checks = [];
const check = (name, details) => checks.push({ name, passed: true, details });
let originalLayout;
let originalProject;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function hash(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Log.enable');
  originalLayout = await evaluate('localStorage.getItem("road-workbench-layout")');
  originalProject = await evaluate('window.__ROAD_WORKBENCH__?.getProject()');
  await waitFor('Boolean(window.__TAURI_INTERNALS__&&window.__ROAD_WORKBENCH__&&document.querySelector(".maplibregl-canvas"))');
  await waitFor('window.__ROAD_WORKBENCH__.getMap()?.isStyleLoaded()');
  originalProject = await evaluate('window.__ROAD_WORKBENCH__.getProject()');

  const routeId = { valid: 'QA-ISSUE-VALID', invalid: 'QA-ISSUE-SINGLE', engine: 'QA-ISSUE-REPEATED' };
  const features = [
    { type: 'Feature', id: 'qa-valid', properties: { route_id: routeId.valid }, geometry: { type: 'LineString', coordinates: [[116.3000, 39.9000], [116.3010, 39.9000]] } },
    { type: 'Feature', id: 'qa-single-point', properties: { route_id: routeId.invalid }, geometry: { type: 'LineString', coordinates: [[116.3020, 39.9000]] } },
    { type: 'Feature', id: 'qa-repeated-points', properties: { route_id: routeId.engine }, geometry: { type: 'LineString', coordinates: [[116.3030, 39.9000], [116.3030, 39.9000], [116.3030, 39.9000]] } },
  ];
  const featureKeys = features.map(feature => `fid:${encodeURIComponent(feature.id)}:${hash(canonical(feature))}`);
  const metricCrs = 'EPSG:32650';
  const center = [116.3015, 39.9000];
  const section = {
    left_lanes: [3.5], right_lanes: [3.5], median_width: 0,
    left_emergency_width: 0, right_emergency_width: 0,
    left_shoulder_width: 0, right_shoulder_width: 0,
    left_slope_width: 0, right_slope_width: 0,
  };
  const dataset = {
    id: 'qa-generation-issues', kind: 'route-source',
    source_label: 'generation-issues-smoke', label: '生成问题烟测来源',
    collection: { type: 'FeatureCollection', features },
    fields: [{ name: 'route_id', type: 'text' }], binding: null,
    visible: true, feature_keys: featureKeys, excluded_keys: [],
    mapping: { route_id: 'route_id' }, manual_section: section, revision: 1,
  };
  const project = {
    ...originalProject,
    schema_version: 2,
    input_version: 1,
    route_id: routeId.valid,
    route_points: [],
    route_source: dataset.source_label,
    section,
    manual_section: structuredClone(section),
    scene_options: { ...(originalProject.scene_options ?? {}), enabled: [] },
    output: null,
    last_generated_input_version: null,
    road_output_cleared: true,
    vector_basemaps: [dataset],
    source_mapping: { route_id: 'route_id' },
    source_batch_output: null,
    source_batch_issues: [],
    source_batch_failures: [],
    source_batch_metrics: null,
    active_source_ref: null,
    surface_component_exclusions: [],
    manual_facilities: [],
    view: { center, zoom: 14, pitch: 0, bearing: 0 },
  };
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(project)})`);
  await click('[aria-label="数据"]');
  await waitFor('Boolean(document.querySelector(".source-dataset-manager"))');

  // 通过真实 Tauri IPC 调用 Rust 引擎，确保重复点样本确实无法生成。
  const repeatedPoints = [[448300, 4420000], [448300, 4420000], [448300, 4420000]];
  let repeatedEngineError = '';
  try {
    const response = await invoke('generate_road', {
      request: { route_id: routeId.engine, points: repeatedPoints, crs: metricCrs, source: dataset.source_label, section, scene_options: project.scene_options },
      jobId: `generation-issues-engine-probe-${Date.now()}`,
    });
    if (response?.error) repeatedEngineError = String(response.error);
  } catch (error) {
    repeatedEngineError = String(error);
  }
  assert(repeatedEngineError, '连续重复坐标路线未被真实 Rust 引擎拒绝，需调整烟测样本');
  check('连续重复坐标由真实 Rust 引擎拒绝', { reason: repeatedEngineError });

  await clickText('生成全部参与路线');
  await waitFor(`(()=>{const p=window.__ROAD_WORKBENCH__.getProject();return p.source_batch_output?.results?.some(r=>r.source_properties?.route_id===${JSON.stringify(routeId.valid)}&&r.response)&&p.source_batch_issues?.some(i=>i.feature_key===${JSON.stringify(featureKeys[1])})&&p.source_batch_failures?.some(i=>i.feature_key===${JSON.stringify(featureKeys[2])});})()`, 120);
  const first = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  const successful = first.source_batch_output.results.find(result => result.source_properties.route_id === routeId.valid);
  const failed = first.source_batch_failures.find(issue => issue.feature_key === featureKeys[2]);
  const invalid = first.source_batch_issues.find(issue => issue.feature_key === featureKeys[1]);
  assert(successful?.response && !successful.error, '有效路线成果必须提交');
  assert(invalid && /至少需要两个坐标点/.test(invalid.message), '单点路线必须作为校验问题保留');
  assert(failed && failed.message, '重复坐标路线必须作为引擎错误保留');
  assert.equal(first.source_batch_output.results.some(result => result.feature_key === featureKeys[1]), false, '校验失败路线不能伪装成引擎结果');
  assert.equal(first.source_batch_output.results.find(result => result.feature_key === featureKeys[2])?.error, failed.message, '输出结果中的失败原因应和引擎失败记录一致');
  assert.equal(first.source_batch_output.results.find(result => result.feature_key === featureKeys[0]).request.points, undefined, '保存的请求应只保留 point_count，不复制坐标数组');
  await openIssuesWindow();
  await issueWaitFor(`(()=>{const text=document.querySelector('.generation-issues-window')?.innerText||'';return text.includes(${JSON.stringify(routeId.invalid)})&&text.includes(${JSON.stringify(routeId.engine)});})()`);
  assert(await issueEvaluate(`(()=>{const row=[...document.querySelectorAll('.generation-issues-window .generation-issue')].find(e=>e.innerText.includes(${JSON.stringify(routeId.invalid)}));return Boolean(row&&row.innerText.includes('校验')&&row.innerText.includes('生成问题烟测来源'));})()`), '独立窗口应显示校验阶段、来源和路线');
  assert(await issueEvaluate(`(()=>{const row=[...document.querySelectorAll('.generation-issues-window .generation-issue')].find(e=>e.innerText.includes(${JSON.stringify(routeId.engine)}));return Boolean(row&&row.innerText.includes('生成')&&row.querySelector('[aria-label^="重试："]')&&row.querySelector('[aria-label^="定位："]'));})()`), '独立窗口应显示引擎阶段并提供重试和定位');
  assert(await evaluate('Boolean(document.querySelector(".generation-issues__summary")&&document.querySelector(".generation-issues .generation-issue")==null)'), '侧栏应只保留紧凑摘要，不内联渲染问题行');
  const detachedResources = await issueEvaluate('performance.getEntriesByType("resource").map(item=>new URL(item.name).pathname)');
  assert.equal(await issueEvaluate('Boolean(window.__ROAD_WORKBENCH__||document.querySelector(".maplibregl-canvas")||window.maplibregl)'), false, '独立问题窗口不得加载主工作台或 MapLibre 实例');
  assert.equal(detachedResources.some(resource => /(?:^|\/)App-[^/]+\.js$|(?:^|\/)maplibre-gl-[^/]+\.js$/i.test(resource)), false, '独立问题窗口不得加载 App 或 MapLibre JavaScript bundle');
  check('问题窗口使用独立轻量 WebView，不加载完整工作台和地图', { target_id: issuesSession.id, resources: detachedResources.length });
  check('整体生成保留有效成果并分别记录校验与引擎失败', {
    successful_route: routeId.valid,
    validation_code: invalid.code,
    engine_code: failed.code,
    compact_request: true,
  });
  await issueClick('[aria-label^="定位：生成问题烟测来源，QA-ISSUE-REPEATED"]');
  await waitFor('document.body.innerText.includes("已定位问题路线：QA-ISSUE-REPEATED")');
  await waitFor('Math.abs(window.__ROAD_WORKBENCH__.getMap().getCenter().lng-116.303)<0.0001');
  await issueWaitFor('Boolean(document.querySelector(".generation-issues-window.is-detached")&&!document.querySelector(".generation-issues-window.is-minimized"))');
  await issueScreenshot('01-mixed-generation-issues.png');
  const visibleWindow = await issueEvaluate(`(()=>{
    const panel=document.querySelector('.generation-issues-window');
    const row=document.querySelector('.generation-issue');
    const bounds=panel.getBoundingClientRect();
    const rowBounds=row.getBoundingClientRect();
    return {insideRoot:Boolean(document.querySelector('#root').contains(panel)),top:bounds.top,bottom:bounds.bottom,height:bounds.height,viewportHeight:innerHeight,rowTop:rowBounds.top,rowBottom:rowBounds.bottom};
  })()`);
  assert(visibleWindow.insideRoot && visibleWindow.top >= 0 && visibleWindow.bottom <= visibleWindow.viewportHeight + 1 && visibleWindow.height > 300 && visibleWindow.rowTop >= 0 && visibleWindow.rowBottom <= visibleWindow.viewportHeight, '独立窗口和问题行必须真正处于可见视口，不能仅验证隐藏的 DOM');
  check('问题列表在独立窗口可见视口内渲染', visibleWindow);

  const mainBounds = await evaluate('({left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight})');
  const initialNativeBounds = await issueEvaluate('({left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight})');
  const mainWindow = await nativeWindowFor(mainTargetId);
  const issueWindow = await nativeWindowFor(issuesSession.id);
  const titlebar = await issueRect('.generation-issues-window__drag-handle');
  await issuesSession.dragMouse(
    { x: Math.min(titlebar.left + 180, titlebar.right - 20), y: titlebar.top + titlebar.height / 2 },
    { x: Math.min(titlebar.left + 760, titlebar.right - 10), y: titlebar.top + titlebar.height / 2 + 30 },
  );
  const movedNativeBounds = await issueEvaluate('({left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight})');
  const movedNative = Math.abs(movedNativeBounds.left - initialNativeBounds.left) > 30 || Math.abs(movedNativeBounds.top - initialNativeBounds.top) > 20;
  const outsideMain = movedNativeBounds.left < mainBounds.left || movedNativeBounds.top < mainBounds.top || movedNativeBounds.left + movedNativeBounds.width > mainBounds.left + mainBounds.width || movedNativeBounds.top + movedNativeBounds.height > mainBounds.top + mainBounds.height;
  let verifiedWindowBounds = (await nativeWindowFor(issuesSession.id)).bounds;
  if (!movedNative || !outsideMain) {
    // CDP 的 Input.dispatchMouseEvent 对 WebView2 仅合成网页输入，未必会驱动 Windows 原生标题栏移动。
    // 通过浏览器级窗口控制器设置真实 HWND bounds，再从窗口自身 screenX/screenY 交叉核验。
    const desiredLeft = Math.round(mainWindow.bounds.left + mainWindow.bounds.width + 48);
    const desiredTop = Math.round(mainWindow.bounds.top + 48);
    await setNativeWindowBounds(issueWindow.windowId, { left: desiredLeft, top: desiredTop, width: issueWindow.bounds.width, height: issueWindow.bounds.height, windowState: 'normal' });
    const boundsDeadline = Date.now() + 5000;
    while (Date.now() < boundsDeadline) {
      verifiedWindowBounds = (await nativeWindowFor(issuesSession.id)).bounds;
      if (Math.abs(verifiedWindowBounds.left - desiredLeft) < 30 && Math.abs(verifiedWindowBounds.top - desiredTop) < 30) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  const verifiedNativeBounds = await issueEvaluate('({left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight})');
  const verifiedOutsideMain = verifiedWindowBounds.left < mainWindow.bounds.left || verifiedWindowBounds.top < mainWindow.bounds.top || verifiedWindowBounds.left + verifiedWindowBounds.width > mainWindow.bounds.left + mainWindow.bounds.width || verifiedWindowBounds.top + verifiedWindowBounds.height > mainWindow.bounds.top + mainWindow.bounds.height;
  const verifiedMoved = Math.abs(verifiedWindowBounds.left - issueWindow.bounds.left) > 30 || Math.abs(verifiedWindowBounds.top - issueWindow.bounds.top) > 20;
  assert(verifiedMoved, `独立问题窗口原生 bounds 应实际移动：${JSON.stringify({ main: mainWindow.bounds, initial: issueWindow.bounds, after_titlebar_drag: movedNativeBounds, verified: verifiedWindowBounds, issueErrors })}`);
  assert(verifiedOutsideMain, `独立问题窗口应能移动到主窗口 bounds 之外：${JSON.stringify({ main: mainWindow.bounds, initial: issueWindow.bounds, after_titlebar_drag: movedNativeBounds, verified: verifiedWindowBounds, issueErrors })}`);
  check('独立窗口可移出主窗口原生范围', { main: mainWindow.bounds, initial: issueWindow.bounds, after_titlebar_drag: movedNativeBounds, verified: verifiedWindowBounds, drag_moved: movedNative, outside_main: verifiedOutsideMain });

  await issueClick('[aria-label="关闭生成问题窗口"]');
  const closedTargetId = issuesSession.id;
  await issueTarget(false);
  closeIssueConnection();
  await waitFor('document.querySelector(".generation-issues__summary")!==null');
  await openIssuesWindow();
  await issueWaitFor('document.hasFocus()');
  assert.notEqual(issuesSession.id, closedTargetId, '关闭后重开应创建新的独立 WebView target');
  check('独立窗口关闭后销毁，重开创建新窗口并获得焦点');

  await issueClick('[aria-label^="修改：生成问题烟测来源，QA-ISSUE-REPEATED"]');
  await waitFor(`document.querySelector(${JSON.stringify('[aria-label="道路"][aria-pressed="true"]')})!==null`);
  await click('[aria-label="数据"]');
  await waitFor(`document.querySelector(${JSON.stringify('[aria-label="数据"][aria-pressed="true"]')})!==null`);
  const resumedProject = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  resumedProject.source_batch_issues.push({
    dataset_id: 'qa-generation-issues',
    feature_key: featureKeys[0],
    code: 'qa_bridge_sync',
    message: 'QA bridge sync after panel remount',
  });
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(resumedProject)})`);
  await issueWaitFor('document.body.innerText.includes("QA bridge sync after panel remount")');
  check('切换到路线编辑页后返回数据页，独立窗口继续接收最新问题摘要');

  const pendingSave = path.join(outputDirectory, 'generation-pending-failures.json');
  await invoke('save_project', {path: pendingSave, project: first});
  const pendingReopened = await invoke('load_project', {path: pendingSave});
  assert.deepEqual(pendingReopened.source_batch_failures, first.source_batch_failures, '未解决的引擎错误也必须随工程保存');
  assert.deepEqual(pendingReopened.source_batch_issues, first.source_batch_issues);

  await issueClick('[aria-label^="重试：生成问题烟测来源，QA-ISSUE-REPEATED"]');
  await waitFor('window.__ROAD_WORKBENCH__.getProject().source_batch_metrics?.reused===1', 120);
  const retried = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  assert.equal(retried.source_batch_metrics.computed, 1, '重试应只处理失败路线');
  assert.equal(retried.source_batch_metrics.reused, 1, '重试应复用已有成功路线');
  assert.deepEqual(retried.source_batch_output.results.find(result => result.feature_key === featureKeys[0]).response, successful.response, '重试失败项不得重算或覆盖已有成功成果');
  check('单条重试复用成功路线', { computed: retried.source_batch_metrics.computed, reused: retried.source_batch_metrics.reused });

  const repaired = structuredClone(retried);
  repaired.vector_basemaps[0].collection.features[2].geometry.coordinates = [[116.3030, 39.9000], [116.3040, 39.9000]];
  repaired.vector_basemaps[0].revision += 1;
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(repaired)})`);
  await click('.generation-issues__retry-summary');
  await waitFor(`(()=>{const p=window.__ROAD_WORKBENCH__.getProject();return p.source_batch_output?.results?.some(r=>r.feature_key===${JSON.stringify(featureKeys[2])}&&r.response)&&!p.source_batch_failures?.some(i=>i.feature_key===${JSON.stringify(featureKeys[2])});})()`, 120);
  await issueWaitFor(`![...document.querySelectorAll('.generation-issue')].some(row=>row.innerText.includes(${JSON.stringify(routeId.engine)}))`);
  const fixed = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  assert(fixed.source_batch_issues.some(issue => issue.feature_key === featureKeys[1]), '修复引擎错误不应清除无关校验问题');
  assert(fixed.source_batch_output.results.find(result => result.feature_key === featureKeys[2]).response, '修复原始坐标后应生成成果');
  check('修正来源坐标并重生成后清除对应引擎错误', { remaining_validation_issues: fixed.source_batch_issues.length, engine_failures: fixed.source_batch_failures.length });

  const savedPath = path.join(outputDirectory, 'generation-issues-project.json');
  await invoke('save_project', { path: savedPath, project: fixed });
  const reopened = await invoke('load_project', { path: savedPath });
  assert.deepEqual(reopened.source_batch_issues, fixed.source_batch_issues, '保存重开应保留校验问题');
  assert.deepEqual(reopened.source_batch_failures, fixed.source_batch_failures, '保存重开应保留引擎失败记录');
  assert.equal(reopened.source_batch_output.results.find(result => result.feature_key === featureKeys[2])?.response !== undefined, true, '保存重开应保留修复后的成果');
  check('校验问题、引擎错误及混合生成成果保存重开可恢复', { path: savedPath });

  // 把 Rust 回归样本作为当前来源的新路线，由真实批量命令生成并展示几何复核提示。
  const repairOffsets = [
    [0.0, 0.0],
    [4.077453484467959, -3.1727885861797924],
    [8.21578697633181, -10.938921486947251],
    [15.367065973220019, -14.165903044387537],
    [22.722830146639048, -8.302218164735702],
    [24.57536336774256, -9.235636653429756],
    [27.78565576905552, -13.269810194861883],
  ];
  const repairRouteId = 'QA-ISSUE-OFFSET-REPAIR';
  const repairFeature = {
    type: 'Feature', id: 'qa-offset-repair',
    properties: { route_id: repairRouteId },
    geometry: {
      type: 'LineString',
      coordinates: repairOffsets.map(([x, y]) => proj4(metricCrs, 'EPSG:4326', [448300 + x, 4420000 + y])),
    },
  };
  const repairSection = {
    ...section,
    left_lanes: [9.763136114814849], right_lanes: [1.0],
  };
  const reviewProject = structuredClone(fixed);
  const reviewDataset = reviewProject.vector_basemaps[0];
  reviewDataset.collection.features.push(repairFeature);
  reviewDataset.feature_keys.push(`fid:${encodeURIComponent(repairFeature.id)}:${hash(canonical(repairFeature))}`);
  reviewDataset.manual_section = repairSection;
  reviewDataset.revision += 1;
  reviewProject.source_batch_output = null;
  reviewProject.source_batch_issues = [];
  reviewProject.source_batch_failures = [];
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(reviewProject)})`);
  await clickText('生成全部参与路线');
  await waitFor(`(()=>{const p=window.__ROAD_WORKBENCH__.getProject();return p.source_batch_output?.results?.some(r=>r.source_properties?.route_id===${JSON.stringify(repairRouteId)}&&r.response?.geometry_warnings?.some(w=>w.code==="offset_local_loop_trimmed"));})()`, 120);
  const reviewResult = await evaluate(`window.__ROAD_WORKBENCH__.getProject().source_batch_output.results.find(r=>r.source_properties?.route_id===${JSON.stringify(repairRouteId)})`);
  assert(reviewResult?.response?.geometry_warnings?.some(w => w.code === 'offset_local_loop_trimmed'), '真实 Rust 批量生成应返回局部偏移环修复警告');
  const reviewOutput = await evaluate('window.__ROAD_WORKBENCH__.getProject().source_batch_output');
  assert.equal(reviewOutput.dataset_revisions['qa-generation-issues'], reviewDataset.revision, '复核警告必须来自当前来源 revision');
  assert.equal(reviewOutput.scene_key, JSON.stringify([reviewProject.scene_options.enabled ?? [], reviewProject.scene_options.spacing_m ?? 50, reviewProject.scene_options.offset_m ?? 1, reviewProject.scene_options.side ?? 'both']), '复核警告必须来自当前场景参数');
  assert(reviewResult.input_signature && reviewResult.key, '真实批量结果必须带来源签名与任务 key');
  await issueWaitFor(`(()=>{const row=[...document.querySelectorAll('.generation-issues-window .generation-issue')].find(e=>e.innerText.includes(${JSON.stringify(repairRouteId)}));return Boolean(row&&row.innerText.includes('需复核')&&row.querySelector('[aria-label^="重试："]')?.disabled);})()`);
  assert(await issueEvaluate(`(()=>{const row=[...document.querySelectorAll('.generation-issues-window .generation-issue')].find(e=>e.innerText.includes(${JSON.stringify(repairRouteId)}));return Boolean(row&&row.innerText.includes('offset_local_loop_trimmed')&&row.innerText.includes('偏移')&&row.innerText.includes('源控制点')&&row.innerText.includes('几何里程估算'));})()`), '真实引擎警告应显示复核阶段、偏移量、源控制点及几何里程');
  check('真实 Rust 局部偏移环修复结果显示为不可重试的复核问题', { route: repairRouteId, warning: reviewResult.response.geometry_warnings.find(w => w.code === 'offset_local_loop_trimmed') });

  await issueClick('[aria-label="关闭生成问题窗口"]');
  await issueTarget(false);
  closeIssueConnection();
  const summaryBeforeOverflow = await rect('.generation-issues__summary');
  const overflowProject = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  overflowProject.source_batch_issues.push(...Array.from({ length: 125 }, (_, index) => ({
    dataset_id: 'qa-generation-issues',
    code: 'qa_overflow', message: `QA 合成分页问题 ${index + 1} qa-overflow-${String(index).padStart(3, '0')}`,
  })));
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(overflowProject)})`);
  await waitFor('Number(document.querySelector(".generation-issues__summary")?.getAttribute("aria-label")?.split("共 ")[1]?.split(" 条")[0])>100');
  const summaryAfterOverflow = await rect('.generation-issues__summary');
  assert(Math.abs(summaryAfterOverflow.height - summaryBeforeOverflow.height) < 1, '超过 100 条问题时侧栏摘要高度不应增长');
  assert.equal(await evaluate('document.querySelectorAll(".generation-issues .generation-issue").length'), 0, '大量问题不得内联撑开侧栏');
  await openIssuesWindow();
  await issueWaitFor('Boolean(document.querySelector(".generation-issues-window__pagination")?.innerText.includes("/ 7")&&document.querySelectorAll(".generation-issues-window .generation-issue").length<=20)');
  assert(await issueEvaluate('Boolean(document.querySelector(".generation-issues-window__pagination")?.innerText.includes("/ 7")&&document.querySelectorAll(".generation-issues-window .generation-issue").length<=20)'), '超过 100 条问题应在独立窗口中分页显示');
  for (let page = 1; page < 7; page++) await issueClick('[aria-label="下一页"]');
  await issueWaitFor('document.querySelector(".generation-issues-window__pagination")?.innerText.includes("7 / 7")');
  assert(await issueEvaluate('document.querySelectorAll(".generation-issues-window .generation-issue").length>0&&document.querySelectorAll(".generation-issues-window .generation-issue").length<=20'), '最后一页应只渲染剩余问题');
  await issueSetInputValue('[aria-label="搜索完整原因、来源或路线"]', 'qa-overflow-124');
  await issueWaitFor('document.querySelectorAll(".generation-issues-window .generation-issue").length===1');
  assert(await issueEvaluate('document.querySelector(".generation-issues-window .generation-issue")?.innerText.includes("qa-overflow-124")'), '原生 setter 加 input 事件应触发 React 搜索过滤');
  await issueSetInputValue('[aria-label="搜索完整原因、来源或路线"]', '');
  await issueWaitFor('document.querySelector(".generation-issues-window__pagination")?.innerText.includes("1 / 7")');
  check('125 条合成问题在摘要不扩高并可搜索和分页', { summary_height: summaryAfterOverflow.height, pages: 7 });

  const allBrowserErrors = [...browserErrors, ...issueErrors];
  assert.equal(allBrowserErrors.length, 0, allBrowserErrors.join('\n'));
  await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: true, checks, browserErrors: allBrowserErrors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, outputDirectory }));
} catch (error) {
  await screenshot('failure.png').catch(() => {});
  const allBrowserErrors = [...browserErrors, ...issueErrors];
  await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, checks, error: String(error), browserErrors: allBrowserErrors }, null, 2));
  throw error;
} finally {
  if (originalProject) await evaluate(`window.__ROAD_WORKBENCH__?.loadProject(${JSON.stringify(originalProject)})`).catch(() => {});
  if (originalLayout !== undefined) await evaluate(`localStorage.${originalLayout === null ? 'removeItem("road-workbench-layout")' : `setItem("road-workbench-layout",${JSON.stringify(originalLayout)})`}`).catch(() => {});
  if (issuesSession) {
    await issueClick('[aria-label="关闭生成问题窗口"]').catch(() => {});
    await issueTarget(false).catch(() => {});
    closeIssueConnection();
  }
  socket.close();
  browserSocket.close();
}
