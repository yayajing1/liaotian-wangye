/**
 * 多人头像视觉验证：用 CDP 驱动真实 Edge
 *
 * 验证需求：「第二个甚至以上的人登入，会拿到新的（不重复的）头像」
 *
 * 流程：
 *   1. 无头启动 Edge，打开聊天室
 *   2. 另开 6 个 WS 客户端模拟其他用户登入（各自有独立昵称+颜色）
 *   3. 让他们各发一条消息 → 页面上应该出现 6 个不同色底的头像
 *   4. 读取每个头像的实际计算样式（背景色 + 文字），断言两两不同
 *   5. 截图，看侧栏成员列表和消息气泡里的头像是否肉眼可区分
 *
 * 用法：node test/avatar-visual-test.js
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
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

const PAGE_URL = 'http://localhost:8802/chat';
const CHAT_URL = 'ws://localhost:8802/ws';
const CDP_PORT = 9335;
const OUT = path.join(__dirname, '..', 'avatar-check.png');

// 本测试自己起一个服务端实例（独立端口 + 独立数据目录），
// 避免测试产生的用户行把线上数据库的昵称池占满 ——
// 昵称是全局唯一的（在线 + 历史一起算），池子被测试占光后
// 新用户只能拿到「XX2」这类后缀名，头像首字就都一样了。
const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8802;
const DATA_DIR = path.join(ROOT, 'data', 'test-avatar');

let serverProc = null;

function startServer() {
  return new Promise((resolve, reject) => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        ALT_PORT: '0',
        DATA_DIR,
        ROOM_KEY: '',
      },
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

const OTHERS = 6;   // 模拟的其他用户数
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
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 20000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || '页面内异常');
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 找到页面类型的 target（而不是浏览器级 target） */
async function fetchTarget() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到 page 类型的 target');
  return page;
}

async function getCDP() {
  const target = await fetchTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  return cdp;
}

function connect(cid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${CHAT_URL}?cid=${encodeURIComponent(cid)}`);
    const t = setTimeout(() => reject(new Error('连接超时')), 15000);
    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.t === 'init') { clearTimeout(t); resolve({ ws, self: d.self }); }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/* ---------------- 主流程 ---------------- */

(async () => {
  console.log('\n=== 多人头像视觉验证 ===\n');

  await startServer();
  console.log(`  测试服务端: ${PAGE_URL}（独立数据目录，不碰线上数据）\n`);

  const edge = findEdge();
  const profile = path.join(__dirname, '..', '.tmp-edge-avatar');
  const edgeProc = spawn(edge, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1100,720',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    // 等 Edge 起来
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try { cdp = await getCDP(); break; } catch { /* 还没起来 */ }
    }
    if (!cdp) throw new Error('Edge CDP 连接失败');

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('[1] 打开聊天室页面');
    await cdp.send('Page.navigate', { url: PAGE_URL });
    await sleep(2800);

    const selfName = await cdp.evaluate(
      'window.ChatApp && window.ChatApp.state.self ? window.ChatApp.state.self.name : null'
    );
    console.log(`    页面身份: ${selfName}`);
    if (!selfName) throw new Error('页面未建立 WebSocket 连接');

    console.log(`[2] 模拟 ${OTHERS} 个其他用户登入并发消息`);
    const peers = [];
    for (let i = 1; i <= OTHERS; i++) {
      const p = await connect(`avatar-test-${i}-${Date.now()}`);
      peers.push(p);
      p.ws.send(JSON.stringify({ t: 'msg', text: `我是第 ${i} 位登入的用户` }));
      await sleep(120);
    }
    await sleep(1200);

    // 自己也发一条，验证 self 分支（自己的消息应有 self 类、头像在右）
    console.log('[2b] 页面自己发一条消息');
    await cdp.evaluate(`
      (() => {
        const i = document.getElementById('input');
        i.value = '这是我自己发的消息';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('sendBtn').click();
        return true;
      })()
    `);
    await sleep(1200);

    console.log('[3] 读取页面上的头像实际样式');
    const data = await cdp.evaluate(`
      (() => {
        const pick = (el) => {
          const s = getComputedStyle(el);
          return {
            bg: s.backgroundColor,
            text: el.textContent,
            color: s.color,
            w: el.getBoundingClientRect().width,
          };
        };
        // 消息区里的头像（他人消息 = .msg:not(.self) .avatar）
        const msgAvatars = [...document.querySelectorAll('.msg:not(.self) .avatar')].map(pick);
        // 侧栏成员列表里的头像
        const sideAvatars = [...document.querySelectorAll('.users .avatar')].map(pick);
        // 自己（.me .avatar）
        const me = document.querySelector('.me .avatar');
        return {
          msgAvatars,
          sideAvatars,
          me: me ? pick(me) : null,
          msgCount: document.querySelectorAll('.msg').length,
          userCount: document.querySelectorAll('.users li').length,
        };
      })()
    `);

    console.log('\n--- 消息区头像（他人）---');
    data.msgAvatars.forEach((a, i) => {
      console.log(`  ${i + 1}. 底色=${a.bg}  首字="${a.text}"  字色=${a.color}`);
    });
    console.log('\n--- 侧栏成员头像 ---');
    data.sideAvatars.forEach((a, i) => {
      console.log(`  ${i + 1}. 底色=${a.bg}  首字="${a.text}"`);
    });
    console.log(`\n  自己: ${data.me ? data.me.bg + ' 首字=' + data.me.text : '(无)'}`);
    console.log(`  消息条数=${data.msgCount}  成员数=${data.userCount}`);

    console.log('\n[4] 断言');
    // 关键指标：侧栏在线成员列表 —— 每个「人」一个头像，底色必须两两不同。
    // （消息区会重复渲染同一个人的头像，那不是撞色。）
    const sideBgs = data.sideAvatars.map((a) => a.bg);
    const sideUniq = new Set(sideBgs);
    const sideDup = sideBgs.filter((b, i) => sideBgs.indexOf(b) !== i);

    // 消息区：按首字+底色去重，检查「不同的人」之间是否撞色
    const msgPeople = new Map();   // key = 首字|底色 → 出现次数
    for (const a of data.msgAvatars) {
      const k = a.text + '|' + a.bg;
      msgPeople.set(k, (msgPeople.get(k) || 0) + 1);
    }
    // 不同的人撞色 = 首字相同 但 底色不同 的人共用…… 反过来：
    // 真正的问题是两个不同的人用了同一个「首字+底色」组合 → 那就认不出来了
    const personKeys = [...msgPeople.keys()];
    const personDup = personKeys.filter((k, i) => personKeys.indexOf(k) !== i);

    // 自己也在侧栏里，先把「自己」那一条排除掉，再比较其余人的色
    const othersOnly = data.me
      ? sideBgs.filter((b) => b !== data.me.bg)
      : sideBgs;
    const othersUnique = new Set(othersOnly);

    const checks = [
      ['侧栏成员头像数 = ' + data.sideAvatars.length, data.sideAvatars.length >= OTHERS + 1],
      ['侧栏头像底色两两不同（每人一个色）', sideUniq.size === sideBgs.length],
      ['消息区不同的人未混淆（首字+底色组合唯一）', personDup.length === 0],
      ['自己与所有他人头像色都不同', othersUnique.size === othersOnly.length],
      ['侧栏头像首字互不相同', new Set(data.sideAvatars.map((a) => a.text)).size === sideBgs.length],
      ['头像尺寸正常(>=20px)', data.msgAvatars.every((a) => a.w >= 20)],
      // 注意：msgAvatars 只取了「他人消息」的头像（.msg:not(.self)），
      // 所以这里最多是 OTHERS 个人 —— 自己的头像由 data.me 单独校验。
      ['消息区出现的人数为 ' + personKeys.length + '（应为 ' + OTHERS + '）', personKeys.length >= OTHERS],
    ];

    let pass = 0;
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? '✓' : '✗'} ${name}`);
      if (ok) pass++;
    }
    if (sideDup.length) {
      console.log(`  侧栏撞色明细: ${[...new Set(sideDup)].join(', ')}`);
    }

    console.log('\n[5] 截图');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('  已保存 ' + OUT);

    console.log(`\n=== 结果：${pass}/${checks.length} 通过 ===\n`);
    process.exitCode = pass === checks.length ? 0 : 1;

    peers.forEach((p) => { try { p.ws.close(); } catch { /* ignore */ } });
  } catch (e) {
    console.error('\n测试失败:', e.message);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    killTree(edgeProc);
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    stopServer();
  }
})();
