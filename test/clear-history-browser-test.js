'use strict';

/**
 * 清除本机聊天记录 —— 浏览器真实测试
 *
 * 语义跟微信一致：**只清「自己这台设备上看到的」**，
 * 服务器上的消息不动，其他人那边也不受影响。
 *
 * 验证：
 *   1. 聊天区顶部有「清除记录」入口
 *   2. 点它先弹确认框（不是一点就删）
 *   3. 点「取消」→ 消息一条不少
 *   4. 点「确定清除」→ 本机消息清空
 *   5. 刷新页面 → 旧消息不会再冒出来（切点持久化生效）
 *   6. **服务器上的数据还在**（另一个连接照样能读到历史）
 *   7. 清除后新消息正常显示
 *   8. 手机尺寸下按钮可见可点、确认框不溢出
 *
 * 用法：node test/clear-history-browser-test.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8819;
const DATA_DIR = path.join(ROOT, 'data', 'test-clear-history');
const KEY = 'clear-history-key';
const CDP_PORT = 9369;
const OUT = path.join(ROOT, 'clear-history-check.png');

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
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch { /* ignore */ }
  }
  try { proc.kill(); } catch { /* ignore */ }
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
      setTimeout(() => {
        if (this.p.has(id)) { this.p.delete(id); reject(new Error(method + ' 超时')); }
      }, 20000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 用普通 WebSocket 当"另一个客户端"，读服务端历史 */
function peerConnect(cid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?cid=${encodeURIComponent(cid)}&key=${encodeURIComponent(KEY)}`);
    const t = setTimeout(() => reject(new Error('连接超时')), 10000);
    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.t === 'init') { clearTimeout(t); resolve({ ws, init: d }); }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const PAGE = `http://localhost:${PORT}/chat#key=${KEY}`;

(async () => {
  console.log('\n=== 清除本机聊天记录 测试 ===\n');

  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.execPath ? { ...process.env, PORT: String(PORT), ALT_PORT: '0', DATA_DIR, ROOM_KEY: KEY } : {} },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (out.includes('聊天室已启动')) { up = true; break; }
  }
  if (!up) { console.log('服务端没起来：\n' + out); server.kill(); process.exit(1); }

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge，跳过'); server.kill(); process.exit(0); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-clear-'));
  const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

  let cdp = null;
  const peers = [];
  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const l = await r.json();
        target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* 等浏览器 */ }
      await sleep(250);
    }
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    /* ---------- [1] 入口存在 ---------- */
    console.log('[1] 顶部有「清除记录」入口');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url: PAGE });

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('进到了房间', ready);

    const btnInfo = await cdp.evaluate(`(function(){
      var b = document.getElementById('clearHistBtn');
      if (!b) return { ok: false };
      var r = b.getBoundingClientRect();
      return { ok: true, text: b.textContent.trim(), visible: r.width > 0 && r.height > 0,
               inScreen: r.right <= window.innerWidth + 1 && r.top >= 0 };
    })()`);
    check('「清除记录」按钮存在', btnInfo.ok);
    check('按钮在聊天区顶部右侧、看得见', btnInfo.visible && btnInfo.inScreen, btnInfo.text);

    /* ---------- [2] 先有别人的消息 ---------- */
    console.log('\n[2] 别人发几条消息');
    const peer = await peerConnect('clear-peer-1');
    peers.push(peer.ws);
    for (let i = 1; i <= 3; i++) {
      peer.ws.send(JSON.stringify({ t: 'msg', text: `第 ${i} 条消息` }));
      await sleep(350);
    }
    await sleep(600);
    const before = await cdp.evaluate(`document.querySelectorAll('#messages .msg').length`);
    check('页面上看到了 3 条消息', before === 3, `实际 ${before} 条`);

    /* ---------- [3] 点按钮先弹确认框 ---------- */
    console.log('\n[3] 点「清除记录」先弹确认框');
    await cdp.evaluate(`document.getElementById('clearHistBtn').click()`);
    await sleep(400);
    const modalOpen = await cdp.evaluate(`(function(){
      var m = document.getElementById('clearModal');
      if (!m || m.hidden) return { open: false };
      var r = m.querySelector('.modal').getBoundingClientRect();
      // 关键：确认框不能被别的弹窗盖住。
      // 打开页面时账号框会自动弹出来，如果清除框 z-index 不够高，
      // 用户点了「清除记录」会**什么都看不见**。
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var top = document.elementFromPoint(cx, cy);
      var covered = !(top && m.contains(top));
      return { open: true, inScreen: r.top >= 0 && r.bottom <= window.innerHeight + 1,
               title: (m.querySelector('.modal-title')||{}).textContent || '',
               covered: covered,
               coverBy: covered && top ? (top.id || top.className || top.tagName) : '' };
    })()`);
    check('弹出的是白框确认框', modalOpen.open, modalOpen.title);
    check('确认框在屏幕内', modalOpen.inScreen !== false);
    check('确认框没被别的弹窗盖住', modalOpen.covered !== true,
      modalOpen.covered ? `被「${modalOpen.coverBy}」挡住了` : '在最上层');

    /* ---------- [4] 取消 = 什么都不该丢 ---------- */
    console.log('\n[4] 点「取消」→ 消息一条不少');
    await cdp.evaluate(`document.getElementById('clearCancel').click()`);
    await sleep(300);
    const afterCancel = await cdp.evaluate(`document.querySelectorAll('#messages .msg').length`);
    const modalClosed = await cdp.evaluate(`document.getElementById('clearModal').hidden`);
    check('取消后确认框关掉', modalClosed === true);
    check('取消后消息一条不少', afterCancel === before, `${afterCancel} / ${before}`);

    /* ---------- [5] 确定清除 ---------- */
    console.log('\n[5] 点「确定清除」→ 本机清空');
    await cdp.evaluate(`document.getElementById('clearHistBtn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.getElementById('clearOk').click()`);
    await sleep(500);
    const afterClear = await cdp.evaluate(`(function(){
      return { n: document.querySelectorAll('#messages .msg').length,
               clearedAt: window.ChatApp.state.clearedAt || 0,
               modalHidden: document.getElementById('clearModal').hidden };
    })()`);
    check('确认框自动关掉', afterClear.modalHidden === true);
    check('本机消息已清空', afterClear.n === 0, `还剩 ${afterClear.n} 条`);
    check('记下了清除时间点', afterClear.clearedAt > 0);

    /* ---------- [6] 刷新后不会再冒出来 ---------- */
    console.log('\n[6] 刷新页面 → 旧消息不再出现');
    // ⚠️ 必须用 Page.reload —— Page.navigate 到**完全相同**的 URL 只是同文档导航，
    // 页面根本不会重新加载，测的就不是「刷新」了。
    await cdp.send('Page.reload', { ignoreCache: false });
    ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    await sleep(800);
    const afterReload = await cdp.evaluate(`(function(){
      return { n: document.querySelectorAll('#messages .msg').length,
               msgs: window.ChatApp.state.messages.length,
               clearedAt: window.ChatApp.state.clearedAt || 0 };
    })()`);
    check('刷新后仍然进到了房间', ready);
    check('刷新后旧消息没有回来', afterReload.n === 0, `DOM ${afterReload.n} 条 / 内存 ${afterReload.msgs} 条`);
    check('服务端把历史发下来了（内存里有）', afterReload.msgs > 0, `内存 ${afterReload.msgs} 条`);
    check('清除时间点被记住了', afterReload.clearedAt > 0);

    /* ---------- [7] 服务器上的数据还在 ---------- */
    console.log('\n[7] 服务器上的数据没被动过');
    const peer2 = await peerConnect('clear-peer-2');
    peers.push(peer2.ws);
    // 服务端下发的历史字段叫 history（不是 messages）
    const hist = (peer2.init.history || []).filter((m) => m.kind !== 'system');
    check('另一个客户端照样能读到 3 条历史', hist.length === 3, `读到 ${hist.length} 条`);
    check('历史内容还是那三条',
      hist.map((m) => m.text).join('|') === '第 1 条消息|第 2 条消息|第 3 条消息',
      hist.map((m) => m.text).join('|'));

    /* ---------- [8] 清除后新消息正常显示 ---------- */
    console.log('\n[8] 清除后新消息照常显示');
    peer2.ws.send(JSON.stringify({ t: 'msg', text: '清除之后的新消息' }));
    await sleep(900);
    const afterNew = await cdp.evaluate(`(function(){
      var list = Array.prototype.map.call(
        document.querySelectorAll('#messages .msg .bubble'), function(e){ return e.textContent; });
      return { n: document.querySelectorAll('#messages .msg').length, list: list };
    })()`);
    check('新消息显示出来了', afterNew.n >= 1, `现在 ${afterNew.n} 条`);
    check('新消息内容正确', afterNew.list.join('|').indexOf('清除之后的新消息') >= 0,
      afterNew.list.join(' | '));

    /* ---------- [9] 手机尺寸 ---------- */
    console.log('\n[9] 手机尺寸（390×844）');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(600);
    const mob = await cdp.evaluate(`(function(){
      var b = document.getElementById('clearHistBtn');
      var r = b.getBoundingClientRect();
      var bar = document.querySelector('.chat-bar').getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, w: r.width, h: r.height,
               inScreen: r.right <= window.innerWidth + 1,
               barH: bar.height, vw: window.innerWidth };
    })()`);
    check('手机上一键可点（不小于 24px 高）', mob.visible && mob.h >= 24, `${mob.h.toFixed(0)}px`);
    check('按钮没超出屏幕', mob.inScreen, `w=${mob.w.toFixed(0)} vw=${mob.vw}`);
    check('顶部条够矮（不占地方）', mob.barH <= 60, `${mob.barH.toFixed(0)}px`);

    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
      console.log(`\n  截图已保存 ${OUT}`);
    } catch { /* ignore */ }
  } catch (e) {
    fail++;
    console.log('\n测试异常：', e.message);
  } finally {
    for (const w of peers) { try { w.close(); } catch { /* ignore */ } }
    if (cdp) cdp.close();
    killTree(proc);
    try { server.kill(); } catch { /* ignore */ }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail ? 1 : 0);
})();
