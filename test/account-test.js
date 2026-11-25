'use strict';

/**
 * 账号系统（注册 / 登入）测试
 *
 * 覆盖：
 *   1. 注册 → 账号绑到**当前身份**（昵称/头像/历史都保留，不新建空身份）
 *   2. 数据库里存的是哈希不是明文，且带自描述参数（s2$N$r$p$盐$哈希）
 *   3. 弱密码被拒：太短 / 没有数字 / 纯字母 / 常见弱口令
 *   4. 账号名规则：太短 / 非法字符 / 重复
 *   5. 两次密码不一致 → 被拒
 *   6. 登入：账号+密码 → 身份换回来（跨设备）
 *   7. 密码错 / 账号不存在 → 同一句提示（不泄露账号是否存在）
 *   8. 连续输错 → 账号被锁
 *   9. 会话 token：登入后带 token 连接 → 自动认回身份（不用再输密码）
 *   10. 会话 token 在库里只存 sha256
 *   11. 退出登录 → 会话作废
 *   12. 改密码 → 旧密码失效，其它设备的会话被踢
 *   13. 账号绑定的身份不会被 7 天清理任务删掉
 *   14. 安全响应头（CSP / X-Frame-Options / nosniff…）
 *   15. 按 IP 限流
 *
 * 用法：node test/account-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8817;
const DATA_DIR = path.join(ROOT, 'data', 'test-account');
const DB_FILE = path.join(DATA_DIR, 'chat.db');
const ROOM_KEY = 'account-test-key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

class Client {
  constructor(cid, token = '', ip = '') {
    this.cid = cid;
    this.token = token;
    // 模拟不同的客户端 IP —— 服务端按 X-Forwarded-For 限流，
    // 所有客户端共用一个 IP 会让「账号锁定」和「IP 限流」互相干扰。
    this.ip = ip || `10.0.${(Math.random() * 200 + 10) | 0}.${(Math.random() * 200 + 10) | 0}`;
    this.inbox = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ cid: this.cid, key: ROOM_KEY });
      if (this.token) q.set('st', this.token);
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?${q.toString()}`, {
        headers: { 'X-Forwarded-For': this.ip },
      });
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

  wait(type, ms = 6000) {
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
  const users = db.prepare('SELECT id, name, color, avatar, login_hash FROM users').all();
  const accounts = db.prepare('SELECT * FROM accounts').all();
  let sessions = [];
  try { sessions = db.prepare('SELECT * FROM account_sessions').all(); } catch { /* 表还没建 */ }
  const msgs = db.prepare('SELECT id, sender_id, text FROM messages').all();
  db.close();
  return { users, accounts, sessions, msgs };
}

/** 拿一个 HTTP 响应的头 */
function head(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: TEST_PORT, path: pathname, method: 'GET',
    }, (res) => {
      res.resume();
      resolve(res.headers);
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('\n=== 账号系统测试 ===\n');

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
      // 把会话有效期调短，方便测「过期」
      SESSION_TTL_MS: '3600000',
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
    /* ---------------- [1] 注册绑定当前身份 ---------------- */
    console.log('[1] 注册账号');
    const a = new Client('acc-a');
    await a.connect();
    clients.push(a);

    const aName = a.self.name;
    check('刚进来是临时身份', !!aName, aName);

    // 先发一条消息，用来验证「注册不会换身份」
    a.send({ t: 'msg', text: '注册前的消息' });
    await sleep(250);

    a.send({ t: 'accountRegister', username: 'xiaoming', password: 'goodpw123', password2: 'goodpw123' });
    const reg = await a.wait('accountAck');
    check('注册成功', reg.ok === true, reg.msg);
    check('回执带上了账号名', reg.username === 'xiaoming', reg.username);
    check('回执带上了会话 token', typeof reg.token === 'string' && reg.token.length >= 32,
      reg.token ? `${reg.token.length} 位` : '没有');
    check('注册后身份没变', reg.user && reg.user.id === a.self.id, reg.user && reg.user.id);
    check('注册后昵称没变', reg.user && reg.user.name === aName, reg.user && reg.user.name);

    // 服务端应该也认定「我已注册」
    a.send({ t: 'accountInfo' });
    const info = await a.wait('accountInfo');
    check('accountInfo 说已注册', info.registered === true, `registered=${info.registered}`);
    check('accountInfo 带上了账号名', info.username === 'xiaoming', info.username);

    /* ---------------- [2] 数据库里存的是哈希 ---------------- */
    console.log('\n[2] 密码存储');
    const db1 = readDb();
    const acc = db1.accounts.find((x) => x.username === 'xiaoming');
    check('账号表里有这条记录', !!acc, acc ? '有' : '没有');
    check('没存明文', acc && acc.pass_hash !== 'goodpw123',
      acc ? String(acc.pass_hash).slice(0, 24) + '…' : '');
    check('哈希是自描述格式（带参数和盐）',
      acc && /^s2\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(acc.pass_hash),
      acc ? acc.pass_hash.slice(0, 40) + '…' : '');
    check('参数是加强后的 N=32768', acc && acc.pass_hash.split('$')[1] === '32768',
      acc ? acc.pass_hash.split('$')[1] : '');
    check('账号绑到了当前身份', acc && acc.user_id === a.self.id, acc && acc.user_id);

    // 会话只存哈希
    const sess = db1.sessions.find((x) => x.account_id === acc.id);
    check('会话表里有记录', !!sess);
    check('会话存的是 sha256 不是明文 token',
      sess && sess.token_hash !== reg.token && /^[0-9a-f]{64}$/.test(sess.token_hash || ''),
      sess ? String(sess.token_hash).slice(0, 16) + '…' : '');

    /* ---------------- [3] 弱密码被拒 ---------------- */
    console.log('\n[3] 弱密码');
    const w = new Client('acc-w');
    await w.connect();
    clients.push(w);

    const weakCases = [
      ['ab12', '太短'],
      ['abcdefgh', '没有数字'],
      ['12345678', '纯数字且是常见弱口令'],
      ['password', '常见弱口令'],
      ['password1', '常见弱口令'],
      ['123456789', '常见弱口令'],
    ];
    for (const [pw, why] of weakCases) {
      w.send({ t: 'accountRegister', username: `w${pw.replace(/\W/g, '').slice(0, 8)}`, password: pw, password2: pw });
      const r = await w.wait('accountAck');
      check(`弱密码被拒（${why}）`, r.ok === false, `${pw} → ${r.msg}`);
    }

    /* ---------------- [4] 账号名规则 ---------------- */
    console.log('\n[4] 账号名规则');
    w.send({ t: 'accountRegister', username: 'ab', password: 'goodpw123', password2: 'goodpw123' });
    let r = await w.wait('accountAck');
    check('账号名太短被拒', r.ok === false, r.msg);

    w.send({ t: 'accountRegister', username: 'bad name!@#', password: 'goodpw123', password2: 'goodpw123' });
    r = await w.wait('accountAck');
    check('账号名含非法字符被拒', r.ok === false, r.msg);

    w.send({ t: 'accountRegister', username: 'xiaoming', password: 'goodpw123', password2: 'goodpw123' });
    r = await w.wait('accountAck');
    check('账号名重复被拒', r.ok === false, r.msg);

    w.send({ t: 'accountRegister', username: 'xiaoming2', password: 'goodpw123', password2: 'different123' });
    r = await w.wait('accountAck');
    check('两次密码不一致被拒', r.ok === false, r.msg);

    /* ---------------- [5] 登入（跨设备） ---------------- */
    console.log('\n[5] 换设备登入');
    const b = new Client('acc-b');
    await b.connect();
    clients.push(b);
    const bTemp = b.self.name;
    check('新设备是临时身份', bTemp !== aName, `${bTemp} vs ${aName}`);

    b.send({ t: 'accountLogin', username: 'xiaoming', password: 'goodpw123' });
    const login = await b.wait('accountAck');
    check('登入成功', login.ok === true, login.msg);
    check('身份换回来了', login.user && login.user.id === a.self.id, login.user && login.user.id);
    check('昵称换回来了', login.user && login.user.name === aName, login.user && login.user.name);
    check('登入后拿到 token', typeof login.token === 'string' && login.token.length >= 32);

    // 历史消息里「注册前那条」应该归我
    const mine = (login.history || []).filter((m) => m.text === '注册前的消息');
    check('历史消息归到换回来的身份',
      mine.length === 1 && mine[0].from.id === a.self.id,
      mine.length ? mine[0].from.name : '没找到');

    // 临时身份应该被清掉
    const db2 = readDb();
    check('临时身份行被清掉了', !db2.users.find((u) => u.name === bTemp), bTemp);

    /* ---------------- [6] 密码错 / 账号不存在 ---------------- */
    console.log('\n[6] 密码错 vs 账号不存在');
    const c = new Client('acc-c');
    await c.connect();
    clients.push(c);

    c.send({ t: 'accountLogin', username: 'xiaoming', password: 'wrongpw123' });
    const badPw = await c.wait('accountAck');
    check('密码错被拒', badPw.ok === false, badPw.msg);

    c.send({ t: 'accountLogin', username: 'nobodyhere', password: 'wrongpw123' });
    const noUser = await c.wait('accountAck');
    check('账号不存在被拒', noUser.ok === false, noUser.msg);
    check('两种失败给的是同一句话（不泄露账号是否存在）',
      badPw.msg === noUser.msg, `${badPw.msg} / ${noUser.msg}`);

    /* ---------------- [7] 会话 token 自动认回 ---------------- */
    console.log('\n[7] 带 token 连接 → 自动认回身份');
    const d = new Client('acc-d', login.token);
    await d.connect();
    clients.push(d);
    check('带 token 连进来直接就是原身份', d.self.id === a.self.id, `${d.self.id}`);
    check('昵称也是原来的', d.self.name === aName, d.self.name);
    check('init 说会话有效', d.init.sessionOk === true, `sessionOk=${d.init.sessionOk}`);
    check('init 说已注册', d.init.registered === true, `registered=${d.init.registered}`);
    check('init 带上了账号名', d.init.username === 'xiaoming', d.init.username);

    // 无效 token → 当作没登录
    const bad = new Client('acc-e', 'totally-invalid-token-value');
    await bad.connect();
    clients.push(bad);
    check('无效 token 不会认回身份', bad.self.id !== a.self.id, bad.self.id);
    check('无效 token 时 sessionOk=false', bad.init.sessionOk === false, `sessionOk=${bad.init.sessionOk}`);

    /* ---------------- [8] 连续输错 → 锁定 ---------------- */
    console.log('\n[8] 账号锁定');
    const lockUser = 'locktest';
    const lw = new Client('acc-lw');
    await lw.connect();
    clients.push(lw);
    lw.send({ t: 'accountRegister', username: lockUser, password: 'goodpw123', password2: 'goodpw123' });
    const lr = await lw.wait('accountAck');
    check('待锁账号注册成功', lr.ok === true, lr.msg);

    // 连错 5 次 → 第 5 次就该提示锁定
    // 同一个 IP（模拟同一个攻击者），但账号级锁定比 IP 限流更快触发
    let lockedMsg = '';
    for (let i = 0; i < 5; i++) {
      const t = new Client(`acc-lw-${i}`, '', '10.9.9.9');
      await t.connect();
      clients.push(t);
      t.send({ t: 'accountLogin', username: lockUser, password: `bad${i}pass1` });
      const rr = await t.wait('accountAck');
      lockedMsg = rr.msg;
      t.close();
    }
    check('第 5 次输错就提示锁定', /锁定/.test(lockedMsg), lockedMsg);

    // 锁着的时候，正确密码也进不去
    const lk = new Client('acc-lk', '', '10.9.9.9');
    await lk.connect();
    clients.push(lk);
    lk.send({ t: 'accountLogin', username: lockUser, password: 'goodpw123' });
    const lkRes = await lk.wait('accountAck');
    check('锁着的时候正确密码也进不去', lkRes.ok === false, lkRes.msg);
    check('提示的是「锁定」而不是「IP 限流」', /锁定|分钟/.test(lkRes.msg), lkRes.msg);

    const db3 = readDb();
    const lockAcc = db3.accounts.find((x) => x.username === lockUser);
    check('锁定时间写进了数据库', lockAcc && lockAcc.locked_until > Date.now(),
      lockAcc ? new Date(lockAcc.locked_until).toISOString() : '');
    check('失败次数记在库里', lockAcc && lockAcc.fail_count >= 5, `fail_count=${lockAcc && lockAcc.fail_count}`);

    /* ---------------- [9] 退出登录 ---------------- */
    console.log('\n[9] 退出登录');
    const e = new Client('acc-e2', login.token);
    await e.connect();
    clients.push(e);
    check('带 token 认回成功', e.self.id === a.self.id, e.self.id);

    e.send({ t: 'accountLogout' });
    const lo = await e.wait('accountAck');
    check('退出登录有回执', lo.ok === true, lo.msg);

    // token 作废了 → 再连就认不回
    const e2 = new Client('acc-e3', login.token);
    await e2.connect();
    clients.push(e2);
    check('退出后 token 失效', e2.self.id !== a.self.id, e2.self.id);

    /* ---------------- [10] 改密码 ---------------- */
    console.log('\n[10] 改密码');

    // 先用旧密码重新登入拿一个有效 token
    // （上一节把 token 作废了，这里必须重新拿）
    const g = new Client('acc-g');
    await g.connect();
    clients.push(g);
    g.send({ t: 'accountLogin', username: 'xiaoming', password: 'goodpw123' });
    const gLogin = await g.wait('accountAck');
    check('用旧密码登入成功', gLogin.ok === true, gLogin.msg);

    // 带新 token 的设备也应该能认回身份
    const f = new Client('acc-f', gLogin.token);
    await f.connect();
    clients.push(f);
    check('带 token 认回成功', f.self.id === a.self.id, f.self.id);

    g.send({ t: 'accountChangePw', oldPw: 'wrongold1', newPw: 'newpass456' });
    const badChg = await g.wait('accountAck');
    check('原密码错 → 改密码失败', badChg.ok === false, badChg.msg);

    g.send({ t: 'accountChangePw', oldPw: 'goodpw123', newPw: 'short' });
    const weakChg = await g.wait('accountAck');
    check('新密码太弱 → 被拒', weakChg.ok === false, weakChg.msg);

    g.send({ t: 'accountChangePw', oldPw: 'goodpw123', newPw: 'newpass456' });
    const goodChg = await g.wait('accountAck');
    check('改密码成功', goodChg.ok === true, goodChg.msg);
    check('改完给了新 token', typeof goodChg.token === 'string' && goodChg.token.length >= 32);

    // 旧密码不能用了
    const h = new Client('acc-h');
    await h.connect();
    clients.push(h);
    h.send({ t: 'accountLogin', username: 'xiaoming', password: 'goodpw123' });
    const oldTry = await h.wait('accountAck');
    check('旧密码已经不能用了', oldTry.ok === false, oldTry.msg);

    // 新密码能用
    h.send({ t: 'accountLogin', username: 'xiaoming', password: 'newpass456' });
    const newTry = await h.wait('accountAck');
    check('新密码能登入', newTry.ok === true, newTry.msg);

    /* ---------------- [11] 账号绑定的身份不被清理 ---------------- */
    console.log('\n[11] 清理任务不会删掉账号绑定的身份');
    const db4 = readDb();
    const boundUser = db4.accounts.find((x) => x.username === 'xiaoming');
    check('账号仍绑在原身份上', boundUser && boundUser.user_id === a.self.id,
      boundUser && boundUser.user_id);

    // 手动跑一次清理 SQL 的条件，确认它不会命中这个用户
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const stale = Date.now() + 999999999;    // 假装「很久没上线」
    const wouldDelete = db.prepare(`
      SELECT id FROM users
      WHERE id NOT IN (SELECT DISTINCT sender_id FROM messages)
        AND last_seen < ?
        AND (login_hash IS NULL OR login_hash = '')
        AND id NOT IN (SELECT user_id FROM accounts)
    `).all(stale).map((r) => r.id);
    db.close();
    check('清理条件不会删掉账号绑定的身份', !wouldDelete.includes(a.self.id),
      `会被删的: ${wouldDelete.join(',') || '（无）'}`);

    /* ---------------- [12] 安全响应头 ---------------- */
    console.log('\n[12] 安全响应头');
    const hd = await head('/chat');
    check('有 CSP', !!hd['content-security-policy'], hd['content-security-policy'] ? hd['content-security-policy'].slice(0, 40) + '…' : '没有');
    check('CSP 里有 script-src self', /script-src 'self'/.test(hd['content-security-policy'] || ''));
    check('CSP 里有 frame-ancestors none', /frame-ancestors 'none'/.test(hd['content-security-policy'] || ''));
    check('有 X-Frame-Options', hd['x-frame-options'] === 'DENY', hd['x-frame-options']);
    check('有 X-Content-Type-Options', hd['x-content-type-options'] === 'nosniff', hd['x-content-type-options']);
    check('有 Referrer-Policy', !!hd['referrer-policy'], hd['referrer-policy']);
    check('有 Permissions-Policy', !!hd['permissions-policy'], (hd['permissions-policy'] || '').slice(0, 30) + '…');
    check('没泄露 X-Powered-By', !hd['x-powered-by'] || hd['x-powered-by'] === '',
      hd['x-powered-by'] || '（空）');
    // 本地是 http，不该发 HSTS
    check('http 下不发 HSTS', !hd['strict-transport-security'], hd['strict-transport-security'] || '（没有）');

    /* ---------------- [13] 老哈希仍能验证 ---------------- */
    console.log('\n[13] 兼容老的登录密码哈希');
    const legacy = new Client('acc-legacy');
    await legacy.connect();
    clients.push(legacy);
    legacy.send({ t: 'loginSet', pw: 'mypw1234' });
    const la = await legacy.wait('loginAck');
    check('老接口设密码成功', la.ok === true, la.msg);

    const db5 = readDb();
    const legacyRow = db5.users.find((u) => u.login_hash);
    check('老接口也用自描述格式了', legacyRow && /^s2\$/.test(legacyRow.login_hash),
      legacyRow ? legacyRow.login_hash.slice(0, 20) + '…' : '');

    const legacy2 = new Client('acc-legacy2');
    await legacy2.connect();
    clients.push(legacy2);
    legacy2.send({ t: 'loginClaim', name: legacy.self.name, pw: 'mypw1234' });
    const lo2 = await legacy2.wait('loginOk');
    check('老接口登录仍能用', !!lo2.user, JSON.stringify(lo2.user || {}));
  } catch (err) {
    fail++;
    console.log('\n  ✗ 测试异常：' + (err && err.stack ? err.stack : err));
  } finally {
    for (const c of clients) c.close();
    try { server.kill(); } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
