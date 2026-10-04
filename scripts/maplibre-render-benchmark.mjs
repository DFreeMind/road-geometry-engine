import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// 同一组合成 300km/300 路段测量相机交互，不访问业务数据库或用户工程。
const [endpoint, outputDirectory] = process.argv.slice(2);
let target;
for(let i=0;i<100;i++) {
  const targets=await (await fetch(`${endpoint}/json`)).json();
  target=targets.find(item=>item.type==='page' && item.url.includes('tauri'));
  if(target) break;
  await new Promise(resolve=>setTimeout(resolve,200));
}
assert(target?.webSocketDebuggerUrl);
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let sequence=0;
const pending=new Map();
const errors=[];
socket.onmessage=event=>{
  const message=JSON.parse(event.data);
  if(message.id) {
    const handler=pending.get(message.id); pending.delete(message.id);
    if(message.error)handler.reject(new Error(JSON.stringify(message.error)));else handler.resolve(message.result);
  } else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
};
const command=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP超时：${method}`));},120000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  socket.send(JSON.stringify({id,method,params}));
});
const evaluate=async expression=>{
  const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const waitFor=async(expression,seconds=120)=>{
  const end=Date.now()+seconds*1000;
  while(Date.now()<end){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,200));}
  throw new Error(`等待超时：${expression}`);
};
try {
  await command('Runtime.enable');await command('Page.enable');
  await waitFor('Boolean(window.__ROAD_WORKBENCH__?.getMap()?.isStyleLoaded())');
  const started=Date.now();
  const fixture=await evaluate(`(()=>{
    const p=window.__ROAD_WORKBENCH__.getProject();
    p.route_points=[];p.manual_facilities=[];p.vector_basemaps=[];p.rasters=[];
    p.source_batch_output=null;p.active_source_ref=null;p.scene_options={...p.scene_options,enabled:[]};
    const layers=['左车道','右车道','中央隔离带'].map(name=>({name,crs:p.crs,collection:{type:'FeatureCollection',features:[]}}));
    const attributes=Object.fromEntries(Array.from({length:69},(_,i)=>['field_'+i,'业务属性-'+i+'-'.repeat(20)]));
    let vertices=0;
    for(let segment=0;segment<300;segment++){
      const points=Array.from({length:500},(_,i)=>[448000+segment*1000+i*1000/499,4420000+Math.sin((segment*1000+i*1000/499)/5000)*100]);
      for(let band=0;band<3;band++){
        const inner=[0.5,-0.5,-0.5][band],outer=[4,-4,0.5][band];
        const ring=[...points.map(([x,y])=>[x,y+inner]),...points.slice().reverse().map(([x,y])=>[x,y+outer]),[points[0][0],points[0][1]+inner]];
        vertices+=ring.length;
        layers[band].collection.features.push({type:'Feature',properties:{component:band===2?'median':'lane',route_id:'PERF-'+segment,source_attributes:attributes,...attributes},geometry:{type:'Polygon',coordinates:[ring]}});
      }
    }
    p.output={input_version:p.input_version,response:{layers}};
    window.__ROAD_WORKBENCH__.loadProject(p);
    return {length_km:300,segments:300,vertices,feature_count:900,attributes_per_feature:69};
  })()`);
  await waitFor('(()=>{const m=window.__ROAD_WORKBENCH__.getMap();return m.getStyle().layers.some(l=>l.id.startsWith("output-")) && m.isStyleLoaded() && m.areTilesLoaded();})()');
  await evaluate('(()=>{window.__ROAD_WORKBENCH__.getMap().jumpTo({center:[118,39.9],zoom:11});return true;})()');
  await waitFor('window.__ROAD_WORKBENCH__.getMap().areTilesLoaded()');
  const readyMs=Date.now()-started;
  await evaluate(`(()=>{window.__renderBench={setData:0,updates:[]};const map=window.__ROAD_WORKBENCH__.getMap();for(const id of Object.keys(map.getStyle().sources)){const source=map.getSource(id);if(source?.setData){const original=source.setData.bind(source);source.setData=(...args)=>{window.__renderBench.setData++;window.__renderBench.updates.push(id);return original(...args);};}}})()`);
  const samples=[];
  for(let i=0;i<6;i++)samples.push(await evaluate(`(async()=>{
    const m=window.__ROAD_WORKBENCH__.getMap();const intervals=[];let previous=performance.now();let running=true;
    const frame=time=>{intervals.push(time-previous);previous=time;if(running)requestAnimationFrame(frame);};requestAnimationFrame(frame);
    const started=performance.now();m.easeTo({center:[118+${i}*0.01,39.9],zoom:${i%2?11:12},duration:250});
    await new Promise(resolve=>m.once('moveend',()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    running=false;intervals.sort((a,b)=>a-b);
    return {elapsed_ms:performance.now()-started,p95_frame_ms:intervals[Math.floor(intervals.length*0.95)]??0,max_frame_ms:intervals.at(-1)??0,frames:intervals.length};
  })()`));
  const details=await evaluate(`(()=>{const map=window.__ROAD_WORKBENCH__.getMap();return {...window.__renderBench,source_count:Object.keys(map.getStyle().sources).filter(id=>id.startsWith('output-')).length,
    production_vertices:window.__ROAD_WORKBENCH__.getProject().output.response.layers.reduce((sum,l)=>sum+l.collection.features.reduce((n,f)=>n+f.geometry.coordinates[0].length,0),0),display:window.__ROAD_WORKBENCH__.getDisplayMetrics?.()??null};})()`);
  const report={fixture,ready_ms:readyMs,samples,details,errors};
  if(process.env.ROAD_REQUIRE_STABLE_RENDER==='1'){
    assert.equal(details.setData,0,'平移缩放不能重新上传GeoJSON源');
    assert.equal(details.source_count,1,'道路成果显示应合并为一个地图源');
    assert.equal(details.production_vertices,fixture.vertices,'生产几何不能被显示优化删减');
    assert.equal(errors.length,0);
  }
  const shot=await command('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(outputDirectory,'render-benchmark.png'),Buffer.from(shot.data,'base64'));
  await fs.writeFile(path.join(outputDirectory,'render-benchmark.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {socket.close();}
