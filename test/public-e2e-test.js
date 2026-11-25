'use strict';

/**
 * 公网双客户端端到端测试
 *
 * 通过公网 wss 地址模拟两个不同浏览器（不同 cid）互发消息，验证：
 *   1. 两人都能连上并拿到各自独立身份
 *   2. 消息能双向广播
 *   3. 每个人收到的消息里，发送者 id 与自己的不同（→ 前端会渲染到左边）
 *   4. 同一 cid 重连后身份不变
 *   5. 没有房间口令的人进不来（内测期间房间是私有的）
 *
 * 用法：node test/public-e2e-test.js [wss地址]
 *   不给地址时自动从 tunnel.log 里读当前隧道地址。
 *
 * ⚠️ 这个测试打的是**线上服务**，跑完必须把自己产生的数据清掉 ——
 *    否则会在成员列表和历史消息里留下「幽灵成员」。
 *    所以下面所有用户 id 都会被记录，结束时统一删除。
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

/* ---------------- 地址与口令 ---------------- */

/** 从 tunnel.log 里读当前隧道地址（只取域名部分） */
function readTunnelUrl() {
  try {
    const text = fs.readFileSync(path.join(ROOT, 'tunnel.log'), 'utf8');
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) return m[0];
  } catch { /* 没有 tunnel.log */ }
  return '';
}

/**
 * 统一成 WebSocket 地址，必须以 /ws 结尾。
 *
 * 少了 /ws 的话，升级请求会打到 / 上 —— 服务端按设计拒绝，
 * 隧道那边就变成 502，看起来像是隧道坏了，其实是地址拼错了。
 */
function normalizeWsUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) s = s.replace(/^https?:/i, 'wss:');
  if (!/^wss?:\/\//i.test(s)) s = 'wss://' + s.replace(/^\/+/, '');
  s = s.replace(/\/+$/, '');
  if (!/\/ws$/.test(s)) s += '/ws';
  return s;
}

const WSS = normalizeWsUrl(process.argv[2] || readTunnelUrl() || 'http://localhost:8000');

/** 房间口令：和线上服务用的是同一个文件 */
function readRoomKey() {
  if (process.env.ROOM_KEY !== undefined) return String(process.env.ROOM_KEY).trim();
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'room.key'), 'utf8').trim();
  } catch {
    return '';
  }
}

const ROOM_KEY = readRoomKey();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/** 测试期间产生过的用户 id —— 结束时统一从库里删掉 */
const createdUserIds = new Set();

function connect(cid, key = ROOM_KEY) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams();
    if (cid) q.set('cid', cid);
    if (key) q.set('key', key);
    const ws = new WebSocket(`${WSS}?${q.toString()}`);
    const events = [];
    let rejected = false;

    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      events.push(d);
      if (d.t === 'init') {
        createdUserIds.add(d.self.id);
        resolve({ ws, self: d.self, events });
      } else if (d.t === 'error') {
        // 服务端主动拒绝（比如口令不对）—— 记下来，别和网络错误混为一谈
        rejected = true;
        const err = new Error(`${d.code || 'error'}: ${d.msg || ''}`);
        err.serverRejected = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(err);
      }
    });
    ws.on('error', (err) => {
      if (!rejected) reject(err);
    });
    setTimeout(() => reject(new Error('连接超时')), 25000);
  });
}

/**
 * 等待某类事件出现（不 resolve = 一直没等到）。
 *
 * 走公网隧道时往返延迟比本地大得多，固定 sleep 容易踩到边界，
 * 所以改成「轮询到满足条件为止」，最多等 timeout 毫秒。
 */
async function waitFor(events, pred, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

/* ---------------- 清理 ---------------- */

/**
 * 把测试产生的消息和用户从库里删掉。
 *
 * 测试跑在线上服务上，不清理的话成员列表里会多出一堆「测试用户」，
 * 历史消息里也会多出「来自 A 的公网测试消息」。
 */
function cleanup() {
  if (!createdUserIds.size) return;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(ROOT, 'data', 'chat.db'));
    const ids = [...createdUserIds];
    const marks = ids.map(() => '?').join(',');
    const msgs = db.prepare(`DELETE FROM messages WHERE sender_id IN (${marks})`).run(...ids).changes;
    const users = db.prepare(`DELETE FROM users WHERE id IN (${marks})`).run(...ids).changes;
    db.close();
    console.log(`\n[cleanup] 已清除测试数据：${msgs} 条消息 / ${users} 个用户`);
  } catch (err) {
    console.log(`\n[cleanup] 清除测试数据失败：${err.message}`);
  }
}

/* ---------------- 主流程 ---------------- */

(async () => {
  console.log(`\n=== 公网端到端测试 ===\n目标: ${WSS}\n房间口令: ${ROOM_KEY ? '已带上' : '（未设置，公开房间）'}\n`);

  console.log('[0] 没有口令的人进不来');
  if (ROOM_KEY) {
    // 区分「服务端明确拒绝（bad_key）」和「隧道抖动（网络错误）」——
    // 后者重试几次，避免把偶发故障当成口令功能坏了。
    let badKey = false;
    let lastErr = '';
    for (let attempt = 0; attempt < 3 && !badKey; attempt++) {
      try {
        const bad = await connect('e2e-nokey-' + Date.now(), 'wrong-key-0000');
        bad.ws.close();
        lastErr = '连接居然成功了';
      } catch (err) {
        lastErr = String(err.message || err);
        // 服务端会先发 {t:'error', code:'bad_key'} 再关连接
        if (/bad_key|口令/i.test(lastErr)) badKey = true;
        else await sleep(2000);   // 像是网络抖动，等会儿再试
      }
    }
    check('错误口令被服务端拒绝', badKey, lastErr);
  } else {
    console.log('  · 未设置房间口令，跳过这一项');
  }

  console.log('\n[1] 两个不同浏览器建立连接');
  const cidA = 'e2e-A-' + Date.now();
  const cidB = 'e2e-B-' + Date.now();
  const A = await connect(cidA);
  const B = await connect(cidB);
  check('A 连接成功', !!A.self, `昵称=${A.self.name} id=${A.self.id.slice(0, 8)}`);
  check('B 连接成功', !!B.self, `昵称=${B.self.name} id=${B.self.id.slice(0, 8)}`);
  check('A 与 B 是不同的人', A.self.id !== B.self.id);
  check('A 与 B 昵称不同', A.self.name !== B.self.name);
  check('A 与 B 头像色不同', A.self.color !== B.self.color,
    `${A.self.color} vs ${B.self.color}`);

  console.log('\n[2] A 发消息，B 应收到');
  const text = '来自 A 的公网测试消息';
  A.ws.send(JSON.stringify({ t: 'msg', text }));
  const bGot = await waitFor(B.events, (e) => e.t === 'msg' && e.msg.text === text);
  check('B 收到 A 的消息', !!bGot);
  check('消息的发送者是 A', bGot && bGot.msg.from.id === A.self.id,
    bGot ? `from.id=${bGot.msg.from.id.slice(0, 8)} (A=${A.self.id.slice(0, 8)})` : '');
  check('对 B 而言这是他人消息(应渲染在左)', bGot && bGot.msg.from.id !== B.self.id);

  console.log('\n[3] B 发消息，A 应收到');
  const text2 = '来自 B 的公网测试消息';
  B.ws.send(JSON.stringify({ t: 'msg', text: text2 }));
  const aGot = await waitFor(A.events, (e) => e.t === 'msg' && e.msg.text === text2);
  check('A 收到 B 的消息', !!aGot);
  check('消息的发送者是 B', aGot && aGot.msg.from.id === B.self.id);
  check('对 A 而言这是他人消息(应渲染在左)', aGot && aGot.msg.from.id !== A.self.id);

  console.log('\n[4] 自己发的消息回显给自己(应渲染在右)');
  const aSelf = await waitFor(A.events, (e) => e.t === 'msg' && e.msg.text === text);
  check('A 也收到自己发的消息', !!aSelf);
  check('A 看到自己的消息 from.id === 自己', aSelf && aSelf.msg.from.id === A.self.id);

  console.log('\n[5] 同一 cid 重连 → 身份保持');
  A.ws.close();
  await sleep(1200);
  const A2 = await connect(cidA);
  check('重连后 id 不变', A2.self.id === A.self.id, `${A.self.id.slice(0, 8)}`);
  check('重连后昵称不变', A2.self.name === A.self.name, A2.self.name);

  A2.ws.close();
  B.ws.close();
  await sleep(300);

  console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===\n`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试异常：', e.message);
  cleanup();
  process.exit(1);
});
