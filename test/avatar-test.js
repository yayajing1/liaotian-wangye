'use strict';

/**
 * 换头像（头像颜色）测试
 *
 * 本次只新增「换头像」这一个功能，改名逻辑一行没动 —— 所以测试里
 * 也把改名当回归项跑一遍，确保没被带坏。
 *
 * 验证：
 *   1. init 里下发可选的头像颜色
 *   2. 换色生效，并广播给所有人
 *   3. 非法颜色被拒（昵称和颜色都不该变）
 *   4. 连点太快被限流
 *   5. 换色不影响昵称
 *   6. 历史消息显示的��像色跟着变
 *   7. 回归：改名功能照旧可用
 *
 * 用法：node test/avatar-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8809;
const DATA_DIR = path.join(ROOT, 'data', 'test-avatar');
const DB_FILE = path.join(DATA_DIR, 'chat.db');
const ROOM_KEY = 'avatar-test-key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/** 测试用客户端 */
class Client {
  constructor(cid) {
    this.cid = cid;
    this.ws = null;
    this.self = null;
    this.inbox = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ cid: this.cid, key: ROOM_KEY });
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?${q.toString()}`);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('连接超时')), 8000);
      ws.on('message', (raw) => {
        const d = JSON.parse(raw.toString());
        // 谁在等这个类型就直接给谁 —— 别先进收件箱，
        // 否则下一次 wait() 会拿到上一条旧消息（回执会整体错位一格）。
        const idx = this.waiters.findIndex((w) => w.type === d.t);
        if (idx >= 0) {
          this.waiters.splice(idx, 1)[0].resolve(d);
        } else {
          this.inbox.push(d);
        }
        if (d.t === 'init') {
          this.self = d.self;
          this.colors = d.colors || [];
          clearTimeout(to);
          resolve(d);
        }
      });
      ws.on('error', (e) => { clearTimeout(to); reject(e); });
    });
  }

  send(payload) { this.ws.send(JSON.stringify(payload)); }

  wait(type, ms = 5000) {
    const idx = this.inbox.findIndex((m) => m.t === type);
    if (idx >= 0) { const [hit] = this.inbox.splice(idx, 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const w = { type, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`等不到 ${type} 消息`)); }
      }, ms);
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
  drain() { this.inbox.length = 0; }
}

function readDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_FILE);
  const users = db.prepare('SELECT id, name, color FROM users').all();
  db.close();
  return users;
}

(async () => {
  console.log('\n=== 换头像测试 ===\n');

  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ALT_PORT: '0',
      DATA_DIR,
      ROOM_KEY,
      COLOR_COOLDOWN_MS: '1200',     // 测试里把限流窗口调短
    },
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
  if (!up) { console.log('服务端没起来：\n' + out); process.exit(1); }

  const clients = [];
  try {
    console.log('[1] init 里要下发可选的头像颜色');
    const a = new Client('av-a');
    await a.connect();
    clients.push(a);
    check('init 带回了颜色列表', Array.isArray(a.colors) && a.colors.length >= 20,
      `共 ${a.colors.length} 色`);
    const oldColor = a.self.color;
    const newColor = a.colors.find((c) => c !== oldColor);
    check('初始颜色在色池里', a.colors.includes(oldColor), oldColor);

    console.log('\n[2] 换头像色');
    const b = new Client('av-b');
    await b.connect();
    clients.push(b);

    b.drain();
    a.send({ t: 'avatar', color: newColor });
    const ack = await a.wait('avatarAck');
    check('回执是成功', ack.ok === true, JSON.stringify(ack));
    check('回执里的颜色是新的', ack.user && ack.user.color === newColor, ack.user && ack.user.color);

    const bSaw = await b.wait('avatar');
    check('别人也收到了广播', bSaw.user && bSaw.user.color === newColor, bSaw.user && bSaw.user.color);

    const users1 = readDb();
    check('数据库里存的是新颜色',
      users1.some((u) => u.color === newColor), users1.map((u) => u.color).join(','));

    console.log('\n[3] 非法颜色要被拒绝，且不改动任何东西');
    await sleep(1400);
    const before = readDb();
    a.send({ t: 'avatar', color: '#ff00ff' });
    const ack2 = await a.wait('avatarAck');
    check('非法颜色被拒', ack2.ok === false, JSON.stringify(ack2));
    check('给出了原因', typeof ack2.msg === 'string' && ack2.msg.length > 0, ack2.msg);
    const after = readDb();
    check('昵称和颜色都没变',
      JSON.stringify(before.map((u) => [u.name, u.color]).sort())
      === JSON.stringify(after.map((u) => [u.name, u.color]).sort()));

    console.log('\n[4] 连点太快要被限流');
    const c2 = a.colors.find((c) => c !== newColor);
    const c3 = a.colors.find((c) => c !== newColor && c !== c2);   // 必须是另一种颜色
    a.send({ t: 'avatar', color: c2 });
    const ack3 = await a.wait('avatarAck');
    check('第一次成功', ack3.ok === true, JSON.stringify(ack3));
    a.send({ t: 'avatar', color: c3 });
    const ack4 = await a.wait('avatarAck');
    check('紧接着第二次被限流', ack4.ok === false, JSON.stringify(ack4));
    check('限流提示友好', typeof ack4.msg === 'string' && /快/.test(ack4.msg), ack4.msg);

    console.log('\n[5] 换色不该动昵称');
    await sleep(1400);
    const nameBefore = readDb().find((u) => u.color === c2).name;
    a.send({ t: 'avatar', color: oldColor });
    const ack5 = await a.wait('avatarAck');
    check('换色成功', ack5.ok === true, JSON.stringify(ack5));
    check('昵称没被改', ack5.user && ack5.user.name === nameBefore, ack5.user && ack5.user.name);

    console.log('\n[6] 历史消息显示的头像色跟着变');
    await sleep(1400);
    const c = new Client('av-c');
    await c.connect();
    clients.push(c);
    c.send({ t: 'msg', text: '在吗' });
    await sleep(600);
    const colorNow = ack5.user.color;
    const colorOther = a.colors.find((x) => x !== colorNow);
    await sleep(1400);
    c.send({ t: 'avatar', color: colorOther });
    await c.wait('avatarAck');
    await sleep(400);

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const row = db.prepare(
      `SELECT m.text, u.name AS shown_name, u.color AS shown_color
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.text = '在吗'`).get();
    db.close();
    check('历史消息的显示色已更新', row && row.shown_color === colorOther,
      row ? row.shown_color : '(没查到)');
    check('历史消息里的名字没变', row && row.shown_name && !/^用户/.test(row.shown_name),
      row && row.shown_name);

    console.log('\n[7] 回归：改名功能照旧可用');
    await sleep(1400);
    a.send({ t: 'nick', name: '老王' });
    const nickMsg = await a.wait('nick');
    check('改名广播照旧发出', nickMsg.user && nickMsg.user.name === '老王',
      nickMsg.user && nickMsg.user.name);
    check('改名后颜色保持不变', nickMsg.user && nickMsg.user.color === oldColor,
      nickMsg.user && nickMsg.user.color);

  } catch (err) {
    fail++;
    console.log('  ✗ 测试异常：' + err.message);
    console.log(out.slice(-1500));
  } finally {
    for (const c of clients) c.close();
    server.kill();
  }

  console.log(`\n通过 ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})();
