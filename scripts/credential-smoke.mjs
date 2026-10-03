import fs from 'node:fs/promises';
import path from 'node:path';

const [endpoint, outputDirectory, statePath, phase] = process.argv.slice(2);
const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
if (state.version !== 1 || !state.runId || !state.connectionId || !state.identity) {
  throw new Error('QA 凭据状态文件格式无效。');
}

const password = `qa-credential-${state.runId}`;
const mismatchPassword = `qa-mismatch-${state.runId}`;
const checks = [];
const must = (condition, message) => {
  if (!condition) throw new Error(message);
};
const check = name => checks.push({ name, passed: true });

let target;
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const targets = await (await fetch(`${endpoint}/json`)).json();
    target = targets.find(item => item.type === 'page' && item.url.includes('tauri'));
    if (target?.webSocketDebuggerUrl) break;
  } catch {
    // WebView2 刚启动时调试端口可能尚未就绪。
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}
must(target?.webSocketDebuggerUrl, '未找到桌面 WebView2 页面。');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error('无法连接 WebView2 调试端口。'));
});
let sequence = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const handler = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) handler.reject(new Error('CDP 命令失败。'));
  else handler.resolve(message.result);
};
socket.onclose = () => {
  for (const handler of pending.values()) handler.reject(new Error('WebView2 调试连接已关闭。'));
  pending.clear();
};

const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`CDP 命令超时：${method}`));
  }, 30000);
  pending.set(id, {
    resolve: value => { clearTimeout(timer); resolve(value); },
    reject: error => { clearTimeout(timer); reject(error); },
  });
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async expression => {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error('页面验证表达式执行失败。');
  return result.result.value;
};

const waitFor = async (expression, seconds = 30) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('等待工作台界面就绪超时。');
};

const invoke = async (name, args = {}) => {
  try {
    return await evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
  } catch {
    throw new Error(`Tauri 凭据命令失败：${name}`);
  }
};

const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing');e.click();})()`);
const clickText = text => evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)});if(!e)throw new Error('missing');e.click();})()`);
const fillConnection = (label, value) => evaluate(`(()=>{const l=[...document.querySelectorAll('.connection-manager label')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(label)})&&x.querySelector('input'));if(!l)throw new Error('missing');const e=l.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);

const readNative = (connectionId, identity) => invoke('read_connection_password', {
  connectionId,
  identity,
});

async function cleanup() {
  const ids = new Set([
    state.connectionId,
    state.otherId,
    state.mismatchId,
    state.emptyId,
  ].filter(Boolean));
  try {
    const discovered = await evaluate(`(()=>{const raw=localStorage.getItem('road-data-connections-v1');if(!raw)return [];try{return JSON.parse(raw).connections.filter(c=>c.name===${JSON.stringify(state.connectionName)}).map(c=>c.id)}catch{return []}})()`);
    for (const id of discovered ?? []) ids.add(id);
  } catch {
    // localStorage 可不可用不阻止对状态文件中 UUID 的清理。
  }

  let failed = false;
  for (const connectionId of ids) {
    try {
      await invoke('delete_connection_password', { connectionId });
    } catch {
      failed = true;
    }
  }
  try {
    await evaluate(`(()=>{const key='road-data-connections-v1',raw=localStorage.getItem(key);if(!raw)return;try{const data=JSON.parse(raw);data.connections=data.connections.filter(c=>c.name!==${JSON.stringify(state.connectionName)}&&c.id!==${JSON.stringify(state.connectionId)});localStorage.setItem(key,JSON.stringify(data))}catch{localStorage.removeItem(key)}})()`);
  } catch {
    failed = true;
  }
  if (failed) throw new Error('至少一个合成凭据或连接未能清理。');
}

let phaseSucceeded = false;
let phaseError;
let cleanupError;
try {
  await command('Runtime.enable');
  await command('Page.enable');
  await waitFor('Boolean(window.__TAURI_INTERNALS__ && window.__ROAD_WORKBENCH__ && document.querySelector(".source-tools"))');

  if (phase === 'phase1') {
    await clickText('新建连接');
    await waitFor('Boolean(document.querySelector(".connection-manager[open]"))');
    await fillConnection('连接名称', state.connectionName);
    await fillConnection('主机', '127.0.0.1');
    await fillConnection('数据库', 'credential_smoke');
    await fillConnection('用户', 'qa_smoke');
    await fillConnection('密码', password);
    const rememberChecked = await evaluate('Boolean(document.querySelector(".connection-manager input[type=checkbox]")?.checked)');
    must(rememberChecked, '新连接默认未选中保存密码。');

    const forcedId = await evaluate(`(()=>{const id=${JSON.stringify(state.connectionId)};const descriptor=Object.getOwnPropertyDescriptor(Crypto.prototype,'randomUUID');if(!descriptor||!descriptor.configurable)throw new Error('crypto hook unavailable');const original=descriptor.value;let used=false;Object.defineProperty(Crypto.prototype,'randomUUID',{...descriptor,value:function(){if(!used){used=true;return id}return original.call(this)}});try{const button=[...document.querySelectorAll('.connection-manager button')].find(b=>b.innerText.trim()==='保存连接');if(!button)throw new Error('save button missing');button.click()}finally{Object.defineProperty(Crypto.prototype,'randomUUID',descriptor)}return used})()`);
    must(forcedId, '无法为本次连接指定可清理的合成 UUID。');
    await waitFor('!document.querySelector(".connection-manager")');

    const connection = await evaluate(`(()=>{const data=JSON.parse(localStorage.getItem('road-data-connections-v1'));return data.connections.find(c=>c.id===${JSON.stringify(state.connectionId)})})()`);
    must(Boolean(connection), 'UI 保存后找不到合成连接。');
    must(connection.rememberPassword === true, '连接未保存记住密码偏好。');
    must(!Object.hasOwn(connection.config, 'password'), '密码字段进入了连接配置。');
    const serializedConnection = JSON.stringify(connection);
    must(!serializedConnection.includes(password) && !serializedConnection.includes('"password"'), '密码进入了 localStorage 连接记录。');
    const identity = JSON.stringify([connection.kind, connection.config]);
    must(identity === state.identity, '合成连接身份与 QA 预期不一致。');
    const stored = await readNative(state.connectionId, identity);
    must(stored === password, 'UI 保存后原生凭据未能读回。');
    check('UI 保存连接后系统凭据读回且 localStorage 不含密码');
    state.identity = identity;
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } else if (phase === 'phase2') {
    const restored = await readNative(state.connectionId, state.identity);
    must(restored === password, '进程重启后系统凭据未正确恢复。');
    check('第二个桌面进程读回相同系统凭据');

    await waitFor('document.querySelector(".source-browser__authentication")?.innerText.includes("已使用保存的密码")');
    check('主界面显示已使用保存的密码');
    await click('[aria-label="管理数据连接"]');
    await waitFor('Boolean(document.querySelector(".connection-manager[open]"))');
    await waitFor('document.querySelector(".connection-manager input[type=password]")?.value.length > 0');
    const editorPasswordMatches = await evaluate(`document.querySelector('.connection-manager input[type=password]').value===${JSON.stringify(password)}`);
    must(editorPasswordMatches, '连接管理器未恢复正确密码。');
    check('连接管理器编辑表单恢复同一密码');

    const otherIdValue = await readNative(state.otherId, state.identity);
    must(otherIdValue === null, '其他 UUID 错误继承了本连接凭据。');
    check('不同 UUID 不继承凭据');

    // 模拟配置库写入失败，确认原有系统凭据不会先被新密码覆盖。
    const beforeFailure = await evaluate("localStorage.getItem('road-data-connections-v1')");
    await fillConnection('密码', `${password}-replacement`);
    await evaluate(`(()=>{window.__qaOriginalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='road-data-connections-v1')throw new Error('QA配置写入失败');return window.__qaOriginalSetItem.call(this,key,value)}})()`);
    try {
      await clickText('保存连接');
      await waitFor('document.querySelector(".connection-manager [role=status]")?.innerText.includes("QA配置写入失败")');
    } finally {
      await evaluate('Storage.prototype.setItem=window.__qaOriginalSetItem;delete window.__qaOriginalSetItem');
    }
    must(await readNative(state.connectionId, state.identity) === password, '公开配置保存失败却覆盖了原有密码。');
    must(await evaluate("localStorage.getItem('road-data-connections-v1')") === beforeFailure, '公开配置保存失败后旧配置发生变化。');
    await fillConnection('密码', password);
    check('配置存储失败时保留旧连接和旧凭据');

    const rememberChecked = await evaluate('document.querySelector(".connection-manager input[type=checkbox]")?.checked === true');
    must(rememberChecked, '连接管理器记住密码选项未恢复。');
    await click('.connection-manager input[type=checkbox]');
    await waitFor('document.querySelector(".connection-manager input[type=checkbox]")?.checked === false');
    await clickText('保存连接');
    await waitFor('!document.querySelector(".connection-manager")');
    const preferenceDisabled = await evaluate(`JSON.parse(localStorage.getItem('road-data-connections-v1')).connections.find(c=>c.id===${JSON.stringify(state.connectionId)}).rememberPassword===false`);
    must(preferenceDisabled, '关闭记住密码后偏好未保存。');
    const cleared = await readNative(state.connectionId, state.identity);
    must(cleared === null, '关闭记住密码后原生凭据仍存在。');
    check('关闭记住密码并保存后清除原生凭据');

    await command('Page.reload');
    await waitFor('Boolean(window.__TAURI_INTERNALS__ && document.querySelector(".source-tools"))');
    await waitFor('document.querySelector(".source-browser__authentication")?.innerText.includes("连接认证")');
    const authenticationRequired = await evaluate(`Boolean(document.querySelector('.source-browser__authentication input[type=password]'))&&document.querySelector('.source-browser__authentication input[type=password]').value===''`);
    must(authenticationRequired, '关闭记住密码后重载仍未要求输入密码。');
    check('重载后不从系统凭据恢复并要求重新认证');

    await invoke('store_connection_password', {
      connectionId: state.mismatchId,
      identity: state.identity,
      password: mismatchPassword,
    });
    const changedIdentityValue = await readNative(state.mismatchId, `${state.identity}:changed`);
    must(changedIdentityValue === null, '身份变化后错误恢复旧凭据。');
    const staleValue = await readNative(state.mismatchId, state.identity);
    must(staleValue === null, '身份不匹配的原生凭据未被清除。');
    check('身份变化使旧凭据失效并清除');

    await invoke('store_connection_password', {
      connectionId: state.emptyId,
      identity: 'credential-smoke-empty-password-v1',
      password: '',
    });
    const emptyValue = await readNative(state.emptyId, 'credential-smoke-empty-password-v1');
    must(emptyValue === '', '空密码未与无凭据 null 区分。');
    await invoke('delete_connection_password', { connectionId: state.emptyId });
    await invoke('delete_connection_password', { connectionId: state.emptyId });
    must(await readNative(state.emptyId, 'credential-smoke-empty-password-v1') === null, '重复删除后空密码条目仍存在。');
    check('空密码与 null 可区分且删除命令幂等');

    await invoke('delete_connection_password', { connectionId: state.connectionId });
    await invoke('delete_connection_password', { connectionId: state.connectionId });
    must(await readNative(state.connectionId, state.identity) === null, '重复删除后主凭据仍存在。');
    check('主凭据删除命令幂等');
  } else if (phase !== 'cleanup') {
    throw new Error('未知凭据验证阶段。');
  }
  phaseSucceeded = true;
} catch (error) {
  phaseError = error instanceof Error ? error : new Error('凭据验证失败。');
} finally {
  if (phase !== 'phase1' || !phaseSucceeded) {
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error('清理失败。');
    }
  }
  socket.close();
}

const report = {
  phase,
  passed: !phaseError && !cleanupError,
  checks,
  cleanup: phase === 'phase1' && phaseSucceeded ? '保留至进程重启验证' : !cleanupError,
};
await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(path.join(outputDirectory, `credential-smoke-${phase}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (phaseError) {
  console.error(`凭据 smoke 阶段失败：${phaseError.message}`);
  process.exitCode = 1;
} else if (cleanupError) {
  console.error(`凭据 smoke 清理失败：${cleanupError.message}`);
  process.exitCode = 1;
} else {
  console.log(`凭据 smoke 阶段通过：${phase}`);
}
