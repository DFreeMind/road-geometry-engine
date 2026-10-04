import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';

// 只读取已有本地副本；请求使用明确的固定模板，不能冒充数据库真实车道属性。
const [inputPath, oldEngine, newEngine, reportPath] = process.argv.slice(2);
if (!reportPath) throw new Error('用法：node compare-road-engines.mjs <WGS84 GeoJSON> <旧引擎> <新引擎> <报告路径>');
const require = createRequire(path.resolve('desktop-tauri/package.json'));
const proj4 = require('proj4');
const collection = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const cases = [];
let unsupported = 0;
for (const [index, feature] of collection.features.entries()) {
  const parts = feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
  if (!parts.length) unsupported++;
  for (const [part, coordinates] of parts.entries()) {
    if (!coordinates.length) continue;
    const middle = coordinates[Math.floor(coordinates.length / 2)];
    const zone = Math.min(60, Math.max(1, Math.floor((middle[0] + 180) / 6) + 1));
    const crs = `EPSG:${middle[1] >= 0 ? 32600 + zone : 32700 + zone}`;
    proj4.defs(crs, `+proj=utm +zone=${zone} ${middle[1] < 0 ? '+south' : ''} +datum=WGS84 +units=m +no_defs`);
    cases.push({index, part, fid:feature.id, request:{
      route_id:`validation-${index}-${part}`, source:'local-offline-validation', crs,
      points:coordinates.map(point => proj4('EPSG:4326', crs, point.slice(0, 2))),
      section:{left_lanes:[3.5,3.5,3.5],right_lanes:[3.5,3.5,3.5],median_width:0.5,left_emergency_width:0,right_emergency_width:0,left_shoulder_width:0,right_shoulder_width:0,left_slope_width:0,right_slope_width:0},
      scene_options:{enabled:[],spacing_m:50,offset_m:1,side:'both'},
    }});
  }
}

async function run(engine) {
  const started = performance.now();
  const process = spawn(engine, ['--stream'], {windowsHide:true, stdio:['pipe','pipe','pipe']});
  let stderr = '';
  process.stderr.on('data', buffer => {stderr += buffer.toString();});
  const completion = new Promise((resolve,reject) => {
    process.on('error', reject);
    process.on('exit', code => code === 0 ? resolve() : reject(new Error(`引擎退出 ${code}：${stderr}`)));
  });
  const results = [];
  const reading = (async () => {
    for await (const line of createInterface({input:process.stdout, crlfDelay:Infinity})) {
      const value = JSON.parse(line);
      results.push({error:value.error ?? null, warnings:value.response?.geometry_warnings ?? [],feature_count:value.response?.feature_count ?? 0});
    }
  })();
  for (const item of cases) if (!process.stdin.write(JSON.stringify(item.request) + '\n')) await once(process.stdin,'drain');
  process.stdin.end();
  await Promise.all([completion,reading]);
  if (results.length !== cases.length) throw new Error(`响应数 ${results.length} 不等于请求数 ${cases.length}`);
  return {results, elapsed_ms:performance.now()-started};
}
const before = await run(oldEngine);
const after = await run(newEngine);
const changes = cases.flatMap((item,index) => {
  const old = before.results[index];
  const current = after.results[index];
  if (Boolean(old.error) === Boolean(current.error) && !current.warnings.length) return [];
  return [{record_index:item.index,part_index:item.part,fid:item.fid,before_error:old.error,after_error:current.error,warnings:current.warnings}];
});
const report = {
  input_features:collection.features.length, unsupported_features:unsupported,line_parts:cases.length,
  template:{lanes_per_side:3,lane_width_m:3.5,median_width_m:0.5,outer_offset_m:10.75,scene_enabled:[]},
  before:{success:before.results.filter(result=>!result.error).length,failed:before.results.filter(result=>result.error).length,elapsed_ms:before.elapsed_ms},
  after:{success:after.results.filter(result=>!result.error).length,failed:after.results.filter(result=>result.error).length,review_parts:after.results.filter(result=>result.warnings.length).length,elapsed_ms:after.elapsed_ms},
  recovered:changes.filter(change=>change.before_error&&!change.after_error).length,
  regressed:changes.filter(change=>!change.before_error&&change.after_error).length,changes,
};
await fs.writeFile(reportPath, JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,changes:undefined}));
if (report.regressed) process.exitCode = 1;
