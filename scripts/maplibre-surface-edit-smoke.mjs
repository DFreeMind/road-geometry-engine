import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// 复用桌面烟测的 WebView2/CDP 入口，只通过真实地图点击和界面操作验证成果编辑。
const [endpoint, outputDirectory, workspace] = process.argv.slice(2);
assert(endpoint && outputDirectory && workspace, '用法：node maplibre-surface-edit-smoke.mjs <endpoint> <outdir> <workspace>');
await fs.mkdir(outputDirectory, { recursive: true });
const require = createRequire(path.join(workspace, 'desktop-tauri', 'package.json'));
const proj4 = require('proj4');
proj4.defs('EPSG:32650', '+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs +type=crs');

let target;
for (let attempt = 0; attempt < 60; attempt++) {
  const targets = await (await fetch(`${endpoint}/json`)).json();
  target = targets.find(item => item.type === 'page' && item.url.includes('tauri'));
  if (target?.webSocketDebuggerUrl) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
assert(target?.webSocketDebuggerUrl, '未找到桌面 WebView2 页面');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const browserErrors = [];
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
const waitFor = async (expression, seconds = 45) => {
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
const queueDialog = (type, file) => evaluate(`window.__ROAD_WORKBENCH__.dialogs.${type}.push(${JSON.stringify(file)})`);
const screenshot = async name => {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(outputDirectory, name), Buffer.from(result.data, 'base64'));
};
const checkList = [];
const check = (name, details) => checkList.push({ name, passed: true, details });
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
function geometrySignature(response) {
  const layers = response?.layers ?? response?.outputs?.layers ?? [];
  return JSON.stringify([...(response?.feature_collection?.features ?? []).map(feature => [feature.properties, feature.geometry]), ...layers.map(layer => {
    const collection = layer.collection ?? layer.geojson ?? layer.feature_collection;
    return collection?.features?.map(feature => [feature.properties, feature.geometry]) ?? [];
  })]);
}
async function clickGeneratedFill(partIndex) {
  const probe = () => evaluate(`(()=>{
    const map=window.__ROAD_WORKBENCH__.getMap();
    const layers=map.getStyle().layers.filter(layer=>/^output-.*-fill$/.test(layer.id));
    for(const layer of layers){
      const features=map.querySourceFeatures(layer.source);
      for(const feature of features){
        if(feature.geometry.type!=='Polygon'&&feature.geometry.type!=='MultiPolygon')continue;
        if(${partIndex === null ? 'false' : `Number(feature.properties?.part_index)!==${partIndex}`})continue;
        const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
        for(const polygon of polygons){
          const ring=polygon[0];if(!ring?.length)continue;
          const center=ring.slice(0,-1).reduce((sum,p)=>[sum[0]+p[0]/(ring.length-1),sum[1]+p[1]/(ring.length-1)],[0,0]);
          const projected=map.project(center);
          const hit=map.queryRenderedFeatures(projected,{layers:[layer.id]});
          if(!hit.length)continue;
          const bounds=map.getCanvas().getBoundingClientRect();
          return {x:projected.x+bounds.left,y:projected.y+bounds.top,properties:hit[0].properties,layer:layer.id};
        }
      }
    }
    return null;
  })()`);
  let point = await probe();
  const deadline = Date.now() + 10000;
  while (!point && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    point = await probe();
  }
  assert(point, `没有找到可真实点击的 Polygon fill${partIndex === null ? '' : `，部件 ${partIndex + 1}`}`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return point;
}
async function openSelectedSurface(partIndex) {
  await click('[aria-label="编辑路面成果"]');
  const point = await clickGeneratedFill(partIndex);
  await waitFor('Boolean(document.querySelector(".generated-surface-editor"))');
  await waitFor('window.__ROAD_WORKBENCH__.getMap().getStyle().sources["road-surface-selection"]?.data?.features?.length>0');
  assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getMap().getStyle().layers.at(-1).id'), 'road-surface-selection-fill', '选中高亮应位于路面材质上方');
  return point;
}
async function typeText(selector, text) {
  const bounds = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('找不到输入框');const r=e.getBoundingClientRect();e.focus();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...bounds, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bounds, button: 'left', clickCount: 1 });
  // 明确选中输入框原文本，再通过真实输入事件替换，避免 WebView2 未实现的合成快捷键。
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await command('Input.insertText', { text });
}
async function confirmSurfaceDelete() {
  await clickText('确认删除');
}

try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Log.enable');
  originalLayout = await evaluate('localStorage.getItem("road-workbench-layout")');
  await evaluate('localStorage.removeItem("road-workbench-layout")');
  await command('Page.reload');
  await waitFor('Boolean(window.__TAURI_INTERNALS__&&window.__ROAD_WORKBENCH__&&document.querySelector(".maplibregl-canvas"))');
  await waitFor('window.__ROAD_WORKBENCH__.getMap()?.isStyleLoaded()');
  originalProject = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  const metricCrs = 'EPSG:32650';
  const manualCenter = proj4(metricCrs, 'EPSG:4326', [448300, 4420000]);
  const section = {
    left_lanes: [3.5, 3.5], right_lanes: [3.5, 3.5], median_width: 1.5,
    left_emergency_width: 0, right_emergency_width: 0,
    left_shoulder_width: 0.5, right_shoulder_width: 0.5,
    left_slope_width: 0, right_slope_width: 0,
  };
  const routePoints = [[448000, 4420000], [448300, 4420000], [448600, 4420020]];
  const sceneOptions = { enabled: [], spacing_m: 50, offset_m: 1, side: 'both' };
  const request = { route_id: 'QA-SURFACE-MANUAL', points: routePoints, crs: metricCrs, source: 'surface-edit-smoke', section, scene_options: sceneOptions };
  const nativeResponse = await invoke('generate_road', { request, jobId: `surface-edit-${Date.now()}` });
  assert(geometrySignature(nativeResponse).length > 10, '本地引擎必须返回真实成果图层');
  const manualProject = {
    ...originalProject,
    schema_version: 2,
    input_version: 1,
    route_id: request.route_id,
    crs: metricCrs,
    route_points: routePoints,
    route_source: request.source,
    section,
    manual_section: structuredClone(section),
    scene_options: sceneOptions,
    source_batch_output: null,
    vector_basemaps: [],
    surface_component_exclusions: [],
    manual_facilities: [],
    facility_display_scale: 1.3,
    output: { input_version: 1, response: nativeResponse },
    last_generated_input_version: 1,
    road_output_cleared: false,
    view: { center: manualCenter, zoom: 16, pitch: 0, bearing: 0 },
  };
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(manualProject)})`);
  await waitFor('window.__ROAD_WORKBENCH__.getMap().getStyle().layers.some(layer=>/^output-.*-fill$/.test(layer.id))');
  await evaluate(`void window.__ROAD_WORKBENCH__.getMap().jumpTo({center:${JSON.stringify(manualCenter)},zoom:16})`);
  await waitFor('window.__ROAD_WORKBENCH__.getMap().areTilesLoaded()');
  const firstSurface = await openSelectedSurface(null);
  await waitFor('document.querySelector(".generated-surface-editor__part")?.innerText==="部件 1"');
  await screenshot('01-surface-editor.png');
  const beforeEdit = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  const beforeGeometry = geometrySignature(beforeEdit.output.response);
  await typeText('[aria-label="左侧车道宽度，逗号分隔"]', '4.25, 3.75');
  await typeText('[aria-label="右侧车道宽度，逗号分隔"]', '3.25, 3.5');
  await clickText('应用宽度并重生成');
  await waitFor(`window.__ROAD_WORKBENCH__.getProject().output?.input_version===${beforeEdit.input_version + 1}`, 90);
  const editedManual = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  assert.deepEqual(editedManual.section.left_lanes, [4.25, 3.75]);
  assert.deepEqual(editedManual.section.right_lanes, [3.25, 3.5]);
  assert.equal(editedManual.output.input_version, editedManual.input_version);
  assert.notEqual(geometrySignature(editedManual.output.response), beforeGeometry, '宽度变更必须产生不同的真实几何结果');
  await waitFor('document.querySelector(".generated-surface-editor__apply")?.disabled===false');
  await screenshot('02-surface-edited-widths.png');
  check('原生米制生成与地图真实命中后编辑左右宽度', {
    fill: firstSurface.layer,
    input_version: [beforeEdit.input_version, editedManual.input_version],
    left_lanes: editedManual.section.left_lanes,
    right_lanes: editedManual.section.right_lanes,
    geometry_changed: true,
  });

  const editedGeometry = geometrySignature(editedManual.output.response);
  await click('[aria-label="撤销上一步"]');
  await waitFor(`window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]===${section.left_lanes[0]}&&window.__ROAD_WORKBENCH__.getProject().output?.input_version===window.__ROAD_WORKBENCH__.getProject().input_version`, 60);
  const undoneWidth = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  assert.deepEqual(undoneWidth.section.left_lanes, section.left_lanes);
  assert.deepEqual(undoneWidth.section.right_lanes, section.right_lanes);
  assert.notEqual(geometrySignature(undoneWidth.output.response), editedGeometry, '撤销宽度修改必须恢复先前成果几何');
  await click('[aria-label="重做上一步"]');
  await waitFor(`window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]===4.25&&window.__ROAD_WORKBENCH__.getProject().output?.input_version===window.__ROAD_WORKBENCH__.getProject().input_version`, 60);
  const redoneWidth = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  assert.deepEqual(redoneWidth.section.left_lanes, editedManual.section.left_lanes);
  assert.equal(geometrySignature(redoneWidth.output.response), editedGeometry, '重做必须恢复编辑后的生成响应');
  check('宽度编辑支持撤销和重做，并同步恢复匹配版本的生成响应', {
    undo_input_version: undoneWidth.input_version,
    redo_input_version: redoneWidth.input_version,
    undo_and_redo_geometry_verified: true,
  });

  const deletionHit = await openSelectedSurface(null);
  const selectedComponent = {
    part_index: Number(deletionHit.properties.part_index ?? 0),
    component: String(deletionHit.properties.component ?? ''),
    ...(deletionHit.properties.side == null ? {} : { side: String(deletionHit.properties.side) }),
    ...(deletionHit.properties.lane_index == null ? {} : { lane_index: Number(deletionHit.properties.lane_index) }),
  };
  assert(selectedComponent.component, '真实点击选中的路面要素必须带组成属性');
  const selectedSource = await evaluate(`window.__ROAD_WORKBENCH__.getMap().getLayer(${JSON.stringify(deletionHit.layer)}).source`);
  const matchingSourceCount = await evaluate(`(()=>{
    const map=window.__ROAD_WORKBENCH__.getMap();
    return map.querySourceFeatures(${JSON.stringify(selectedSource)}).filter(feature=>{
      const p=feature.properties??{};return Number(p.part_index??0)===${selectedComponent.part_index}&&p.component===${JSON.stringify(selectedComponent.component)}${selectedComponent.side === undefined ? '' : `&&String(p.side??"")===${JSON.stringify(selectedComponent.side)}`}${selectedComponent.lane_index === undefined ? '' : `&&Number(p.lane_index)===${selectedComponent.lane_index}`};
    }).length;
  })()`);
  assert(matchingSourceCount > 0, '地图 Worker 中应能查到实际被点击的组成');
  const rawManualResponse = JSON.stringify(redoneWidth.output.response);
  await evaluate('document.querySelector(".generated-surface-editor__delete-actions button:first-child").click()');
  await waitFor('document.body.innerText.includes("删除选中组成？")');
  await confirmSurfaceDelete();
  await waitFor(`window.__ROAD_WORKBENCH__.getProject().surface_component_exclusions?.some(item=>item.part_index===${selectedComponent.part_index}&&item.component===${JSON.stringify(selectedComponent.component)}${selectedComponent.side === undefined ? '' : `&&item.side===${JSON.stringify(selectedComponent.side)}`}${selectedComponent.lane_index === undefined ? '' : `&&item.lane_index===${selectedComponent.lane_index}`})`);
  await waitFor(`(()=>{
    const map=window.__ROAD_WORKBENCH__.getMap();
    return map.querySourceFeatures(${JSON.stringify(selectedSource)}).filter(feature=>{
      const p=feature.properties??{};return Number(p.part_index??0)===${selectedComponent.part_index}&&p.component===${JSON.stringify(selectedComponent.component)}${selectedComponent.side === undefined ? '' : `&&String(p.side??"")===${JSON.stringify(selectedComponent.side)}`}${selectedComponent.lane_index === undefined ? '' : `&&Number(p.lane_index)===${selectedComponent.lane_index}`};
    }).length===0;
  })()`, 60);
  // 数据源替换时瓦片可能暂时为空，必须等其他成果真正重新进入渲染线程。
  await waitFor(`window.__ROAD_WORKBENCH__.getMap().querySourceFeatures(${JSON.stringify(selectedSource)}).some(feature=>feature.properties?.component!==${JSON.stringify(selectedComponent.component)})`, 60);
  const afterComponentDelete = await evaluate(`(()=>{
    const p=window.__ROAD_WORKBENCH__.getProject(),map=window.__ROAD_WORKBENCH__.getMap(),bounds=map.getCanvas().getBoundingClientRect();
    const rendered=map.queryRenderedFeatures([${deletionHit.x}-bounds.left,${deletionHit.y}-bounds.top],{layers:[${JSON.stringify(deletionHit.layer)}]});
    const features=map.querySourceFeatures(${JSON.stringify(selectedSource)});
    return {project:p,features,rendered};
  })()`);
  assert.equal(JSON.stringify(afterComponentDelete.project.output.response), rawManualResponse, '删除显示组成不能改写原生生成响应');
  assert(afterComponentDelete.features.some(feature => feature.properties?.component !== selectedComponent.component), '删除一个组成后地图 Worker 的其他成果仍需保留');
  assert(!afterComponentDelete.rendered.some(feature => {
    const p=feature.properties??{};return Number(p.part_index??0)===selectedComponent.part_index&&p.component===selectedComponent.component&&(selectedComponent.side===undefined||String(p.side??'')===selectedComponent.side)&&(selectedComponent.lane_index===undefined||Number(p.lane_index)===selectedComponent.lane_index);
  }), '被删组成在原点击位置不能继续渲染');
  await click('[aria-label="撤销上一步"]');
  await waitFor('window.__ROAD_WORKBENCH__.getProject().surface_component_exclusions?.length===0');
  check('删除选中组成保留其他成果并可通过实际撤销恢复', {
    removed_component: selectedComponent.component,
    selected_selector: selectedComponent,
    worker_features_before: matchingSourceCount,
    worker_features_after: 0,
    other_components_retained: true,
    native_response_preserved: true,
  });

  await evaluate('document.querySelector(".generated-surface-editor__delete-actions button:nth-child(2)").click()');
  await waitFor('document.body.innerText.includes("删除此路段成果？")');
  await confirmSurfaceDelete();
  await waitFor('window.__ROAD_WORKBENCH__.getProject().surface_component_exclusions?.some(item=>item.part_index===0&&!item.component)');
  await clickText('恢复此路段原规则');
  await waitFor('window.__ROAD_WORKBENCH__.getProject().surface_component_exclusions?.length===0', 90);
  await waitFor('window.__ROAD_WORKBENCH__.getProject().output?.input_version===window.__ROAD_WORKBENCH__.getProject().input_version');
  check('整段成果可删除并由原规则恢复后重新生成', {
    exclusions_cleared: true,
    input_version: await evaluate('window.__ROAD_WORKBENCH__.getProject().input_version'),
  });

  const manualSave = path.join(outputDirectory, 'surface-edit-project.json');
  await queueDialog('save', manualSave);
  await click('[aria-label="保存项目"]');
  await waitFor('document.body.innerText.includes("项目已保存")');
  const persistedManual = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  await queueDialog('open', manualSave);
  await click('[aria-label="打开项目"]');
  await waitFor('document.body.innerText.includes("已打开项目")');
  await waitFor(`window.__ROAD_WORKBENCH__.getProject().route_id===${JSON.stringify(request.route_id)}&&window.__ROAD_WORKBENCH__.getProject().output?.input_version===${persistedManual.output.input_version}`, 60);
  const reopenedManual = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  assert.deepEqual(reopenedManual.section, persistedManual.section);
  assert.equal(geometrySignature(reopenedManual.output.response), geometrySignature(persistedManual.output.response));
  await screenshot('03-surface-project-reopened.png');
  check('宽度规则、删除恢复状态与生成响应通过 UI 保存并重新打开', {
    project_path: manualSave,
    input_version: reopenedManual.input_version,
    output_version: reopenedManual.output.input_version,
  });

  // 构造三个真实米制路线部件；GeoJSON 地理坐标和请求投影均由同一 proj4 版本互转。
  const batchSection = structuredClone(section);
  const metricParts = [
    [[448000, 4420000], [448240, 4420000]],
    [[448000, 4420120], [448240, 4420120]],
    [[448000, 4420240], [448240, 4420240]],
  ];
  const batchCenter = proj4(metricCrs, 'EPSG:4326', [448120, 4420120]);
  const geographicParts = metricParts.map(part => part.map(point => proj4(metricCrs, 'EPSG:4326', point)));
  const feature = {
    type: 'Feature',
    id: 'qa-multiline-3part',
    properties: { route_id: 'QA-SURFACE-MULTI', note: '三个独立部件' },
    geometry: { type: 'MultiLineString', coordinates: geographicParts },
  };
  const featureKey = `fid:${encodeURIComponent(feature.id)}:${hash(canonical(feature))}`;
  const datasetId = 'qa-multiline-3part';
  const sourceLabel = 'surface-edit-smoke-multiline';
  const mapping = { route_id: 'route_id' };
  const dataset = {
    id: datasetId,
    kind: 'route-source',
    source_label: sourceLabel,
    label: sourceLabel,
    collection: { type: 'FeatureCollection', features: [feature] },
    fields: [{ name: 'route_id', type: 'text' }],
    binding: null,
    visible: true,
    feature_keys: [featureKey],
    excluded_keys: [],
    mapping,
    manual_section: batchSection,
    revision: 1,
  };
  const results = [];
  for (let partIndex = 0; partIndex < geographicParts.length; partIndex++) {
    const points = geographicParts[partIndex].map(point => proj4('EPSG:4326', metricCrs, point));
    const taskRequest = {
      route_id: feature.properties.route_id,
      points,
      crs: metricCrs,
      source: sourceLabel,
      section: batchSection,
      scene_options: sceneOptions,
    };
    const inputSignature = hash(canonical({
      request: {
        ...taskRequest,
        scene_options: {
          enabled: taskRequest.scene_options.enabled ?? [],
          spacing_m: taskRequest.scene_options.spacing_m ?? 50,
          offset_m: taskRequest.scene_options.offset_m ?? 1,
          side: taskRequest.scene_options.side ?? 'both',
        },
      },
      properties: feature.properties,
    }));
    const response = await invoke('generate_road', { request: taskRequest, jobId: `surface-part-${partIndex}-${Date.now()}` });
    assert(geometrySignature(response).length > 10, `部件 ${partIndex + 1} 未返回真实生成结果`);
    results.push({
      key: `${encodeURIComponent(datasetId)}/${encodeURIComponent(featureKey)}/${partIndex}`,
      dataset_id: datasetId,
      feature_key: featureKey,
      part_index: partIndex,
      input_signature: inputSignature,
      source_properties: structuredClone(feature.properties),
      response,
      request: { ...taskRequest, points: undefined, point_count: points.length },
    });
  }
  const staleDatasetId = 'qa-stale-revision';
  const staleFeature = {
    type: 'Feature',
    id: 'qa-stale-feature',
    properties: { route_id: 'QA-STALE', note: 'revision 不匹配的旧来源结果' },
    geometry: { type: 'LineString', coordinates: geographicParts[0] },
  };
  const staleFeatureKey = `fid:${encodeURIComponent(staleFeature.id)}:${hash(canonical(staleFeature))}`;
  const staleDataset = {
    ...dataset,
    id: staleDatasetId,
    source_label: 'stale-revision-source',
    label: 'stale-revision-source',
    collection: { type: 'FeatureCollection', features: [staleFeature] },
    feature_keys: [staleFeatureKey],
    revision: 2,
  };
  const staleResult = {
    ...results[0],
    key: `${encodeURIComponent(staleDatasetId)}/${encodeURIComponent(staleFeatureKey)}/0`,
    dataset_id: staleDatasetId,
    feature_key: staleFeatureKey,
    source_properties: structuredClone(staleFeature.properties),
  };
  const batchProject = {
    ...reopenedManual,
    route_id: 'QA-SURFACE-MULTI',
    route_points: [],
    route_source: sourceLabel,
    section: batchSection,
    manual_section: batchSection,
    scene_options: sceneOptions,
    vector_basemaps: [dataset, staleDataset],
    source_batch_output: {
      results: [...results, staleResult],
      total: results.length + 1,
      completed: results.length + 1,
      dataset_revisions: { [datasetId]: dataset.revision, [staleDatasetId]: 1 },
      scene_key: JSON.stringify([sceneOptions.enabled, sceneOptions.spacing_m, sceneOptions.offset_m, sceneOptions.side]),
      issues: [],
    },
    output: null,
    surface_component_exclusions: [],
    view: { center: batchCenter, zoom: 15.5, pitch: 0, bearing: 0 },
  };
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(batchProject)})`);
  await waitFor('window.__ROAD_WORKBENCH__.getProject().source_batch_output?.results.length===4');
  await waitFor(`(()=>{
    const map=window.__ROAD_WORKBENCH__.getMap();
    return map.getStyle().layers.filter(layer=>/^output-.*-fill$/.test(layer.id)).some(layer=>
      map.querySourceFeatures(layer.source).some(feature=>feature.properties?.source_dataset_id===${JSON.stringify(datasetId)}&&feature.properties?.source_feature_key===${JSON.stringify(featureKey)}&&Number(feature.properties?.part_index)===2)
    );
  })()`, 60);
  await evaluate(`void window.__ROAD_WORKBENCH__.getMap().jumpTo({center:${JSON.stringify(batchCenter)},zoom:15.5})`);
  await waitFor('window.__ROAD_WORKBENCH__.getMap().areTilesLoaded()');
  const rawSourceBefore = JSON.stringify(feature);
  const beforeBatch = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  const beforeResults = new Map(beforeBatch.source_batch_output.results.filter(result => result.dataset_id === datasetId).map(result => [result.part_index, result]));
  assert.equal(beforeBatch.source_batch_output.results.length, 4);
  const beforeSelectedPartMapGeometry = await evaluate(`(()=>{
    const map=window.__ROAD_WORKBENCH__.getMap();
    const layer=map.getStyle().layers.find(item=>/^output-.*-fill$/.test(item.id)&&map.querySourceFeatures(item.source).some(feature=>feature.properties?.source_dataset_id===${JSON.stringify(datasetId)}&&Number(feature.properties?.part_index)===2));
    return JSON.stringify(map.querySourceFeatures(layer.source).filter(feature=>feature.properties?.source_dataset_id===${JSON.stringify(datasetId)}&&feature.properties?.source_feature_key===${JSON.stringify(featureKey)}&&Number(feature.properties?.part_index)===2).map(feature=>feature.geometry));
  })()`);
  const staleBeforeStyles = await evaluate('window.__ROAD_WORKBENCH__.getMap().getStyle()');
  assert(!Object.entries(staleBeforeStyles.sources).filter(([id])=>id.startsWith('output-')).some(([,source])=>source.data?.features?.some(feature=>feature.properties?.source_dataset_id===staleDatasetId)), '旧 revision 的生成响应不能显示在地图上，原始参考线仍可保留');
  const selectedPoint = await openSelectedSurface(2);
  await waitFor('document.querySelector(".generated-surface-editor__part")?.innerText==="部件 3"');
  await screenshot('04-multiline-selected-part.png');
  await typeText('[aria-label="左侧车道宽度，逗号分隔"]', '4.5, 3.25');
  await typeText('[aria-label="右侧车道宽度，逗号分隔"]', '3.0, 3.25');
  await clickText('应用宽度并重生成');
  await waitFor(`(()=>{
    const p=window.__ROAD_WORKBENCH__.getProject(),result=p.source_batch_output?.results.find(item=>item.part_index===2);
    return p.vector_basemaps[0].route_overrides?.[${JSON.stringify(featureKey)}]?.part_sections?.["2"]?.left_lanes?.[0]===4.5&&result?.response&&result.input_signature!==${JSON.stringify(beforeResults.get(2).input_signature)}&&!p.source_batch_output.results.some(item=>item.dataset_id===${JSON.stringify(staleDatasetId)});
  })()`, 90);
  await waitFor(`(()=>{
    const map=window.__ROAD_WORKBENCH__.getMap();
    const layer=map.getStyle().layers.find(item=>/^output-.*-fill$/.test(item.id)&&map.querySourceFeatures(item.source).some(feature=>feature.properties?.source_dataset_id===${JSON.stringify(datasetId)}&&Number(feature.properties?.part_index)===2));
    if(!layer)return false;
    const geometry=JSON.stringify(map.querySourceFeatures(layer.source).filter(feature=>feature.properties?.source_dataset_id===${JSON.stringify(datasetId)}&&feature.properties?.source_feature_key===${JSON.stringify(featureKey)}&&Number(feature.properties?.part_index)===2).map(feature=>feature.geometry));
    return geometry!==${JSON.stringify(beforeSelectedPartMapGeometry)};
  })()`, 60);
  const afterBatchEdit = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  const afterResults = new Map(afterBatchEdit.source_batch_output.results.filter(result => result.dataset_id === datasetId).map(result => [result.part_index, result]));
  const editedPart = afterResults.get(2);
  assert(editedPart.input_signature !== beforeResults.get(2).input_signature, '所选部件的输入签名必须随宽度变化');
  assert.notEqual(geometrySignature(editedPart.response), geometrySignature(beforeResults.get(2).response), '所选部件必须重新生成几何');
  for (const partIndex of [0, 1]) {
    assert.equal(afterResults.get(partIndex).input_signature, beforeResults.get(partIndex).input_signature, `未选部件 ${partIndex + 1} 的签名应保持不变`);
    assert.equal(JSON.stringify(afterResults.get(partIndex).response), JSON.stringify(beforeResults.get(partIndex).response), `未选部件 ${partIndex + 1} 的响应应保持不变`);
  }
  assert.equal(JSON.stringify(afterBatchEdit.vector_basemaps[0].collection.features[0]), rawSourceBefore, '编辑不应改写原始 MultiLineString 来源记录');
  assert.deepEqual(afterBatchEdit.vector_basemaps[0].route_overrides[featureKey].part_sections['2'].left_lanes, [4.5, 3.25]);
  assert.equal(afterBatchEdit.source_batch_output.dataset_revisions[datasetId], afterBatchEdit.vector_basemaps[0].revision);
  assert(!afterBatchEdit.source_batch_output.results.some(result => result.dataset_id === staleDatasetId), '局部重生成不能重新写入旧 revision 来源响应');
  check('MultiLineString 三部件只重算真实选中部件', {
    clicked: selectedPoint.properties.part_index,
    target_signature_changed: true,
    other_signatures_and_responses_unchanged: true,
    raw_source_unchanged: true,
  });

  // 设施显示控件只改变 UI 倍率；真实位置、几何及道路输入签名均保持原样。
  const pointTemplate = originalProject.catalog.entries.find(entry => entry.geometry === 'Point');
  assert(pointTemplate, '项目模板目录缺少 Point 设施模板');
  const facility = { id: 'qa-facility-marker', kind: 'qa', x: 448120, y: 4420050, route_id: 'QA-SURFACE-MULTI', confirmed: true, template: pointTemplate };
  const beforeFacilityProject = {
    ...afterBatchEdit,
    manual_facilities: [facility],
    facility_display_scale: 1.3,
  };
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify(beforeFacilityProject)})`);
  await waitFor('window.__ROAD_WORKBENCH__.getProject().manual_facilities.length===1');
  await evaluate(`void window.__ROAD_WORKBENCH__.getMap().jumpTo({center:${JSON.stringify(proj4(metricCrs, 'EPSG:4326', [facility.x, facility.y]))},zoom:18})`);
  await waitFor('window.__ROAD_WORKBENCH__.getMap().areTilesLoaded()');
  await click('button.rail-item[aria-label="设施"]');
  await waitFor('Boolean(document.querySelector(".facility-display-settings input[type=range]"))');
  const beforeScaleState = await evaluate(`(()=>{
    const p=window.__ROAD_WORKBENCH__.getProject(),map=window.__ROAD_WORKBENCH__.getMap();
    const feature=map.querySourceFeatures('road-facilities').find(item=>item.properties?.id==='qa-facility-marker');
    return {project:p,geometry:feature?.geometry};
  })()`);
  const beforeScale = beforeScaleState.project;
  assert(beforeScaleState.geometry, '地图设施源应包含实际设施几何');
  const scaleBounds = await evaluate('(()=>{const e=document.querySelector(".facility-display-settings input[type=range]"),r=e.getBoundingClientRect();e.focus();return {x:r.x+r.width*.8,y:r.y+r.height/2}})()');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...scaleBounds, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...scaleBounds, button: 'left', clickCount: 1 });
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' });
  await waitFor('window.__ROAD_WORKBENCH__.getProject().facility_display_scale===3');
  const afterScale = await evaluate(`(()=>{
    const p=window.__ROAD_WORKBENCH__.getProject(),map=window.__ROAD_WORKBENCH__.getMap();
    const feature=map.querySourceFeatures('road-facilities').find(item=>item.properties?.id==='qa-facility-marker');
    return {project:p,geometry:feature?.geometry,iconSize:map.getLayoutProperty('road-facility-icons','icon-size'),markerRadius:map.getPaintProperty('road-facility-points','circle-radius')};
  })()`);
  assert.equal(JSON.stringify(afterScale.project.manual_facilities[0]), JSON.stringify(beforeScale.manual_facilities[0]));
  assert.deepEqual(afterScale.geometry, beforeScaleState.geometry, '符号倍率不能改变 MapLibre 中的设施几何副本');
  assert.equal(afterScale.project.input_version, beforeScale.input_version);
  assert.equal(geometrySignature(afterScale.project.source_batch_output.results.find(result => result.part_index === 2).response), geometrySignature(beforeScale.source_batch_output.results.find(result => result.part_index === 2).response));
  assert.deepEqual(afterScale.project.source_batch_output.results.map(result => result.input_signature), beforeScale.source_batch_output.results.map(result => result.input_signature), '符号倍率不能改变来源任务签名');
  assert.deepEqual(afterScale.project.scene_options, beforeScale.scene_options, '符号倍率不能改变道路 scene options');
  const hasTopLevelZoom = expression => Array.isArray(expression) && expression[0] === 'interpolate' && JSON.stringify(expression[2]) === '["zoom"]';
  assert(hasTopLevelZoom(afterScale.iconSize), '设施 icon-size 应为顶层 zoom interpolate');
  assert(hasTopLevelZoom(afterScale.markerRadius), '设施 marker radius 应为顶层 zoom interpolate');
  assert(await evaluate('document.querySelector(".facility-display-settings__footer span")?.innerText==="符号大小仅影响显示，非真实尺寸"'));
  await screenshot('05-facility-closeup-scale-3.png');
  check('设施近景显示倍率可调且不改变实际坐标、几何、输入版本或生成签名', {
    scale: afterScale.project.facility_display_scale,
    icon_size_zoom_expression: true,
    marker_radius_zoom_expression: true,
    metric_geometry_unchanged: true,
  });

  // 删除来源部件中的实际命中组成，并检验排除规则同时作用于导出和工程保存。
  await evaluate(`void window.__ROAD_WORKBENCH__.getMap().jumpTo({center:${JSON.stringify(batchCenter)},zoom:16})`);
  const sourceDeletionHit = await openSelectedSurface(2);
  await evaluate('document.querySelector(".generated-surface-editor__delete-actions button:first-child").click()');
  await waitFor('document.body.innerText.includes("删除选中组成？")');
  await confirmSurfaceDelete();
  await waitFor(`window.__ROAD_WORKBENCH__.getProject().vector_basemaps[0].route_overrides[${JSON.stringify(featureKey)}].component_exclusions?.length===1`);
  const deletionProject = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  const persistedSelector = deletionProject.vector_basemaps[0].route_overrides[featureKey].component_exclusions[0];
  assert.equal(persistedSelector.part_index, 2);
  assert.equal(persistedSelector.component, sourceDeletionHit.properties.component);
  const matchesDeletion = feature => {
    const p=feature.properties??{};
    return p.source_dataset_id===datasetId&&p.source_feature_key===featureKey&&Number(p.part_index)===persistedSelector.part_index&&p.component===persistedSelector.component&&(persistedSelector.side===undefined||p.side===persistedSelector.side)&&(persistedSelector.lane_index===undefined||Number(p.lane_index)===persistedSelector.lane_index);
  };
  const deletionExport = path.join(outputDirectory, 'surface-deletion-export.geojson');
  await queueDialog('save', deletionExport);
  await clickText('文件');
  await clickText('导出 GeoJSON（WGS84）…');
  await waitFor('document.body.innerText.includes("WGS84 GeoJSON 已导出")');
  const exported = JSON.parse(await fs.readFile(deletionExport, 'utf8'));
  assert(!exported.features.some(matchesDeletion), '导出不得包含已删除的来源组成');
  assert(exported.features.some(feature=>feature.properties?.source_dataset_id===datasetId&&Number(feature.properties?.part_index)===0), '删除第三部件组成不影响第一部件导出');
  check('来源组成删除规则用于WGS84导出且不影响其他部件', {selector:persistedSelector, exported_features:exported.features.length});

  // UI 当前项目路径沿用第一次手绘闭环保存的文件；再次保存并重开同一路径。
  const finalSave = manualSave;
  await click('[aria-label="保存项目"]');
  await waitFor('document.body.innerText.includes("项目已保存")');
  const persisted = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  await queueDialog('open', finalSave);
  await click('[aria-label="打开项目"]');
  await waitFor('document.body.innerText.includes("已打开项目")');
  await waitFor(`window.__ROAD_WORKBENCH__.getProject().facility_display_scale===3&&window.__ROAD_WORKBENCH__.getProject().source_batch_output?.results.length===3`, 60);
  const reopened = await evaluate('window.__ROAD_WORKBENCH__.getProject()');
  assert.deepEqual(reopened.vector_basemaps[0].route_overrides, persisted.vector_basemaps[0].route_overrides);
  assert.deepEqual(reopened.manual_facilities[0], persisted.manual_facilities[0]);
  assert.equal(reopened.facility_display_scale, 3);
  assert.deepEqual(reopened.source_batch_output.results.map(result => result.input_signature), persisted.source_batch_output.results.map(result => result.input_signature));
  const savedOnDisk = JSON.parse(await fs.readFile(finalSave, 'utf8'));
  assert.deepEqual(savedOnDisk.vector_basemaps[0].route_overrides[featureKey].component_exclusions, [persistedSelector]);
  await waitFor(`(()=>{const map=window.__ROAD_WORKBENCH__.getMap();return Object.entries(map.getStyle().sources).filter(([id])=>id.startsWith('output-')).some(([,source])=>source.data?.features?.some(feature=>feature.properties?.source_dataset_id===${JSON.stringify(datasetId)}));})()`);
  const reopenedVisible = await evaluate(`Object.entries(window.__ROAD_WORKBENCH__.getMap().getStyle().sources).filter(([id])=>id.startsWith('output-')).flatMap(([,source])=>source.data?.features??[])`);
  assert(!reopenedVisible.some(matchesDeletion), '重新打开工程后已删除组成不得重新显示');
  check('来源部件宽度覆盖、原始设施几何和显示倍率在保存重开后保留', {
    project_path: finalSave,
    facility_display_scale: reopened.facility_display_scale,
    result_count: reopened.source_batch_output.results.length,
  });

  // 验证真实 Rust 标线经过显示分块后仍保留分类、车道数量和虚实线样式。
  const markedOptions = { ...sceneOptions, enabled: ['markings'] };
  const markedResponse = await invoke('generate_road', { request: { ...request, scene_options: markedOptions }, jobId: `lane-markings-probe-${Date.now()}` });
  assert.equal(markedResponse.left_lane_count, section.left_lanes.length);
  assert.equal(markedResponse.right_lane_count, section.right_lanes.length);
  await evaluate(`window.__ROAD_WORKBENCH__.loadProject(${JSON.stringify({ ...reopened, route_id: request.route_id, route_points: routePoints, crs: metricCrs, section, active_source_ref: undefined, surface_component_exclusions: [], scene_options: markedOptions, output: { input_version: reopened.input_version, response: markedResponse } })})`);
  await waitFor(`(()=>{const map=window.__ROAD_WORKBENCH__.getMap();return Object.entries(map.getStyle().sources).filter(([id])=>id.startsWith('output-')).some(([,source])=>source.data?.features?.some(feature=>feature.properties?.marking_class==='lane'));})()`);
  const markingStyle = await evaluate(`(()=>{const map=window.__ROAD_WORKBENCH__.getMap();const style=map.getStyle();return {dashed:style.layers.find(layer=>layer.id.endsWith('-markings-dashed')),solid:style.layers.find(layer=>layer.id.endsWith('-markings-solid')),lane: Object.entries(style.sources).filter(([id])=>id.startsWith('output-')).flatMap(([,source])=>source.data?.features??[]).find(feature=>feature.properties?.component==='lane')?.properties};})()`);
  assert.deepEqual(markingStyle.dashed.paint['line-dasharray'], [3, 2]);
  assert.equal(markingStyle.solid.paint['line-dasharray'], undefined);
  assert.equal(markingStyle.lane.left_lane_count, section.left_lanes.length);
  assert.equal(markingStyle.lane.right_lane_count, section.right_lanes.length);
  check('真实标线保留车道分类和数量，地图区分虚线与实线', { left: markedResponse.left_lane_count, right: markedResponse.right_lane_count });
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: true, checks: checkList, browserErrors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checkList.length, outputDirectory }));
} catch (error) {
  await screenshot('failure.png').catch(() => {});
  await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ passed: false, checks: checkList, error: String(error), browserErrors }, null, 2));
  throw error;
} finally {
  if (originalProject) await evaluate(`window.__ROAD_WORKBENCH__?.loadProject(${JSON.stringify(originalProject)})`).catch(() => {});
  if (originalLayout !== undefined) await evaluate(`localStorage.${originalLayout === null ? 'removeItem("road-workbench-layout")' : `setItem("road-workbench-layout",${JSON.stringify(originalLayout)})`}`).catch(() => {});
  socket.close();
}
