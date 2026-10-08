import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 在独立 WebView2 工作台中发送真实鼠标和键盘输入，不用 DOM click 或直接修改工程绕过控件。
const [endpoint, outputDirectory] = process.argv.slice(2);
await fs.mkdir(outputDirectory, { recursive: true });
let target;
for (let attempt = 0; attempt < 80; attempt++) {
  const targets = await (await fetch(`${endpoint}/json`)).json();
  target = targets.find(item => item.type === 'page' && item.url.includes('tauri'));
  if (target) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
assert(target?.webSocketDebuggerUrl, '未找到 Tauri 工作台');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const errors = [];
const imageResponses = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler?.reject(new Error(JSON.stringify(message.error)));
    else handler?.resolve(message.result);
  } else if (message.method === 'Network.responseReceived' && message.params.response.mimeType.startsWith('image/')) {
    imageResponses.push({url:message.params.response.url,status:message.params.response.status});
  } else if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
};
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`调试命令超时：${method}`)); }, 15000);
  pending.set(id, {
    resolve: value => { clearTimeout(timer); resolve(value); },
    reject: error => { clearTimeout(timer); reject(error); },
  });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (expression, seconds = 30) => {
  const limit = Date.now() + seconds * 1000;
  while (Date.now() < limit) { if (await evaluate(expression)) return; await pause(100); }
  throw new Error(`等待控件状态超时：${expression}`);
};
const point = async selector => evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node || node.disabled || !node.getClientRects().length) throw new Error('控件不可操作：' + ${JSON.stringify(selector)});
  node.scrollIntoView({block:'nearest',inline:'nearest'});
  const bounds = node.getBoundingClientRect();
  return {x:bounds.x+bounds.width/2, y:bounds.y+bounds.height/2};
})()`);
const click = async selector => {
  const position = await point(selector);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
  await pause(80);
};
const key = async (keyName, code, keyCode, modifiers = 0) => {
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
  await pause(60);
};
const fill = async (selector, value) => {
  await click(selector);
  await key('a', 'KeyA', 65, 2);
  await command('Input.insertText', { text: String(value) });
  await pause(100);
};
const screenshot = async name => {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(outputDirectory, name), Buffer.from(result.data, 'base64'));
};
const checks = [];
const check = (name, details) => checks.push({name, passed:true, details});

// 用测试线段通过实际导入与底图控件进入各区域；线段仅用于定位，不冒充真实道路案例。
const cases = process.env.ROAD_REGIONAL_MAP_CASES
  ? JSON.parse(process.env.ROAD_REGIONAL_MAP_CASES)
  : [
      {id:'swisstopo-swissimage',search:'SWISSIMAGE',center:[7.4474,46.948],urlPart:'ch.swisstopo.swissimage',credit:'swisstopo'},
      {id:'basemap-at-orthofoto',search:'basemap.at',center:[16.3738,48.2082],urlPart:'bmaporthofoto30cm',credit:'basemap.at'},
      {id:'cuzk-orthophoto',search:'捷克',center:[14.4378,50.0755],urlPart:'ORTOFOTO/MapServer',credit:'ČÚZK'},
    ];
assert(cases.length, '需要指定区域底图用例');
try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await waitFor('Boolean(window.__ROAD_WORKBENCH__ && document.querySelector("[data-testid=workbench-start-page]"))');
  for (const item of cases) {
    const fixture = path.join(outputDirectory,item.id+'-location.geojson');
    const [lon,lat] = item.center;
    await fs.writeFile(fixture,JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:'底图测试定位线段'},geometry:{type:'LineString',coordinates:[[lon-.002,lat],[lon+.002,lat]]}}]}));
    await evaluate(`window.__ROAD_WORKBENCH__.dialogs.open.push(${JSON.stringify(fixture)})`);
    await click('[aria-label="导入路线"]');
    await waitFor('Boolean(document.querySelector("[aria-label=选择当前页]"))');
    await click('[aria-label="选择当前页"]');
    await click('.route-feature-selector .dialog-actions button.primary');
    await waitFor('!document.querySelector(".dialog-backdrop") && !document.querySelector("[data-testid=workbench-start-page]")');
    await click('[aria-label="缩放到路线"]');
    await pause(500);
    const camera = await evaluate('window.__ROAD_WORKBENCH__.getMap().getCenter().toArray()');
    assert(Math.abs(camera[0]-lon)<.02 && Math.abs(camera[1]-lat)<.02, '实际导入定位不正确');
    const layersBefore=await evaluate('window.__ROAD_WORKBENCH__.getProject().vector_basemaps');
    await click('[aria-label="底图设置"]');
    await fill('.basemap-picker__search input',item.search);
    await click('[data-basemap-id="'+item.id+'"]');
    for (let step=0; step<(item.zoomOut??0); step++) {
      await click('.maplibregl-ctrl-zoom-out');
      await pause(350);
    }
    await waitFor('window.__ROAD_WORKBENCH__.getMap().isSourceLoaded("user-xyz")',45);
    await pause(400);
    // 原生瓦片不经过浏览器网络面板；检查已解码并上传到渲染器的瓦片纹理。
    const responses=item.native
      ? await evaluate('Object.values(window.__ROAD_WORKBENCH__.getMap().style.tileManagers["user-xyz"]._inViewTiles._tiles).filter(t=>t.state==="loaded"&&t.texture).map(t=>({state:t.state,transport:"native"}))')
      : imageResponses.filter(r=>r.url.includes(item.urlPart)&&r.status===200);
    assert(responses.length, '工作台未收到区域影像瓦片：'+item.id);
    assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getProject().vector_basemaps'),layersBefore);
    const attribution=await evaluate('document.querySelector(".maplibregl-ctrl-attrib").innerText');
    assert(attribution.includes(item.credit), '未显示来源署名');
    await screenshot(item.id+'-workbench.png');
    check(item.id,{center:camera,credit:attribution,imageResponses:responses.slice(0,3)});
    await key('n','KeyN',78,2);
    await waitFor('Boolean(document.querySelector("[aria-label=放弃当前工程更改]"))');
    await click('[aria-label="放弃当前工程更改"]');
    await waitFor('Boolean(document.querySelector("[data-testid=workbench-start-page]"))');
  }
  assert.equal(errors.length,0,errors.join('\n'));
  await fs.writeFile(path.join(outputDirectory,'regional-map-report.json'),JSON.stringify({checks,errors,input:'真实鼠标键盘；文件选择只注入定位线段路径'},null,2));
  console.log(JSON.stringify({passed:checks.length,outputDirectory}));
} catch(error) {
  await screenshot('failure.png').catch(()=>undefined);
  await fs.writeFile(path.join(outputDirectory,'failure.json'),JSON.stringify({checks,error:String(error),errors},null,2));
  throw error;
} finally {socket.close();}
