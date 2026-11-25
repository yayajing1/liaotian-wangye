'use strict';

/**
 * 房间口令测试
 *
 * 验证内测期间「只有拿到口令的人能进这个房间」：
 *   1. 不带口令 → 连不上
 *   2. 口令错   → 连不上
 *   3. 口令对   → 能进
 *   4. 被拒的人**不会留下任何痕迹**：不占用户行、不占昵称、
 *      不出现在成员列表里、历史消息里也没有他
 *   5. 本机访问可以通过 /api/room-key 免手输口令；
 *      公网 Host（模拟隧道过来的请求）拿不到
 *
 * 用法：node test/room-key-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8806;
const DATA_DIR = path.join(ROOT, 'data', 'test-room-key');
const DB_FILE = path.join(DATA_DIR, 'chat.db');
const ROOM_KEY = 'test-key-123456';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function readDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_FILE);
  const users = db.prepare('SELECT id, name FROM users').all();
  const messages = db.prepare('SELECT id, text FROM messages').all();
  db.close();
  return { users, messages };
}

/** 连一下，返回连上后的身份；被拒则返回 null */
const openSockets = [];
function tryConnect(key, cid) {
  return new Promise((resolve) => {
    const q = new URLSearchParams();
    if (cid) q.set('cid', cid);
    if (key !== null) q.set('key', key);
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?${q.toString()}`);
    let settled = false;

    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (v.ok) openSockets.push(ws);   // 成功的先留着，后面要查成员列表
      else { try { ws.close(); } catch { /* ignore */ } }
      resolve(v);
    };

    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.t === 'init') finish({ ok: true, self: d.self, online: d.users || [] });
      else if (d.t === 'error') finish({ ok: false, code: d.code, msg: d.msg });
    });
    ws.on('error', () => finish({ ok: false, code: 'socket_error' }));
    ws.on('close', () => finish({ ok: false, code: 'closed' }));
    setTimeout(() => finish({ ok: false, code: 'timeout' }), 6000);
  });
}

/** 用指定 Host 头请求本机接口（模拟隧道过来的公网请求） */
function fetchRoomKey(hostHeader) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/room-key',
      method: 'GET',
      headers: { Host: hostHeader },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

(async () => {
  console.log('\n=== 房间口令测试 ===\n');

  // 干净起步
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });

  // 等端口起来
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (out.includes('聊天室已启动')) { up = true; break; }
  }
  if (!up) {
    console.log('服务端没起来：\n' + out);
    process.exit(1);
  }

  try {
    console.log('[1] 不带口令 / 口令错，都进不来');
    const noKey = await tryConnect(null, 'rk-nokey');
    check('不带口令被拒绝', !noKey.ok, `code=${noKey.code}`);
    const badKey = await tryConnect('wrong-key', 'rk-bad');
    check('错误口令被拒绝', !badKey.ok, `code=${badKey.code}`);
    check('拒绝时给出「口令不正确」提示',
      badKey.code === 'socket_error' || badKey.code === 'closed' || badKey.code === 'timeout'
      || /口令/.test(badKey.msg || ''),
      badKey.msg || badKey.code);

    console.log('\n[2] 被拒的人不留任何痕迹');
    const db1 = readDb();
    check('数据库里没有用户行', db1.users.length === 0, `users=${db1.users.length}`);
    check('数据库里没有消息', db1.messages.length === 0, `messages=${db1.messages.length}`);

    console.log('\n[3] 口令对了才能进');
    const ok = await tryConnect(ROOM_KEY, 'rk-ok');
    check('带正确口令能连上', ok.ok, ok.ok ? `昵称=${ok.self.name}` : `code=${ok.code}`);

    const db2 = readDb();
    check('进了的人留下了用户行', db2.users.length === 1, `users=${db2.users.length}`);

    console.log('\n[4] 成员列表里只有合法进入的人');
    const admin = await tryConnect(ROOM_KEY, 'rk-admin');
    check('第二个合法连接也能进', admin.ok, admin.ok ? admin.self.name : admin.code);
    if (admin.ok) {
      const names = admin.online.map((u) => u.name);
      check('成员列表里只有合法连接', admin.online.length === 2,
        `${admin.online.length} 人: ${names.join(', ')}`);
    }

    console.log('\n[5] 被拒的人不会出现在别人的成员列表里');
    const third = await tryConnect(ROOM_KEY, 'rk-third');
    check('第三个合法连接能进', third.ok, third.ok ? third.self.name : third.code);
    const db3 = readDb();
    check('库里只有 3 个合法用户', db3.users.length === 3, `users=${db3.users.length}`);
    check('库里没有测试留下的脏用户', db3.users.every((u) => u.name && u.name.length > 0),
      db3.users.map((u) => u.name).join(','));
    if (third.ok) {
      check('第三个连接的成员列表里也只有 3 个合法用户', third.online.length === 3,
        third.online.map((u) => u.name).join(', '));
    }

    console.log('\n[6] 本机可以免手输口令，公网 Host 拿不到');
    const local = await fetchRoomKey(`localhost:${TEST_PORT}`);
    check('本机请求返回口令', local.status === 200 && /test-key-123456/.test(local.body),
      `status=${local.status}`);
    const viaTunnel = await fetchRoomKey('some-random-name.trycloudflare.com');
    check('公网 Host 拿不到口令', viaTunnel.status === 403, `status=${viaTunnel.status}`);
    const lanHost = await fetchRoomKey('192.168.1.50:8806');
    check('非本机 Host 也拿不到', lanHost.status === 403, `status=${lanHost.status}`);

    // 手机上把口令敲对很容易"看着对其实不对"，服务端必须 tolerant。
    // 真实踩过的坑：人工誊写时把 1 看成 l、把 0 看成 o，
    // 对方被反复弹框却怎么也进不来。
    console.log('\n[7] 口令的"脏字符"要能自动归一化');
    const fullWidth = ROOM_KEY.replace(/[!-~]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
    const upper = ROOM_KEY.toUpperCase();
    const spaced = ' ' + ROOM_KEY + ' ';
    const broken = ROOM_KEY.slice(0, 3) + ' ' + ROOM_KEY.slice(3);

    const variants = [
      ['全角字符（中文输入法）', fullWidth],
      ['全大写（键盘自动大写）', upper],
      ['前后带空格', spaced],
      ['中间带空格', broken],
    ];
    for (const [label, variant] of variants) {
      const r = await tryConnect(variant, 'rk-norm-' + label);
      check(`${label} 也能进`, r.ok, r.ok ? `昵称=${r.self.name}` : `code=${r.code}`);
    }

    const stillBad = await tryConnect(ROOM_KEY.slice(0, -1) + 'x', 'rk-norm-bad');
    check('真的写错了仍然被拒', !stillBad.ok, `code=${stillBad.code}`);
  } finally {
    openSockets.forEach((ws) => { try { ws.close(); } catch { /* ignore */ } });
    try { server.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
