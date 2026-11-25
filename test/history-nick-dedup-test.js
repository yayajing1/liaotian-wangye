'use strict';

/**
 * 历史昵称去重测试
 *
 * 需求：「连历史昵称一起去重」
 *
 * 老逻辑只在「在线成员」之间去重 —— 人一离线昵称就被释放，
 * 于是历史消息里会同时出现两个同名的人，根本分不清谁是谁。
 *
 * 新逻辑：昵称占用权登记在 users 表上，离线不释放，
 *         占用期与消息保留期（7 天）自然对齐。
 *
 * 验证的 6 件事：
 *   1. A 发过言后离线 → B 上线拿到的昵称 ≠ A 的昵称
 *   2. B 想改成 A 的昵称 → 自动加数字后缀
 *   3. 历史消息里 A 仍显示原昵称，与 B 的昵称可区分
 *   4. A 用同一浏览器刷新 → 昵称不变，且与 B 不撞
 *   5. 全场昵称两两不同（在线 + 历史一起算）
 *   6. 消息过期 → 用户行被清理 → 昵称释放，可被重新使用
 *
 * 用法：node test/history-nick-dedup-test.js
 *
 * 本测试会单独起一个服务端实例（独立端口 + 独立数据目录，
 * 保留期缩到 2.5 秒），不会碰到线上数据。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8801;
const DATA_DIR = path.join(ROOT, 'data', 'test-history-nick');
const DB_FILE = path.join(DATA_DIR, 'chat.db');
const RETENTION_MS = 2500;
const CLEANUP_INTERVAL_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? '  → ' + detail : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* 测试客户端                                                          */
/* ------------------------------------------------------------------ */

function connect(cid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?cid=${encodeURIComponent(cid)}`);
    const inbox = [];
    const waiters = [];

    const client = {
      ws,
      self: null,
      history: [],
      inbox,
      send(o) { ws.send(JSON.stringify(o)); },
      // 等待下一条满足条件的消息
      next(pred, ms = 4000) {
        const idx = inbox.findIndex(pred);
        if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred, res, rej };
          waiters.push(w);
          const timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) { waiters.splice(i, 1); rej(new Error('等待消息超时')); }
          }, ms);
          w.timer = timer;
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    };

    const timer = setTimeout(() => reject(new Error('连接超时')), 10000);

    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.t === 'init') {
        clearTimeout(timer);
        client.self = d.self;
        client.history = d.history || [];
        resolve(client);
        return;
      }
      inbox.push(d);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(d)) {
          clearTimeout(waiters[i].timer);
          waiters[i].res(d);
          waiters.splice(i, 1);
        }
      }
    });

    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 读数据库（测试用，只读不写） */
function readDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_FILE);
  try {
    return {
      users: db.prepare('SELECT id, name FROM users').all(),
      messages: db.prepare('SELECT id, sender_id FROM messages').all(),
      dupNames: db.prepare('SELECT name, COUNT(*) c FROM users GROUP BY name HAVING c > 1').all(),
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 启动测试服务端                                                       */
/* ------------------------------------------------------------------ */

let server = null;

function startServer() {
  return new Promise((resolve, reject) => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        ALT_PORT: '0',
        DATA_DIR,
        ROOM_KEY: '',
        RETENTION_MS: String(RETENTION_MS),
        CLEANUP_INTERVAL_MS: String(CLEANUP_INTERVAL_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const onData = (buf) => {
      out += buf.toString();
      if (out.includes('聊天室已启动')) { server.stdout.off('data', onData); resolve(); }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', (b) => { out += b.toString(); });
    server.on('exit', (code) => {
      if (!out.includes('聊天室已启动')) reject(new Error('服务端启动失败:\n' + out));
    });
    setTimeout(() => { if (!out.includes('聊天室已启动')) reject(new Error('服务端启动超时')); }, 15000);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => resolve());
    server.kill();
    setTimeout(resolve, 3000);
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('\n\x1b[36m=== 历史昵称去重测试 ===\x1b[0m');
  console.log(`测试服务端: ws://localhost:${PORT}`);
  console.log(`数据目录  : ${DATA_DIR}`);
  console.log(`保留期    : ${RETENTION_MS}ms（加速验证「过期释放」）\n`);

  await startServer();

  const stamp = Date.now();
  const clients = [];

  try {
    /* ---------- 1. A 上线、发一条消息、然后离线 ---------- */
    console.log('\x1b[36m[1] A 发过言后离线\x1b[0m');
    const A = await connect(`hist-A-${stamp}`);
    clients.push(A);
    const aName = A.self.name;
    const aId = A.self.id;
    console.log(`  A 的昵称: ${aName}`);

    A.send({ t: 'msg', text: '我是第一个说话的人' });
    await A.next((d) => d.t === 'msg' && d.msg.text === '我是第一个说话的人');
    console.log('  A 发言成功（这条消息会留在历史里）');

    A.close();
    await sleep(400);
    const afterOffline = readDb();
    const aStillThere = afterOffline.users.find((u) => u.id === aId);
    check('A 离线后用户行仍在（昵称继续被占用）', !!aStillThere,
      `users 里找不到 ${aId}`);

    /* ---------- 2. B 上线，不能拿到 A 的昵称 ---------- */
    console.log('\n\x1b[36m[2] B 上线 —— 昵称不能和 A 撞\x1b[0m');
    const B = await connect(`hist-B-${stamp}`);
    clients.push(B);
    const bName = B.self.name;
    console.log(`  B 的昵称: ${bName}`);
    check('B 拿到的昵称 ≠ A 的昵称（历史去重生效）', bName !== aName,
      `A=${aName}  B=${bName}`);

    /* ---------- 3. B 主动改成 A 的昵称 → 自动加后缀 ---------- */
    console.log('\n\x1b[36m[3] B 想改名叫「' + aName + '」\x1b[0m');
    B.send({ t: 'nick', name: aName });
    const nickEvt = await B.next((d) => d.t === 'nick');
    const bNewName = nickEvt.user.name;
    console.log(`  服务端改名结果: ${bNewName}`);
    check('B 的新昵称 ≠ A 的昵称', bNewName !== aName, `B=${bNewName}`);
    check('B 的新昵称是「原名 + 数字后缀」', bNewName.startsWith(aName) && bNewName !== aName,
      `期望形如 ${aName}2，实际 ${bNewName}`);

    /* ---------- 4. 新人看到的历史里，A 仍是原昵称 ---------- */
    console.log('\n\x1b[36m[4] 新人看到的历史消息\x1b[0m');
    const C = await connect(`hist-C-${stamp}`);
    clients.push(C);
    const hist = C.history;
    const fromA = hist.filter((m) => m.from.id === aId);
    check('历史里能看到 A 发的消息', fromA.length === 1, `找到 ${fromA.length} 条`);
    check('历史里 A 显示的仍是原昵称', fromA.length === 1 && fromA[0].from.name === aName,
      fromA.length ? `显示为 ${fromA[0].from.name}` : '没找到消息');

    const histNames = new Set(hist.map((m) => m.from.name));
    check('历史消息里的昵称没有重复', histNames.size === hist.length,
      `历史 ${hist.length} 条消息里有 ${hist.length - histNames.size} 处重名`);

    /* ---------- 5. A 刷新页面，昵称不变，且和 B 不撞 ---------- */
    console.log('\n\x1b[36m[5] A 刷新页面（同一浏览器）\x1b[0m');
    const A2 = await connect(`hist-A-${stamp}`);
    clients.push(A2);
    console.log(`  刷新后昵称: ${A2.self.name}`);
    check('刷新后昵称不变', A2.self.name === aName, `期望 ${aName}，实际 ${A2.self.name}`);
    check('刷新后与 B 的昵称不撞', A2.self.name !== bNewName, `A=${A2.self.name}  B=${bNewName}`);

    /* ---------- 6. 全场昵称两两不同 ---------- */
    console.log('\n\x1b[36m[6] 全场昵称唯一性（在线 + 历史一起算）\x1b[0m');
    // A2 是 A 刷新后的同一个人（同一个 id），不能算成两个人
    const liveById = new Map();
    for (const c of [A, B, C, A2]) liveById.set(c.self.id, c.self);
    const allNames = [...liveById.values()].map((u) => u.name);
    const dbNames = readDb().users.map((u) => u.name);
    const uniqDb = new Set(dbNames);
    console.log(`  在线昵称: ${allNames.join(', ')}`);
    console.log(`  数据库昵称: ${dbNames.join(', ')}`);
    check('数据库里没有重名', uniqDb.size === dbNames.length,
      readDb().dupNames.map((d) => `${d.name}×${d.c}`).join(', '));
    check('在线成员昵称两两不同', new Set(allNames).size === allNames.length,
      allNames.join(', '));

    /* ---------- 7. 消息过期后昵称释放 ---------- */
    console.log('\n\x1b[36m[7] 消息过期 → 用户行清理 → 昵称释放\x1b[0m');
    console.log(`  等待 ${RETENTION_MS + CLEANUP_INTERVAL_MS * 2}ms 让保留期走完…`);
    await sleep(RETENTION_MS + CLEANUP_INTERVAL_MS * 3);

    const afterExpire = readDb();
    check('过期消息已清理', afterExpire.messages.length === 0,
      `还剩 ${afterExpire.messages.length} 条`);
    check('A 的用户行已被清理（昵称释放）', !afterExpire.users.find((u) => u.id === aId),
      'A 的行还在，昵称还被占着');
    check('数据库里已没有人占用「' + aName + '」',
      !afterExpire.users.find((u) => u.name === aName),
      `仍有 ${afterExpire.users.filter((u) => u.name === aName).length} 人占用`);

    // 释放之后，新人是可以拿到这个名字的
    const D = await connect(`hist-D-${stamp}`);
    clients.push(D);
    console.log(`  新人 D 拿到的昵称: ${D.self.name}`);
    check('新人可以正常上线（无残留状态卡死）', !!D.self.name);

    clients.forEach((c) => c.close());
    await sleep(200);
  } catch (err) {
    failed++;
    console.log(`\n\x1b[31m异常中断: ${err.message}\x1b[0m`);
    console.log(err.stack);
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log('\n\x1b[36m--- 结论 ---\x1b[0m');
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  console.log(failed === 0
    ? '  \x1b[32m✓ 历史昵称去重全部通过\x1b[0m'
    : '  \x1b[31m✗ 存在失败项\x1b[0m');
  console.log('');

  process.exit(failed === 0 ? 0 : 1);
})();
