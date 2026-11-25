/**
 * 多人聊天室端到端自测脚本
 *
 * 用法：node test/multi-client-test.js
 *
 * 本测试会自己起一个服务端实例（独立端口 + 独立数据目录），
 * 不需要先手动启动 node server.js，也不会把测试产生的
 * 用户行写进线上数据库（昵称全局唯一，占满了名字池会很难看）。
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8804;
const DATA_DIR = path.join(ROOT, 'data', 'test-multi-client');
const URL = `ws://localhost:${TEST_PORT}/ws`;
const results = [];

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

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   → ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = {
      label, ws, self: null, users: [], history: [],
      received: [], events: [],
    };
    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      c.events.push(d);
      if (d.t === 'init') {
        c.self = d.self;
        c.users = d.users;
        c.history = d.history;
        resolve(c);
      } else if (d.t === 'msg') {
        c.received.push(d.msg);
      }
    });
    ws.on('error', reject);
    ws.on('open', () => { /* init 到达后再 resolve */ });
  });
}

const send = (c, obj) => c.ws.send(JSON.stringify(obj));

/** 在线成员 = init 快照 + 之后的 join/leave 事件累计 */
function onlineSet(c) {
  const set = new Map(c.users.map((u) => [u.id, u]));
  for (const e of c.events) {
    if (e.t === 'join') set.set(e.user.id, e.user);
    if (e.t === 'leave') set.delete(e.user.id);
  }
  return set;
}

async function main() {
  console.log('\n=== 多人聊天室端到端自测 ===\n');
  await startServer();
  console.log(`  测试服务端: ${URL}（独立数据目录，不碰线上数据）\n`);

  /* ---------- 1. 三人同时在线 ---------- */
  console.log('[1] 三人同时连接');
  const A = await connect('A');
  const B = await connect('B');
  const C = await connect('C');
  await sleep(250);

  check('A 收到 init 且拿到自己的身份', !!A.self && !!A.self.name, `A 的昵称=${A.self && A.self.name}`);

  const onlineA = onlineSet(A);
  const onlineB = onlineSet(B);
  const onlineC = onlineSet(C);

  // 不假设"房间里只有 3 人"（预览面板、真实浏览器都可能连着），
  // 只断言这三个测试客户端彼此可见。
  const trio = [A, B, C];
  const trioIds = new Set(trio.map((c) => c.self.id));
  for (const c of trio) {
    const seen = onlineSet(c);
    const visible = [...trioIds].filter((id) => seen.has(id)).length;
    check(`${c.label} 能看到其他 2 个测试客户端`, visible === 3, `实际可见 ${visible}/3`);
  }

  const names = new Set(trio.map((c) => c.self.name));
  check('三人昵称互不重复', names.size === 3, [...names].join(', '));

  const colors = new Set(trio.map((c) => c.self.color));
  check('三人头像色互不重复', colors.size === 3, [...colors].join(', '));

  /* ---------- 2. 消息广播 ---------- */
  console.log('\n[2] 消息广播');
  send(A, { t: 'msg', text: '大家好，我是 A' });
  await sleep(300);

  check('B 收到 A 的消息', B.received.length === 1, B.received[0] && B.received[0].text);
  check('C 收到 A 的消息', C.received.length === 1, C.received[0] && C.received[0].text);
  check('发送者昵称正确', C.received[0] && C.received[0].from.name === A.self.name);
  check('消息带时间戳', C.received[0] && typeof C.received[0].ts === 'number');

  /* ---------- 3. 改昵称 ---------- */
  console.log('\n[3] 改昵称');
  send(B, { t: 'nick', name: '阿宝' });
  await sleep(300);

  const nickEvt = A.events.find((e) => e.t === 'nick');
  // 「阿宝」可能已经被历史里的老用户占着（昵称全局唯一，含历史），
  // 这时服务端会自动加数字后缀（如 阿宝2）—— 所以这里断言的是
  // 「以 阿宝 开头且不等于原昵称」，而不是死等一个精确值。
  const renamed = nickEvt && nickEvt.user.name;
  check('他人收到 nick 广播', !!nickEvt);
  check('改名后昵称以「阿宝」开头（冲突时自动加后缀）',
    !!renamed && renamed.startsWith('阿宝') && renamed !== '阿宝' ? true : renamed === '阿宝',
    `实际=${renamed}`);

  /* ---------- 4. 改名后旧消息显示新名 ---------- */
  console.log('\n[4] 改名后历史消息显示新昵称');
  send(B, { t: 'msg', text: '我是阿宝' });
  await sleep(300);

  const D = await connect('D');   // 模拟刷新页面/新加入者
  await sleep(300);

  // 按发送者 id 精确匹配，避免撞上历史遗留的同名用户
  const bId = B.self.id;
  const bMsgs = D.history.filter((m) => m.from.id === bId);
  const bNames = [...new Set(bMsgs.map((m) => m.from.name))];

  check('B 的历史消息存在', bMsgs.length >= 1, `命中 ${bMsgs.length} 条`);
  check('B 的历史消息全部显示新昵称', bMsgs.length >= 1 && bNames.every((n) => n === renamed),
    `实际昵称=${bNames.join(',')} 期望=${renamed}`);
  check('B 的旧昵称已不再出现', !bNames.includes(B.self.name), `旧昵称=${B.self.name}`);

  /* ---------- 5. 撤回 ---------- */
  console.log('\n[5] 撤回功能');
  send(A, { t: 'msg', text: '这条会被撤回' });
  await sleep(300);

  const recalled = C.received.find((m) => m.text === '这条会被撤回');
  check('撤回前消息正常送达', !!recalled);

  send(A, { t: 'recall', id: recalled.id });
  await sleep(300);

  const recallEvt = B.events.find((e) => e.t === 'recall');
  check('他人收到撤回广播', !!recallEvt && recallEvt.id === recalled.id);

  /* ---------- 6. 撤回权限 ---------- */
  console.log('\n[6] 撤回权限校验');
  // 用一条全新的消息，避免复用上面已被撤回的
  send(A, { t: 'msg', text: '这条 B 撤不掉' });
  await sleep(300);
  const target2 = C.received.find((m) => m.text === '这条 B 撤不掉');
  check('新消息正常送达', !!target2);

  const recallBefore = B.events.filter((e) => e.t === 'recall').length;
  send(B, { t: 'recall', id: target2.id });   // B 试图撤回 A 的消息
  await sleep(300);
  const recallAfter = B.events.filter((e) => e.t === 'recall').length;
  check('不能撤回他人消息', recallAfter === recallBefore,
    `撤回事件数 ${recallBefore} → ${recallAfter}`);

  // 换个连接验证消息确实没被撤掉
  const G = await connect('G');
  await sleep(300);
  const stillThere = G.history.find((m) => m.id === target2.id);
  check('他人撤回未生效，消息内容仍在',
    !!stillThere && stillThere.kind === 'text' && stillThere.text === '这条 B 撤不掉',
    `kind=${stillThere && stillThere.kind}, text=${stillThere && stillThere.text}`);
  G.ws.close();

  /* ---------- 7. 离线者也能看到撤回结果 ---------- */
  console.log('\n[7] 撤回后的持久化状态');
  const E = await connect('E');
  await sleep(300);
  const recalledInHistory = E.history.find((m) => m.id === recalled.id);
  check('撤回状态已落库', !!recalledInHistory && recalledInHistory.kind === 'recalled',
    `kind=${recalledInHistory && recalledInHistory.kind}`);
  check('撤回后正文已清空', recalledInHistory && recalledInHistory.text === '');

  /* ---------- 8. 输入中提示 ---------- */
  console.log('\n[8] 输入中提示');
  send(C, { t: 'typing' });
  await sleep(250);
  const typingEvt = A.events.find((e) => e.t === 'typing');
  check('他人收到 typing 事件', !!typingEvt && typingEvt.user.name === C.self.name);

  /* ---------- 9. 消息持久化 ---------- */
  console.log('\n[9] 消息持久化');
  const F = await connect('F');
  await sleep(300);
  check('历史消息随新连接下发', F.history.length >= 3, `历史条数=${F.history.length}`);
  check('历史里能看到最初那条',
    F.history.some((m) => m.text === '大家好，我是 A'));

  /* ---------- 10. 引用回复 ---------- */
  console.log('\n[10] 引用回复');
  const target = F.history.find((m) => m.text === '大家好，我是 A');
  send(C, { t: 'msg', text: '引用一下', replyTo: target.id });
  await sleep(300);
  const quoted = A.received.find((m) => m.text === '引用一下');
  check('引用关系随消息下发', !!quoted && quoted.replyTo === target.id,
    `replyTo=${quoted && quoted.replyTo}`);

  /* ---------- 收尾 ---------- */
  [A, B, C, D, E, F].forEach((c) => { try { c.ws.close(); } catch { /* ignore */ } });
  await sleep(200);
  stopServer();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log('全部通过 ✓\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  stopServer();
  process.exit(1);
});
