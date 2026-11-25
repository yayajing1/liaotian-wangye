/**
 * 交付前最终核验
 *
 * 1) 公网 wss：主口令 / 备用口令 都能进，错误口令被拒
 * 2) 真实浏览器打开分享链接：直接进房间，不弹口令框
 *
 * 口令由 SSH 从服务器按字节取回，脚本里不含任何密钥明文，
 * 取到的临时文件用完即删。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname);
const BASE = 'https://8.222.185.143';
const SERVER = process.env.CHAT_SERVER || 'root@8.222.185.143';
const APP_DIR = process.env.CHAT_APP_DIR || '/opt/chat-room/app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从服务器取口令真值（按字节，不经过任何字符转换） */
function readKey(which) {
  const cmd = which === 'main'
    ? `tr -d '\\r\\n' < ${APP_DIR}/data/room.key`
    : `pid=$(systemctl show -p MainPID --value chat-room); tr '\\0' '\\n' < /proc/$pid/environ | grep -a '^ROOM_KEY_SPARE=' | sed -e 's/^ROOM_KEY_SPARE=//' | tr -d '\\n'`;
  const out = execFileSync('ssh', ['-o', 'ConnectTimeout=25', SERVER, cmd], { encoding: 'utf8' });
  return out.trim();
}


function wsTry(label, key, expect) {
  return new Promise((resolve) => {
    const url = `${BASE.replace('https', 'wss')}/ws?cid=chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}&key=${encodeURIComponent(key)}`;
    const ws = new WebSocket(url);
    const to = setTimeout(() => { console.log(`  ❌ ${label} 超时`); ws.terminate(); resolve(false); }, 10000);
    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.t === 'init') { clearTimeout(to); console.log(`  ✅ ${label} → 进房成功（昵称 ${d.self.name}，在线 ${(d.users || []).length} 人）`); ws.close(); resolve(true); }
      if (d.t === 'error') { clearTimeout(to); console.log(`  ✅ ${label} → 被正确拒绝（${d.code}）`); ws.close(); resolve(!expect); }
    });
    ws.on('error', (e) => { clearTimeout(to); console.log(`  ❌ ${label} 连接错误：${e.message}`); resolve(false); });
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.p = new Map();
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.p.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function browserCheck(url) {
  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const PORT = 9357;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-final-'));
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const l = await r.json();
        target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* 等待浏览器起来 */ }
      await sleep(250);
    }
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url });
    let st = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      st = await cdp.evaluate(`(function(){
        if(!window.ChatApp) return {ready:false};
        var m=document.getElementById('keyModal');
        return {ready:true, connected:!!window.ChatApp.state.self,
                modal:!!(m&&!m.hidden),
                conn:((document.getElementById('connText')||{}).textContent||'').trim(),
                name:window.ChatApp.state.self?window.ChatApp.state.self.name:''};
      })()`);
      if (st.ready && (st.connected || st.modal)) break;
    }
    console.log('  页面状态:', JSON.stringify(st));
    const ok = st.connected && !st.modal;
    console.log(ok ? '  ✅ 真实浏览器直接进房间，没有弹口令框' : '  ❌ 浏览器未直接进房间');
    return ok;
  } finally {
    if (cdp) cdp.close();
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  const main = readKey('main');
  const spare = readKey('spare');
  console.log(`口令长度：主 ${main.length} 位 / 备 ${spare.length} 位\n`);

  console.log('[1] 公网 wss 鉴权');
  const a = await wsTry('主口令', main, true);
  const b = await wsTry('备用口令', spare, true);
  const c = await wsTry('错误口令', 'definitely-not-the-key', false);
  console.log('[2] 真实浏览器打开分享链接');
  const d = await browserCheck(`${BASE}/chat#key=${encodeURIComponent(main)}`);

  const pass = a && b && c && d;
  console.log(`\n最终结论：${pass ? '✅ 全部通过，可以交付' : '❌ 有项目未通过'}`);
  process.exit(pass ? 0 : 1);
})();
