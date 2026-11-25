'use strict';

/**
 * 个人登录密码（登入设置）测试
 *
 * 覆盖：
 *   1. 设密码 → 服务端存的是哈希，不是明文
 *   2. 密码太短被拒
 *   3. loginInfo 返回「我设了没 / 房间里有人设了没」
 *   4. 密码错 → 登录失败（且不给「昵称对不对」这种提示）
 *   5. 昵称+密码对 → 身份换回来（id / 名字 / 头像都一样）
 *   6. 换回来之后，历史消息里「我」发的会变成自己的
 *   7. 临时身份（没发过消息的）被清掉，昵称释放
 *   8. 换回身份后，本机刷新直接就是「我」（不用再输密码）
 *   9. 改密码：原密码错 → 失败；对 → 成功；之后只能用新密码
 *  10. 移除密码 → 之后不能再用密码登录
 *  11. 同一个身份在别处开着 → 那边被顶掉
 *
 * 用法：node test/login-password-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8815;
const DATA_DIR = path.join(ROOT, 'data', 'test-login-pw');
const DB_FILE = path.join(DATA_DIR, 'chat.db');
const ROOM_KEY = 'login-pw-test-key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

class Client {
  constructor(cid) {
    this.cid = cid;
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
        const idx = this.waiters.findIndex((w) => w.type === d.t);
        if (idx >= 0) {
          this.waiters.splice(idx, 1)[0].resolve(d);
        } else {
          this.inbox.push(d);
        }
        if (d.t === 'init') {
          this.self = d.self;
          this.init = d;
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
  const users = db.prepare('SELECT id, name, color, avatar, client_id, login_hash, login_salt FROM users').all();
  const msgs = db.prepare('SELECT id, sender_id, text FROM messages').all();
  let devices = [];
  try {
    devices = db.prepare('SELECT client_id, user_id FROM user_devices').all();
  } catch { /* 表还没建 */ }
  db.close();
  return { users, msgs, devices };
}

(async () => {
  console.log('\n=== 个人登录密码测试 ===\n');

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

  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (out.includes('聊天室已启动')) { up = true; break; }
  }
  if (!up) { console.log('服务端没起来：\n' + out); process.exit(1); }

  const clients = [];

  try {
    /* ---------------- [1] 设密码 ---------------- */
    console.log('[1] 设置登录密码');
    const a = new Client('lp-a');
    await a.connect();
    clients.push(a);

    check('init 里说「我还没设密码」', a.init.loginSet === false, `loginSet=${a.init.loginSet}`);
    check('init 里说「房间里没人设密码」', a.init.hasLogin === false, `hasLogin=${a.init.hasLogin}`);

    // 密码太短
    a.send({ t: 'loginSet', pw: 'ab' });
    const tooShort = await a.wait('loginAck');
    check('太短的密码被拒', tooShort.ok === false, tooShort.msg);

    a.send({ t: 'loginSet', pw: 'mypw1234' });
    const ack = await a.wait('loginAck');
    check('密码设好了', ack.ok === true, ack.msg);
    check('回执带上了 set:true', ack.set === true, `set=${ack.set}`);

    // 数据库里存的是哈希，不是明文
    const db1 = readDb();
    const rowA = db1.users.find((u) => u.id === a.self.id);
    check('数据库里有密码字段', !!(rowA && rowA.login_hash), rowA ? '有' : '没有');
    check('存的不是明文', rowA && rowA.login_hash !== 'mypw1234', rowA ? String(rowA.login_hash).slice(0, 16) : '');
    check('有随机盐', !!(rowA && rowA.login_salt && rowA.login_salt.length >= 16), rowA ? String(rowA.login_salt).slice(0, 16) : '');

    /* ---------------- [2] loginInfo ---------------- */
    console.log('\n[2] 查询密码状态');
    a.send({ t: 'loginInfo' });
    const info = await a.wait('loginInfo');
    check('显示「我已经设了」', info.set === true, `set=${info.set}`);
    check('显示「房间里有人设了」', info.hasAny === true, `hasAny=${info.hasAny}`);

    /* ---------------- [3] 错误密码不能登录 ---------------- */
    console.log('\n[3] 密码不对 → 登录失败');
    const b = new Client('lp-b');
    await b.connect();
    clients.push(b);
    const bTempName = b.self.name;
    check('新设备拿到的是临时昵称', !!bTempName, bTempName);
    check('新设备不是同一个身份', b.self.id !== a.self.id);

    b.send({ t: 'loginClaim', name: a.self.name, pw: 'wrongpw' });
    const bad = await b.wait('loginAck');
    check('密码错 → 被拒', bad.ok === false, bad.msg);
    check('提示不区分「昵称错」还是「密码错」', /昵称或密码不对/.test(bad.msg || ''), bad.msg);

    /* ---------------- [4] 昵称+密码对 → 身份换回来 ---------------- */
    console.log('\n[4] 昵称 + 密码 → 身份换回来');
    // 先让 A 发一条消息，用来验证「历史归我」
    a.send({ t: 'msg', text: '这是 A 发的消息' });
    await sleep(300);

    a.drain();
    b.send({ t: 'loginClaim', name: a.self.name, pw: 'mypw1234' });
    const ok = await b.wait('loginOk');
    check('登录成功', !!ok.user, JSON.stringify(ok.user || {}));
    check('id 换回来了', ok.user && ok.user.id === a.self.id, `${ok.user && ok.user.id}`);
    check('名字没变', ok.user && ok.user.name === a.self.name, ok.user && ok.user.name);
    check('头像没变', ok.user && ok.user.avatar === a.self.avatar, ok.user && ok.user.avatar);

    // A 那边应该收到 identity 广播
    const ident = await a.wait('identity');
    check('A 收到了身份变更广播', !!ident.user, JSON.stringify(ident.user || {}));
    check('广播里带上了临时身份', !!(ident.prev && ident.prev.id), ident.prev && ident.prev.name);

    // 换回来的历史里，A 那条消息应该归 B（自己）
    const mine = (ok.history || []).filter((m) => m.text === '这是 A 发的消息');
    check('历史里有 A 那条消息', mine.length === 1, `${mine.length} 条`);
    check('那条消息的发送者就是换回来的身份',
      mine.length === 1 && mine[0].from.id === a.self.id,
      mine.length ? mine[0].from.name : '');

    /* ---------------- [5] 临时身份被清掉 ---------------- */
    console.log('\n[5] 临时身份清理');
    const db2 = readDb();
    const tempRow = db2.users.find((u) => u.name === bTempName);
    check('临时昵称那一行被删了', !tempRow, bTempName);
    check('原来的身份还在', !!db2.users.find((u) => u.id === a.self.id));
    const devB = db2.devices.find((d) => d.client_id === 'lp-b');
    check('这台设备绑到了原身份上', devB && devB.user_id === a.self.id,
      devB ? devB.user_id : '(没有)');
    const devA = db2.devices.find((d) => d.client_id === 'lp-a');
    check('原来那台设备的绑定没丢', devA && devA.user_id === a.self.id,
      devA ? devA.user_id : '(没有)');

    /* ---------------- [6] 刷新直接是「我」 ---------------- */
    console.log('\n[6] 换回来之后刷新 → 不用再输密码');
    b.close();                       // 模拟刷新：旧连接先断
    await sleep(300);
    const b2 = new Client('lp-b');
    await b2.connect();
    clients.push(b2);
    check('刷新后还是同一个身份', b2.self.id === a.self.id, `${b2.self.id}`);
    check('刷新后名字不变', b2.self.name === a.self.name, b2.self.name);

    /* ---------------- [7] 改密码 ---------------- */
    console.log('\n[7] 修改密码');
    b2.send({ t: 'loginChange', oldPw: 'nope', newPw: 'newpw5678' });
    const badChange = await b2.wait('loginAck');
    check('原密码错 → 拒绝', badChange.ok === false, badChange.msg);

    b2.send({ t: 'loginChange', oldPw: 'mypw1234', newPw: 'newpw5678' });
    const goodChange = await b2.wait('loginAck');
    check('改密码成功', goodChange.ok === true, goodChange.msg);

    const c = new Client('lp-c');
    await c.connect();
    clients.push(c);
    c.send({ t: 'loginClaim', name: a.self.name, pw: 'mypw1234' });
    const oldPwTry = await c.wait('loginAck');
    check('旧密码已经不能用了', oldPwTry.ok === false, oldPwTry.msg);

    c.send({ t: 'loginClaim', name: a.self.name, pw: 'newpw5678' });
    const newPwTry = await c.wait('loginOk');
    check('新密码能登录', !!newPwTry.user, JSON.stringify(newPwTry.user || {}));
    check('换回来的是同一个身份', newPwTry.user && newPwTry.user.id === a.self.id);
    c.close();

    /* ---------------- [8] 移除密码 ---------------- */
    console.log('\n[8] 移除密码');
    b2.send({ t: 'loginRemove', pw: 'wrong' });
    const badDel = await b2.wait('loginAck');
    check('密码不对 → 拒绝', badDel.ok === false, badDel.msg);

    b2.send({ t: 'loginRemove', pw: 'newpw5678' });
    const del = await b2.wait('loginAck');
    check('移除成功', del.ok === true, del.msg);
    check('回执里 set 变成 false', del.set === false, `set=${del.set}`);

    const d = new Client('lp-d');
    await d.connect();
    clients.push(d);
    d.send({ t: 'loginClaim', name: a.self.name, pw: 'newpw5678' });
    const afterDel = await d.wait('loginAck');
    check('移除后不能再用密码登录', afterDel.ok === false, afterDel.msg);
    d.close();

    /* ---------------- [9] 同一账号可以在好几台设备上 ---------------- */
    console.log('\n[9] 同一账号在两台设备上 → 都在线，关掉一个另一个还在');
    const e1 = new Client('lp-e1');
    await e1.connect();
    clients.push(e1);
    e1.send({ t: 'loginSet', pw: 'epw12345' });
    await e1.wait('loginAck');
    const eName = e1.self.name;

    const e2 = new Client('lp-e2');
    await e2.connect();
    clients.push(e2);
    e2.send({ t: 'loginClaim', name: eName, pw: 'epw12345' });
    const e2ok = await e2.wait('loginOk');
    check('第二个设备登录成功', !!e2ok.user, JSON.stringify(e2ok.user || {}));
    check('是同一个身份', e2ok.user && e2ok.user.id === e1.self.id);
    check('第一个设备没被踢下线', e1.ws.readyState === WebSocket.OPEN,
      `readyState=${e1.ws.readyState}`);

    const dbDev = readDb();
    const devs = dbDev.devices.filter((d) => d.user_id === e1.self.id).map((d) => d.client_id).sort();
    check('两台设备都绑在这个账号上', devs.length === 2 && devs[0] === 'lp-e1' && devs[1] === 'lp-e2',
      devs.join(','));

    // 关掉其中一个，另一个还在线 → 不应该广播「离开了」
    e1.drain();
    e2.drain();
    e1.close();
    await sleep(500);
    const e2left = e2.inbox.filter((m) => m.t === 'leave');
    check('关掉一个设备，另一个不算「离开」', e2left.length === 0, `${e2left.length} 条 leave`);

    // 反过来：最后一个设备关了，才广播离开
    const e3 = new Client('lp-e3');
    await e3.connect();
    clients.push(e3);
    e3.drain();
    e2.close();
    await sleep(500);
    const e3left = e3.inbox.filter((m) => m.t === 'leave');
    check('最后一个设备关了才广播离开', e3left.length >= 1, `${e3left.length} 条 leave`);

    /* ---------------- [10] 空密码不能登录 ---------------- */
    console.log('\n[10] 边界情况');
    const f = new Client('lp-f');
    await f.connect();
    clients.push(f);
    f.send({ t: 'loginClaim', name: '', pw: 'x' });
    const emptyName = await f.wait('loginAck');
    check('昵称为空 → 拒绝', emptyName.ok === false, emptyName.msg);

    f.send({ t: 'loginClaim', name: eName, pw: '' });
    const emptyPw = await f.wait('loginAck');
    check('密码为空 → 拒绝', emptyPw.ok === false, emptyPw.msg);

    f.send({ t: 'loginClaim', name: '根本没这个人', pw: 'whatever' });
    const noUser = await f.wait('loginAck');
    check('昵称不存在 → 拒绝（不泄露信息）', noUser.ok === false, noUser.msg);
    check('提示和「密码错」一样', /昵称或密码不对/.test(noUser.msg || ''), noUser.msg);

  } catch (err) {
    fail++;
    console.error('  ✗ 测试炸了：', err);
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
    try { server.kill(); } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})();
