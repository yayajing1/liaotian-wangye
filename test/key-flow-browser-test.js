'use strict';

/**
 * 口令流程浏览器自测（CDP 驱动真实 Edge）
 *
 * 验证的是真实踩过的坑：
 *   1. 链接里的口令是对的 → 直接进，**不弹框**
 *   2. 链接里的口令有一位错，但本机还存着对的那把
 *      → 自动用存的那把重试，不用用户再手输
 *   3. 链接里的口令错、本机也没有对的
 *      → 弹框，并且**输入框是空的**（不预填那个错的，
 *        否则用户会以为那就是对的，怎么改都改不对）
 *
 * 跑的是本地独立实例（独立端口 + 独立数据目录），不碰线上数据。
 *
 * 用法：node test/key-flow-browser-test.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8807;
const DATA_DIR = path.join(ROOT, 'data', 'test-key-flow');
const CDP_PORT = 9337;
const ROOM_KEY = 'k7mqp4z9xrw3';
const WRONG_KEY = 'wrong-key-000';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); return; }
    catch { /* ignore */ }
  }
  try { proc.kill(); } catch { /* ignore */ }
}

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge 可执行文件');
}

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(TEST_PORT), ALT_PORT: '0', DATA_DIR, ROOM_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (buf) => {
      out += buf.toString();
      if (out.includes('聊天室已启动')) { serverProc.stdout.off('data', onData); resolve(); }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', (b) => { out += b.toString(); });
    setTimeout(() => { if (!out.includes('聊天室已启动')) reject(new Error('服务端启动超时')); }, 15000);
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function fetchTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端点未就绪');
}

/** 打开一个地址，等到「连上了」或者「弹框了」再返回 */
async function openAndSettle(cdp, url) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const st = await cdp.evaluate(`(function () {
      if (!window.ChatApp) return { ready: false };
      const m = document.getElementById('keyModal');
      const inp = document.getElementById('keyInput');
      const err = document.getElementById('keyErr');
      return {
        ready: true,
        connected: !!(window.ChatApp.state.self),
        modal: !!(m && !m.hidden),
        inputValue: inp ? inp.value : null,
        errText: err ? (err.hidden ? '' : err.textContent) : '',
        connText: (document.getElementById('connText') || {}).textContent || '',
      };
    })()`);
    if (st.ready && (st.connected || st.modal)) return st;
  }
  return null;
}

(async () => {
  console.log('\n=== 口令流程浏览器自测 ===\n');
  await startServer();
  console.log(`  测试服务端: http://localhost:${TEST_PORT}/chat（独立数据目录）\n`);

  const edge = findEdge();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-keyflow-'));
  const proc = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    const target = await fetchTarget();
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const base = `http://localhost:${TEST_PORT}/chat`;

    console.log('[1] 链接里的口令是对的 → 直接进，不弹框');
    let st = await openAndSettle(cdp, `${base}?key=${ROOM_KEY}`);
    check('直接连上了', !!st && st.connected, st ? st.connText : 'no state');
    check('没有弹口令框', !!st && !st.modal, st ? `modal=${st.modal}` : '');

    console.log('\n[2] 链接里的口令有一位错，但本机存着对的那把 → 自动重试');
    st = await openAndSettle(cdp, `${base}?key=${WRONG_KEY}`);
    check('自己就进去了（没让用户手输）', !!st && st.connected, st ? st.connText : 'no state');
    check('弹窗没挡住', !!st && !st.modal, st ? `modal=${st.modal}` : '');

    console.log('\n[3] 链接错 + 本机也没有对的 → 弹框，且不预填错值');
    await cdp.evaluate('localStorage.clear(); true');
    st = await openAndSettle(cdp, `${base}?key=${WRONG_KEY}`);
    check('弹出了口令框', !!st && st.modal, st ? `modal=${st.modal}` : 'no state');
    check('输入框是空的（不预填那个错的）', !!st && st.inputValue === '',
      st ? `输入框="${st.inputValue}"` : '');
    check('给出了"可能有一位看错"的提示', !!st && /看错|不对/.test(st.errText || ''),
      st ? (st.errText || '').slice(0, 40) : '');

    console.log('\n[4] 在弹窗里输对口令 → 进得去');
    await cdp.evaluate(`(function () {
      const i = document.getElementById('keyInput');
      i.value = '${ROOM_KEY}';
      document.getElementById('keyOk').click();
      return true;
    })()`);
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const s = await cdp.evaluate(`(function () {
        return {
          connected: !!(window.ChatApp && window.ChatApp.state.self),
          modal: !!(document.getElementById('keyModal') && !document.getElementById('keyModal').hidden),
          url: location.href,
        };
      })()`);
      if (s.connected) { ok = true; check('输对口令后连上了', true, '昵称=' + (await cdp.evaluate('window.ChatApp.state.self.name'))); break; }
    }
    if (!ok) check('输对口令后连上了', false, '超时');
    const after = await cdp.evaluate('location.href');
    check('地址栏里的错口令被就地改正了', after.includes(ROOM_KEY), after.split('?')[1] || after);
  } finally {
    if (cdp) cdp.close();
    killTree(proc);
    try { if (serverProc) serverProc.kill(); } catch { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
