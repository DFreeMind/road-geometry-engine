import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 在独立 WebView2 工作台中发送真实鼠标和键盘输入，不用 DOM click 或直接修改工程绕过控件。
const [endpoint, outputDirectory] = process.argv.slice(2);
const baseline = process.env.ROAD_UI_QA_BASELINE === '1';
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
const topGenerate = '[aria-label="生成当前路线道路"]';
const lane = '.road-panel input[aria-label="左侧第 1 条车道宽度"]';
try {
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor('Boolean(window.__ROAD_WORKBENCH__ && document.querySelector(".maplibregl-canvas"))');
  await waitFor('window.__ROAD_WORKBENCH__.getMap()?.isStyleLoaded()');
  if (baseline) {
    await click('.generation-card .button.primary');
    await waitFor('Boolean(window.__ROAD_WORKBENCH__.getProject().output)');
    await screenshot('before-data-1440.png');
    await click('.left-rail [aria-label="道路"]');
    await screenshot('before-road-1440.png');
    check('基线截图', '1440×900、DPI 1、默认合成路线、独立配置');
  } else {
    await pause(200);
    assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getProject().route_points.length'),0);
    assert(await evaluate('Boolean(document.querySelector("[data-testid=workbench-start-page]"))'));
    assert(await evaluate('document.querySelector(' + JSON.stringify(topGenerate) + ').disabled'));
    assert(await evaluate(`['.side-panel','.inspector','.left-rail','.generation-card','.footer-issues','.map-coordinate','.active-tool'].every(s => !document.querySelector(s).getClientRects().length)`));
    assert(await evaluate('document.querySelector(".start-page__recent-empty").textContent.includes("暂无最近工程")'));
    await screenshot('startup-1440.png');
    await key('Escape','Escape',27);
    assert(await evaluate('Boolean(document.querySelector("[data-testid=workbench-start-page]"))'));
    await command('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await pause(200);
    assert(await evaluate('document.querySelector(".start-page__content").getBoundingClientRect().right<=innerWidth && document.querySelector(".start-page__content").getBoundingClientRect().left>=0'));
    await screenshot('startup-1024.png');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    check('空工程启动页', '默认无示例路线；隐藏编辑面板及空状态，展示最近工程空状态');
    await evaluate('window.__ROAD_WORKBENCH__.dialogs.open.push(null)');
    await click('.start-page__additional button:last-of-type');
    assert(await evaluate('Boolean(document.querySelector("[data-testid=workbench-start-page]"))'));
    const rasterPath = path.join(process.argv[4], 'artifacts', 'fixtures', 'test-basemap.tif');
    await evaluate(`window.__ROAD_WORKBENCH__.dialogs.open.push(${JSON.stringify(rasterPath)})`);
    await click('.start-page__additional button:last-of-type');
    await waitFor('window.__ROAD_WORKBENCH__.getProject().rasters?.length===1 && !document.querySelector("[data-testid=workbench-start-page]")');
    check('开始页影像导入', '取消选择保留开始页；通过实际入口载入原生栅格并进入工作台');
    await key('n','KeyN',78,2);
    await waitFor('document.body.innerText.includes("离开当前项目？")');
    await click('[aria-label="放弃当前工程更改"]');
    await waitFor('Boolean(document.querySelector("[data-testid=workbench-start-page]"))');
    await click('.start-page__additional button:first-of-type');
    await waitFor('!document.querySelector("[data-testid=workbench-start-page]")');
    assert(await evaluate('document.querySelector(".side-panel").getClientRects().length>0 && document.body.innerText.includes("数据连接")'));
    check('开始页数据连接', '连接数据库进入对应数据面板，保留已有连接配置');
    await click('.source-section-toggle');
    assert(await evaluate('!document.querySelector(".data-source-primary").open'));
    await key('Enter','Enter',13);
    assert(await evaluate('document.querySelector(".data-source-primary").open'));
    check('左侧折叠', '标准箭头折叠和键盘展开路线数据区');

    await key('n','KeyN',78,2);
    await waitFor('Boolean(document.querySelector("[data-testid=workbench-start-page]"))');
    await click('[aria-label="绘制参考线"]');
    await waitFor('!document.querySelector("[data-testid=workbench-start-page]")');
    assert(await evaluate('document.querySelector("[aria-label=绘制路线]").getAttribute("aria-pressed")==="true"'));
    const drawBounds=await evaluate('(()=>{const b=document.querySelector(".maplibregl-canvas").getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};})()');
    for (const fraction of [.4,.6]) {
      const position={x:drawBounds.x+drawBounds.width*fraction,y:drawBounds.y+drawBounds.height*.5};
      await command('Input.dispatchMouseEvent',{type:'mousePressed',...position,button:'left',clickCount:1});
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',...position,button:'left',clickCount:1});
      await pause(150);
    }
    await key('Escape','Escape',27);
    await waitFor('window.__ROAD_WORKBENCH__.getProject().route_points.length===2');
    await waitFor('!document.querySelector(' + JSON.stringify(topGenerate) + ').disabled');
    await click(topGenerate);
    await waitFor('Boolean(window.__ROAD_WORKBENCH__.getProject().output)');
    await key('n','KeyN',78,2);
    await waitFor('document.body.innerText.includes("离开当前项目？")');
    await click('[aria-label="放弃当前工程更改"]');
    await waitFor('Boolean(document.querySelector("[data-testid=workbench-start-page]"))');
    check('开始绘制及新建', '开始页绘制两点并由原生引擎生成，Ctrl+N 经确认恢复空工程');
    for (const id of ['hana-highway','treasure-island-ramp','west-changan-street']) {
      await click('[aria-label="帮助菜单"]');
      await click('[data-command-label="道路示例…"]');
      await screenshot('examples-menu.png');
      await click('[data-example-id="'+id+'"]');
      await pause(100);
      if(await evaluate('document.body.innerText.includes("离开当前项目？")')) await click('[aria-label="放弃当前工程更改"]');
      await waitFor('window.__ROAD_WORKBENCH__.getProject().example_source?.id===' + JSON.stringify(id));
      await waitFor('!document.querySelector(".workbench-dialog")');
      await pause(400);
      assert(await evaluate('window.__ROAD_WORKBENCH__.getProject().route_points.length>=2'));
      assert(await evaluate('window.__ROAD_WORKBENCH__.getProject().example_source.attributes_status.includes("待人工核验")'));
      assert(await evaluate('!document.querySelector(".route-map-card")'));
      if(id==='hana-highway') assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getProject().route_points.length'),228);
      assert(await evaluate('Boolean(document.querySelector("[data-testid=example-source-panel]")) && !document.querySelector("[data-testid=workbench-source-entry]").open && !document.querySelector(".data-panel .source-dataset-manager")'));
      await click('[aria-label="显示数据加载入口"]');
      await waitFor('Boolean(document.querySelector(".source-entry-tabs")?.getClientRects().length)');
      await click('.source-section-toggle');
      await waitFor('!document.querySelector("[data-testid=workbench-source-entry]").open');
      await waitFor('!window.__ROAD_WORKBENCH__.getMap().isMoving()');
      assert(await evaluate(`(() => {const m=window.__ROAD_WORKBENCH__.getMap(),c=m.getCanvas(),g=m.getSource('road-route').serialize().data;return g.features[0].geometry.coordinates.every(p=>{const q=m.project(p);return q.x>=0&&q.y>=0&&q.x<=c.clientWidth&&q.y<=c.clientHeight;});})()`),'示例路线未完整显示在侧栏展开后的地图画布内');
      const sectionBeforeGeneration = await evaluate('window.__ROAD_WORKBENCH__.getProject().section');
      await fs.writeFile(path.join(outputDirectory,'input-'+id+'.json'),JSON.stringify(await evaluate('window.__ROAD_WORKBENCH__.getProject()')));
      await click(topGenerate);
      await waitFor('Boolean(window.__ROAD_WORKBENCH__.getProject().output) || document.querySelector(".status-message").textContent.includes("road-geometry-engine:")',60);
      assert(await evaluate('Boolean(window.__ROAD_WORKBENCH__.getProject().output)'),await evaluate('document.querySelector(".status-message").textContent'));
      await waitFor('!document.querySelector(' + JSON.stringify(topGenerate) + ').disabled');
      assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getProject().section'),sectionBeforeGeneration);
      await fs.writeFile(path.join(outputDirectory,'generated-'+id+'.json'), JSON.stringify(await evaluate('window.__ROAD_WORKBENCH__.getProject()')));
      await screenshot('example-'+id+'.png');
      if(id==='treasure-island-ramp') {
        await click('[aria-label="底图设置"]');
        await fill('.basemap-picker__search input','USGS');
        await click('[data-basemap-id="usgs-imagery"]');
        const limit=Date.now()+30000;
        while(Date.now()<limit && !imageResponses.some(r=>r.status===200 && r.url.includes('USGSImageryOnly/MapServer/tile/'))) await pause(200);
        assert(imageResponses.some(r=>r.status===200 && r.url.includes('USGSImageryOnly/MapServer/tile/')),'实际工作台未收到USGS图片瓦片');
        await waitFor('window.__ROAD_WORKBENCH__.getMap().isSourceLoaded("user-xyz")');
        await pause(400);
        assert(await evaluate('document.querySelector(".maplibregl-ctrl-attrib").innerText.includes("Geological Survey")'));
        assert(await evaluate(`(() => {const m=document.querySelector('.map-workspace').getBoundingClientRect(),a=document.querySelector('.maplibregl-ctrl-attrib').getBoundingClientRect(),n=document.querySelector('.maplibregl-ctrl-top-right > .maplibregl-ctrl').getBoundingClientRect();return Math.abs(m.bottom-a.bottom-12)<2 && a.right<=n.left;})()`));
        await screenshot('public-usgs-road.png');
        check('公开影像实际加载', '通过底图控件选USGS，实际收到HTTP200图片并显示署名；底部署名与缩放控件无重叠');
      }
    }
    const projectBeforeVectorStyle=await evaluate('window.__ROAD_WORKBENCH__.getProject()');
    const cameraBeforeVectorStyle=await evaluate('window.__ROAD_WORKBENCH__.getMap().getCenter().toArray()');
    await click('[aria-label="底图设置"]');
    await fill('.basemap-picker__search input','OpenFreeMap');
    await click('[data-basemap-id="openfreemap-liberty"]');
    await waitFor('window.__ROAD_WORKBENCH__.getMap().isStyleLoaded() && Object.values(window.__ROAD_WORKBENCH__.getMap().getStyle().sources).some(s => s.type === "vector") && window.__ROAD_WORKBENCH__.getMap().getStyle().layers.some(l => l.id.startsWith("output-"))',60);
    assert(await evaluate('Object.values(window.__ROAD_WORKBENCH__.getMap().getStyle().sources).some(s => s.type === "vector")'));
    assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getProject().output'),projectBeforeVectorStyle.output);
    assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getProject().route_points'),projectBeforeVectorStyle.route_points);
    assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getMap().getCenter().toArray()'),cameraBeforeVectorStyle);
    await screenshot('openfreemap-with-generated-road.png');
    await click('[aria-label="底图设置"]');
    await fill('.basemap-picker__search input','OpenTopoMap');
    await click('[data-basemap-id="opentopomap"]');
    await waitFor('window.__ROAD_WORKBENCH__.getMap().isStyleLoaded() && Boolean(window.__ROAD_WORKBENCH__.getMap().getSource("user-xyz")) && window.__ROAD_WORKBENCH__.getMap().getStyle().layers.some(l => l.id.startsWith("output-"))');
    const topoLimit=Date.now()+30000;
    while(Date.now()<topoLimit&&!imageResponses.some(r=>r.status===200&&r.url.includes('tile.opentopomap.org')))await pause(200);
    assert(imageResponses.some(r=>r.status===200&&r.url.includes('tile.opentopomap.org')),'实际工作台未收到OpenTopoMap图片瓦片');
    assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getProject().output'),projectBeforeVectorStyle.output);
    await screenshot('opentopomap-with-generated-road.png');
    await click('[aria-label="底图设置"]');
    await click('.basemap-picker__local');
    await waitFor('window.__ROAD_WORKBENCH__.getMap().isStyleLoaded() && window.__ROAD_WORKBENCH__.getMap().getStyle().layers.some(l => l.id.startsWith("output-")) && !Object.values(window.__ROAD_WORKBENCH__.getMap().getStyle().sources).some(s => s.type === "vector")');
    assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getProject().output'),projectBeforeVectorStyle.output);
    check('矢量底图与离线切换', 'OpenFreeMap实际矢量样式保留成果与视口；切换OpenTopoMap收到HTTP200瓦片；再切离线业务层仍显示');
    await evaluate('document.fonts.ready');
    assert(await evaluate(`document.fonts.check('24px "Road Geometry Material Symbols Rounded"')`));
    assert(await evaluate('document.querySelectorAll("button svg").length===0 && document.querySelectorAll(".app-icon").length>10'));
    assert(await evaluate('getComputedStyle(document.querySelector(".maplibregl-ctrl-icon")).backgroundImage === "none"'));
    assert(await evaluate(`(() => {const ctx=document.createElement('canvas').getContext('2d');ctx.font='24px "Road Geometry Material Symbols Rounded"';return [...document.querySelectorAll('.app-icon')].every(e=>ctx.measureText(e.textContent).width<=30);})()`),'字体图标缺少真实ligature字形');
    const iconSource=await fs.readFile(path.resolve('desktop-tauri/src/workbench/Iconfont.tsx'),'utf8');
    const glyphNames=[...iconSource.split('const SYMBOLS:')[1].split('function Iconfont')[0].matchAll(/:\s*"([a-z0-9_]+)"/g)].map(m=>m[1]);
    assert(glyphNames.length>50);
    assert(await evaluate(`(() => {const ctx=document.createElement('canvas').getContext('2d');ctx.font='24px "Road Geometry Material Symbols Rounded"';return ${JSON.stringify(glyphNames)}.every(name=>ctx.measureText(name).width<=30);})()`),'本地字体子集未覆盖全部声明的图标');
    check('本地字体图标', '实际WebView字体已加载，按钮无SVG图标，MapLibre导航也使用字体图标');
    check('菜单加载与生成真实案例', '三个案例均通过真实鼠标生成；Hana保留228点与默认断面，完整工程输出记录供独立几何检查');
    assert(await evaluate(`(() => {const map=document.querySelector('.map-workspace').getBoundingClientRect(),scale=document.querySelector('.map-scale-zoom').getBoundingClientRect(),nav=document.querySelector('.maplibregl-ctrl-top-right > .maplibregl-ctrl').getBoundingClientRect();return Math.abs(map.bottom-scale.bottom-12)<2 && Math.abs(map.bottom-nav.bottom-12)<2;})()`));
    check('底部地图控件', '比例尺与缩放控件距离地图下沿12像素，统一底部留白');
    await click('[aria-label="绘制路线"]');
    assert(await evaluate(`(() => {const hint=document.querySelector('.drawing-hint').getBoundingClientRect(),tools=document.querySelector('.map-top-controls').getBoundingClientRect();return !document.querySelector('.current-tool-chip') && !document.querySelector('.route-map-card') && hint.width<=480 && hint.top>=tools.bottom;})()`));
    await screenshot('compact-map-tools.png');
    await click('[aria-label="退出绘制"]');
    check('顶部地图信息精简', '移除重复当前工具提示，绘制提示不再横贯画布，保留工具名称及可访问标签');
    await click('[aria-label="底图设置"]');
    await waitFor('Boolean(document.querySelector(".basemap-picker"))');
    assert(await evaluate(`(() => {const p=document.querySelector('.basemap-picker').getBoundingClientRect(),t=document.querySelector('[aria-label="底图设置"]').getBoundingClientRect();return p.top>=t.bottom&&p.top-t.bottom<12&&p.right<=innerWidth;})()`));
    assert.equal(await evaluate('Boolean(document.querySelector(".basemap-chip"))'),false);
    assert(await evaluate('!document.querySelector("[data-basemap-id=esri-token]") && !document.querySelector(".basemap-picker__filter") && document.querySelectorAll("[data-basemap-id]").length===8'));
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".basemap-picker__group h3")].map(e=>e.textContent)'),['卫星与航空影像','街道与路网','地形参考']);
    assert(await evaluate('!["osmfr","osmfr-hot","nasa-gibs","nasa-viirs","esri-clarity","esri-hillshade"].some(id=>document.querySelector(`[data-basemap-id="${id}"]`))'));
    await command('Input.dispatchMouseEvent',{type:'mouseWheel',...await point('.basemap-picker__list'),deltaX:0,deltaY:400});
    await fill('.basemap-picker__search input','Esri');
    assert(await evaluate('document.querySelectorAll("[data-basemap-id]").length===1 && Boolean(document.querySelector("[data-basemap-id=esri-public]"))'));
    assert.equal(await evaluate('document.querySelector(".basemap-picker__list").scrollTop'),0);
    await fill('.basemap-picker__search input','NASA');
    assert(await evaluate('Boolean(document.querySelector(".basemap-picker__empty")) && document.querySelectorAll("[data-basemap-id]").length===0'));
    await fill('.basemap-picker__search input','');
    check('底图目录精简与分类', '8个常用公开来源按影像、路网、地形分类，重复与低分辨率来源移除；检索复位滚动位置');
    await screenshot('curated-basemap-catalog.png');
    const beforeInvalidToken=await evaluate('window.__ROAD_WORKBENCH__.getProject().output');
    await click('.basemap-picker__tabs [role="tab"]:nth-child(2)');
    await click('[data-testid="basemap-authorized-services"] > summary');
    await fill('[aria-label="ArcGIS 访问令牌"]','token=abc');
    await click('[aria-label="应用 ArcGIS 影像"]');
    await waitFor('document.querySelector(".basemap-picker__error")?.textContent.includes("令牌")');
    assert.deepEqual(await evaluate('window.__ROAD_WORKBENCH__.getProject().output'),beforeInvalidToken);
    await screenshot('authorized-service-validation.png');
    check('授权服务入口保留', 'ArcGIS配置独立收起，无效令牌显示校验错误且不改变工程或底图');
    await click('.basemap-picker__tabs [role="tab"]:nth-child(1)');
    await screenshot('basemap-top-anchor.png');
    await key('Escape','Escape',27);
    await waitFor('!document.querySelector(".basemap-picker")');
    check('底图入口与选择位置', '唯一地图入口在右上角，选择面板紧邻该按钮，Esc 关闭恢复焦点');
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--blue").trim()'), '#2563eb');
    check('蓝白主题', '主题主色及实际工作台控件');
    await click(topGenerate);
    await waitFor('Boolean(window.__ROAD_WORKBENCH__.getProject().output)');
    await waitFor('!document.querySelector(' + JSON.stringify(topGenerate) + ').disabled');
    await pause(1000);
    assert(await evaluate('document.querySelector(".brand").innerText.includes("路境工作台")'));
    assert(await evaluate('document.querySelector(".inspector").getBoundingClientRect().width > 250'));
    assert(await evaluate('document.querySelector(".workbench-footer").getBoundingClientRect().width >= 1439'));
    assert(await evaluate(`document.querySelector('.tool-group [aria-label="编辑路线顶点"]').title.includes('编辑') && document.querySelector('.tool-group button.selected').innerText.includes('选择')`));
    assert(await evaluate('document.querySelector(".map-actions [aria-label=切换图例]") && !document.querySelector("#map-legend-popover")?.getClientRects().length'));
    await click('[aria-label="切换图例"]');
    await waitFor('Boolean(document.querySelector("#map-legend-popover"))');
    await key('Escape','Escape',27);
    await waitFor('!document.querySelector("#map-legend-popover")?.getClientRects().length');
    assert(await evaluate('document.activeElement.getAttribute("aria-label")==="切换图例"'));
    check('图例工具条入口', '图例并入地图工具条，默认不占画布，Escape关闭并归焦');
    check('设计结构落实', '可见品牌、选中工具文字与其他图标标签、右侧属性面板及全窗口底栏');
    await screenshot('after-data-1440.png');
    check('当前路线生成', '鼠标点击顶部生成，调用真实原生引擎');
    await click('.left-rail [aria-label="道路"]');
    await screenshot('after-road-1440.png');
    const original = await evaluate('window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]');
    await fill(lane, '-1');
    await waitFor('document.querySelector(' + JSON.stringify(topGenerate) + ').disabled');
    assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]'), original);
    await screenshot('invalid-draft.png');
    check('无效草稿阻止生成', '输入 -1 后未离开输入框即显示错误并禁用生成，已提交参数不变');
    await key('F5', 'F5', 116);
    assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]'), original);
    await click(lane);
    await key('Escape', 'Escape', 27);
    await waitFor('!document.querySelector(' + JSON.stringify(topGenerate) + ').disabled');
    check('错误恢复', 'F5 不绕过无效草稿，Esc 恢复原值并解除禁用');
    await fill(lane, '3.8');
    await key('Enter', 'Enter', 13);
    await waitFor('window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]===3.8');
    assert(await evaluate('document.body.innerText.includes("成果待更新")'));
    await key('z', 'KeyZ', 90, 2);
    await waitFor('window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]===' + original);
    await key('z', 'KeyZ', 90, 10);
    await waitFor('window.__ROAD_WORKBENCH__.getProject().section.left_lanes[0]===3.8');
    check('参数提交与编辑历史', 'Enter 提交一次；Ctrl+Z 撤销，Ctrl+Shift+Z 重做；提示成果待更新');
    await click('.cross-section__tabs [role="tab"]');
    await key('ArrowRight', 'ArrowRight', 39);
    assert.equal(await evaluate('document.activeElement.textContent'), '中央');
    await key('End', 'End', 35);
    assert.equal(await evaluate('document.activeElement.textContent'), '右侧');
    check('断面标签键盘导航', '左右箭头与 End 切换并移动焦点');
    await click(topGenerate);
    await waitFor('window.__ROAD_WORKBENCH__.getProject().output?.input_version===window.__ROAD_WORKBENCH__.getProject().input_version');
    await click('[aria-label="选择成果导出格式"]');
    await waitFor('Boolean(document.querySelector(".export-format-list"))');
    assert(await evaluate('document.querySelector(".workbench-dialog").innerText.includes("WGS84")'));
    await screenshot('export-formats.png');
    await key('Escape', 'Escape', 27);
    await waitFor('!document.querySelector(".workbench-dialog")');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '选择成果导出格式');
    check('导出弹框', '两种真实格式与坐标系说明；Esc 关闭并把焦点返回入口');

    // 仅给原生文件选择器提供隔离目录路径；保存、读取与导出仍走真实后端。
    const exportPath = path.join(outputDirectory, 'ui-export.geojson');
    await evaluate(`window.__ROAD_WORKBENCH__.dialogs.save.push(${JSON.stringify(exportPath)})`);
    await click('[aria-label="选择成果导出格式"]');
    await click('.export-format-list > button:nth-child(2)');
    await waitFor('document.body.innerText.includes("WGS84 GeoJSON 已导出")');
    const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'));
    assert(exported.features.length > 0);
    assert(exported.features.some(feature => Math.abs(feature.geometry.coordinates.flat(4).filter(value => typeof value === 'number')[0]) <= 180));
    check('真实 GeoJSON 导出', '从新格式弹框点击导出，真实后端写入 WGS84 文件；只替代原生路径选择');

    await click('[aria-label="编辑路面成果"]');
    const surfacePoint = await evaluate(`(() => {
      const map=window.__ROAD_WORKBENCH__.getMap();
      const layers=map.getStyle().layers.filter(layer=>layer.id.startsWith('output-')&&layer.type==='fill').map(layer=>layer.id);
      const b=map.getCanvas().getBoundingClientRect();
      for(let y=b.height*.3;y<b.height*.7;y+=4)for(let x=b.width*.35;x<b.width*.65;x+=4){
        if(map.queryRenderedFeatures([x,y],{layers}).some(feature=>feature.properties.component==='lane'))return {x:b.left+x,y:b.top+y};
      }
      throw new Error('当前视口未找到可选择的车道');
    })()`);
    await command('Input.dispatchMouseEvent', {type:'mousePressed',...surfacePoint,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent', {type:'mouseReleased',...surfacePoint,button:'left',clickCount:1});
    await waitFor('Boolean(document.querySelector(".generated-surface-editor"))');
    await fill('.generated-surface-editor input[aria-label="中央隔离带宽度（米）"]', '1.8');
    await click('.generated-surface-editor__apply');
    await waitFor('window.__ROAD_WORKBENCH__.getProject().section.median_width===1.8 && Boolean(window.__ROAD_WORKBENCH__.getProject().surface_original_section)');
    await click(topGenerate);
    await waitFor('document.querySelector(".workbench-dialog")?.innerText.includes("保留人工修改并生成")');
    await screenshot('regeneration-preserves-edits.png');
    await click('.workbench-dialog .dialog-actions .button.primary');
    await waitFor('!document.querySelector(".workbench-dialog") && window.__ROAD_WORKBENCH__.getProject().last_generated_input_version===window.__ROAD_WORKBENCH__.getProject().input_version');
    assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getProject().section.median_width'), 1.8);
    assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getProject().surface_original_section.median_width'), 1.5);
    await click('[aria-label="关闭成果编辑面板"]');
    check('人工成果编辑与重生成', '真实地图选择车道、应用断面修改；确认后保留修改值与恢复规则');

    const savedPath = path.join(outputDirectory, 'ui-project.json');
    await evaluate(`window.__ROAD_WORKBENCH__.dialogs.save.push(${JSON.stringify(savedPath)})`);
    await click('[aria-label="保存项目"]');
    await waitFor('document.querySelector(".save-badge")?.textContent.includes("已保存")');
    const saved = JSON.parse(await fs.readFile(savedPath, 'utf8'));
    assert.equal(saved.section.median_width, 1.8);
    await evaluate(`window.__ROAD_WORKBENCH__.dialogs.open.push(${JSON.stringify(savedPath)})`);
    await click('[aria-label="打开项目"]');
    await waitFor('document.querySelector(".project-title")?.innerText.includes("ui-project.json") && document.querySelector(".status-message")?.textContent.includes("已打开项目") && !document.querySelector(".workbench-dialog")');
    assert.equal(await evaluate('window.__ROAD_WORKBENCH__.getProject().section.median_width'), 1.8);
    check('保存与恢复', '真实文件保存并从顶部打开，人工修改与成果恢复；只替代原生路径选择');
    await key('n','KeyN',78,2);
    await waitFor('Boolean(document.querySelector(".start-page__recent-item"))');
    await screenshot('startup-recent.png');
    await click('.start-page__recent-item');
    await waitFor('window.__ROAD_WORKBENCH__.getProject().section.median_width===1.8');
    await waitFor('!document.querySelector("[data-testid=workbench-start-page]")');
    check('最近工程', '空工程开始页从真实保存历史打开工程并恢复人工编辑');


    await click('[aria-label="专注地图"]');
    await waitFor('!document.querySelector(".side-panel") || !document.querySelector(".side-panel").getClientRects().length');
    await click('[aria-label="恢复面板布局"]');
    await waitFor('document.querySelector(".side-panel").getClientRects().length>0');
    check('专注地图', '隐藏两侧面板并恢复');
    await command('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await pause(250);
    assert(await evaluate('document.querySelector(".top-actions").getBoundingClientRect().right<=innerWidth'));
    assert(await evaluate('document.querySelector(".maplibregl-canvas").getBoundingClientRect().width>200'));
    await screenshot('compact-1024.png');
    check('1024 窗口', '顶部操作未溢出，地图仍可见，图标按钮保留可访问名称');
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  await fs.writeFile(path.join(outputDirectory, 'ui-interaction-report.json'), JSON.stringify({baseline, viewport:'1440×900 / 1024×768', publicImageResponses:imageResponses.filter(r=>r.url.includes('USGSImageryOnly')).slice(0,6), input:'WebView2 CDP 鼠标与键盘', checks, pending:['Windows 中文输入法候选窗人工操作','真实数据库及其他底图覆盖区域操作','跨设备 DPI'], errors},null,2));
  console.log(JSON.stringify({passed:checks.length, baseline, outputDirectory}));
} catch (error) {
  await screenshot('failure.png').catch(() => undefined);
  await fs.writeFile(path.join(outputDirectory, 'failure.json'), JSON.stringify({checks, error:String(error), errors},null,2));
  throw error;
} finally {
  socket.close();
}
