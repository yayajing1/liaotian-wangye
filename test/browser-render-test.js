/**
 * 浏览器渲染自测：用 CDP 驱动真实 Edge，验证「自己右边、别人左边」
 *
 * 流程：
 *   1. 无头启动 Edge，打开聊天室页面
 *   2. 用另一个 WS 客户端发消息（模拟他人）→ 应渲染在左侧
 *   3. 在页面里输入并发送（模拟自己）→ 应渲染在右侧
 *   4. 截图存盘
 *
 * 用法：node test/browser-render-test.js
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

/**
 * 连同子进程一起杀掉。
 *
 * Windows 上 proc.kill() 只杀主进程，Edge 的网络服务等子进程会留下来 ——
 * 而那个网络服务正抱着页面的 WebSocket 连接不放，
 * 于是服务端会一直以为「这个用户还在线」，成员列表里就多出一个幽灵。
 */
function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch { /* 退回下面的方式 */ }
  }
  try { proc.kill(); } catch { /* ignore */ }
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const PAGE_URL = 'http://localhost:8803/chat';
const CHAT_URL = 'ws://localhost:8803/ws';
const PORT = 9333;
const OUT = path.join(__dirname, '..', 'render-check.png');

// 本测试自己起一个服务端实例（独立端口 + 独立数据目录），
// 避免测试产生的用户行把线上数据库的昵称池占满。
const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8803;
const DATA_DIR = path.join(ROOT, 'data', 'test-render');

let serverProc = null;

function startServer() {
  return new Promise((resolve, reject) => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(TEST_PORT), ALT_PORT: '0', DATA_DIR, ROOM_KEY: '' },
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

function stopServer() {
  try { if (serverProc) serverProc.kill(); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge 可执行文件');
}

/* ---------------- 极简 CDP 客户端 ---------------- */

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
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function fetchTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端点未就绪');
}

async function main() {
  console.log('\n=== 浏览器渲染自测 ===\n');

  await startServer();
  console.log(`  测试服务端: ${PAGE_URL}（独立数据目录，不碰线上数据）\n`);

  const edge = findEdge();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-chat-'));

  const proc = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1280,860',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const target = await fetchTarget();
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('[1] 打开聊天室页面');
    await cdp.send('Page.navigate', { url: PAGE_URL });
    await sleep(2500);

    const selfName = await cdp.evaluate('window.ChatApp && window.ChatApp.state.self ? window.ChatApp.state.self.name : null');
    console.log(`    页面身份: ${selfName}`);
    if (!selfName) throw new Error('页面未建立 WebSocket 连接');

    /* ---------- 他人发消息 → 应在左侧 ---------- */
    console.log('[2] 模拟他人发言');
    const other = new WebSocket(CHAT_URL);
    await new Promise((res, rej) => { other.on('open', res); other.on('error', rej); });
    const otherName = await new Promise((res) => {
      other.on('message', (raw) => {
        const d = JSON.parse(raw.toString());
        if (d.t === 'init') res(d.self.name);
      });
    });
    console.log(`    他人身份: ${otherName}`);
    other.send(JSON.stringify({ t: 'msg', text: '这条是别人发的，应该在左边' }));
    await sleep(700);

    /* ---------- 自己发消息 → 应在右侧 ---------- */
    console.log('[3] 模拟自己发言');
    await cdp.evaluate(`
      (() => {
        const i = document.getElementById('input');
        i.value = '这条是我自己发的，应该在右边';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('sendBtn').click();
        return true;
      })()
    `);
    await sleep(900);

    /* ---------- 刷新页面后自己的消息仍应在右侧 ---------- */
    console.log('[4] 刷新页面（F5）后自己的消息应仍在右侧');
    const beforeReload = await cdp.evaluate('window.ChatApp.state.self.id');
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(3000);
    const afterReload = await cdp.evaluate(`
      (() => {
        const app = window.ChatApp;
        if (!app || !app.state.self) return { ok: false, reason: '未建立连接' };
        const selfId = app.state.self.id;
        const mine = app.state.messages.filter(m => m.from.id === selfId && m.kind !== 'system');
        const container = document.getElementById('messages');
        const cRect = container.getBoundingClientRect();
        const rels = mine.map(m => {
          const b = m.querySelector ? null : null;
          return null;
        });
        return {
          ok: true,
          selfId,
          mineCount: mine.length,
          // 找出自己那条在 DOM 里的位置
          domRel: [...document.querySelectorAll('.msg')].map(r => {
            const isSelf = r.classList.contains('self');
            const bub = r.querySelector('.bubble');
            const br = bub.getBoundingClientRect();
            return { isSelf, rel: (br.left + br.width / 2 - cRect.left) / cRect.width, text: bub.textContent.slice(0, 20) };
          }),
        };
      })()
    `);
    console.log(`    刷新前 self.id = ${beforeReload}`);
    console.log(`    刷新后 self.id = ${afterReload.selfId}`);
    console.log(`    id 是否保持    = ${beforeReload === afterReload.selfId ? 'YES ✓' : 'NO ✗'}`);
    console.log(`    自己消息条数   = ${afterReload.mineCount}`);
    const mineAfter = (afterReload.domRel || []).filter(d => d.isSelf);
    console.log(`    刷新后自己消息在右侧 = ${mineAfter.length > 0 && mineAfter.every(d => d.rel > 0.5) ? 'YES ✓' : 'NO ✗'}`);
    console.log('    ' + JSON.stringify(afterReload.domRel || []).slice(0, 600));

    /* ---------- 撤回一条 ---------- */
    console.log('[5] 模拟撤回');
    await cdp.evaluate(`
      (() => {
        const app = window.ChatApp;
        const mine = app.state.messages.find(m => m.from.id === app.state.self.id && m.kind !== 'recalled');
        if (!mine) return 'no-msg';
        app.state.ws.send(JSON.stringify({ t: 'recall', id: mine.id }));
        return mine.id;
      })()
    `);
    await sleep(700);

    /* ---------- 断言 DOM 结构 ---------- */
    console.log('[6] 校验 DOM 左右分栏');
    const dom = await cdp.evaluate(`
      (() => {
        const app = window.ChatApp;
        const selfId = app.state.self.id;
        const container = document.getElementById('messages');
        const cRect = container.getBoundingClientRect();

        const rows = [...document.querySelectorAll('.msg')];
        // 关键：不能只靠 class 判断，要量真实像素位置
        const info = rows.map(r => {
          const bubble = r.querySelector('.bubble');
          const bRect = bubble.getBoundingClientRect();
          const center = bRect.left + bRect.width / 2;
          return {
            self: r.classList.contains('self'),
            // 气泡中心相对容器的位置：0 = 最左，1 = 最右
            rel: (center - cRect.left) / cRect.width,
            text: bubble.textContent.slice(0, 24),
            recalled: bubble.classList.contains('recalled'),
          };
        });

        const others = info.filter(i => !i.self);
        const selves = info.filter(i => i.self);

        // 自己发的：气泡中心必须在容器右半边
        const allSelvesAreRight = selves.every(i => i.rel > 0.5);
        // 别人发的：气泡中心必须在容器左半边
        const allOthersAreLeft = others.every(i => i.rel < 0.5);

        const computed = (el) => {
          const s = getComputedStyle(el);
          return { align: s.alignItems, flexDir: s.flexDirection, justify: s.justifyContent };
        };
        const visible = (id) => {
          const e = document.getElementById(id);
          return getComputedStyle(e).display !== 'none';
        };
        return {
          total: info.length,
          othersCount: others.length,
          selvesCount: selves.length,
          allOthersAreLeft,
          allSelvesAreRight,
          minSelfRel: selves.length ? Math.min(...selves.map(i => i.rel)) : null,
          maxOtherRel: others.length ? Math.max(...others.map(i => i.rel)) : null,
          messagesFlexDir: computed(container).flexDir,
          emojiPanelVisible: visible('emojiPanel'),
          quoteBarVisible: visible('quoteBar'),
          sampleOther: others[0] || null,
          sampleSelf: selves[0] || null,
          recalledCount: info.filter(i => i.recalled).length,
        };
      })()
    `);
    console.log('    ' + JSON.stringify(dom, null, 2).replace(/\n/g, '\n    '));

    /* ---------- 截图 ---------- */
    console.log('[7] 截图');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(`    已保存 ${OUT}`);

    other.close();

    const reloadOk = beforeReload === afterReload.selfId
      && mineAfter.length > 0 && mineAfter.every(d => d.rel > 0.5);

    const pass = dom.othersCount >= 1 && dom.selvesCount >= 1
      && dom.allOthersAreLeft && dom.allSelvesAreRight && dom.recalledCount >= 1
      && !dom.emojiPanelVisible && !dom.quoteBarVisible && reloadOk;
    console.log(`\n=== 结果：${pass ? '全部通过 ✓' : '存在问题 ✗'} ===\n`);
    if (!pass) {
      console.log('  emojiPanelVisible =', dom.emojiPanelVisible);
      console.log('  quoteBarVisible   =', dom.quoteBarVisible);
      console.log('  others/selves     =', dom.othersCount, '/', dom.selvesCount);
      console.log('  recalledCount     =', dom.recalledCount);
      console.log('  自己消息最靠左 rel =', dom.minSelfRel, '(应 > 0.5)');
      console.log('  他人消息最靠右 rel =', dom.maxOtherRel, '(应 < 0.5)');
      console.log('  刷新后身份保持    =', beforeReload === afterReload.selfId, '(应 true)');
      console.log('  刷新后自己仍在右  =', mineAfter.map(d => d.rel.toFixed(3)).join(', '), '(应 > 0.5)');
    }
    process.exitCode = pass ? 0 : 1;
  } catch (err) {
    console.error('测试异常:', err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    killTree(proc);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    stopServer();
  }
}

main();
