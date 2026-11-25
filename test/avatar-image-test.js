'use strict';

/**
 * 图片头像（从相册选图）测试
 *
 * 覆盖：
 *   1. 上传 PNG → 落盘 → 回执带 avatar 文件名 → 广播给所有人
 *   2. 文件真的存在，且是合法 PNG
 *   3. /avatar/<token> 能取到图片（带口令）
 *   4. 没有口令取不到（403）
 *   5. 非法数据（非 PNG 魔数）被拒
 *   6. 超大图片被拒
 *   7. 选颜色会撤掉图片头像（两种形态互斥）
 *   8. 换图片头像不影响昵称
 *   9. ⭐ 重连后名字和头像保持不变（用户明确要求）
 *  10. 历史消息里的头像跟着换
 *
 * 用法：node test/avatar-image-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8813;
const DATA_DIR = path.join(ROOT, 'data', 'test-avatar-img');
const DB_FILE = path.join(DATA_DIR, 'chat.db');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const ROOM_KEY = 'avatar-img-test-key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/* ---------------- 造一张真 PNG ---------------- */

// 手工构造一张 1×1 的合法 PNG（IHDR + IDAT + IEND）。
// 用固定的字节，不用第三方库 —— 测试要零依赖。
function makePng() {
  const zlib = require('zlib');
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);    // width
  ihdr.writeUInt32BE(1, 4);    // height
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = 2;                 // color type: truecolor
  // 1 个像素的 RGB 数据（过滤字节 + 像素）
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x00]);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 测试用客户端 ---------------- */

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
  const users = db.prepare('SELECT id, name, color, avatar FROM users').all();
  db.close();
  return users;
}

/** 取一张图片（带 / 不带口令） */
function fetchAvatar(filename, key) {
  return new Promise((resolve) => {
    const url = `/avatar/${filename}` + (key === null ? '' : `?k=${encodeURIComponent(key)}`);
    const req = http.get({ host: 'localhost', port: TEST_PORT, path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks),
        type: res.headers['content-type'],
      }));
    });
    req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0) }));
  });
}

(async () => {
  console.log('\n=== 图片头像测试 ===\n');

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
      AVATAR_COOLDOWN_MS: '800',
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
  const png = makePng();
  const pngB64 = png.toString('base64');

  try {
    console.log('[1] 上传图片头像');
    const a = new Client('ai-a');
    await a.connect();
    clients.push(a);
    const b = new Client('ai-b');
    await b.connect();
    clients.push(b);

    check('初始没有图片头像', !a.self.avatar, `avatar="${a.self.avatar}"`);

    b.drain();
    a.send({ t: 'avatarImage', data: pngB64 });
    const ack = await a.wait('avatarAck');
    check('上传成功', ack.ok === true, JSON.stringify(ack));
    const filename = ack.user && ack.user.avatar;
    check('回执带回了文件名', typeof filename === 'string' && filename.endsWith('.png'), filename);
    check('文件名是 16 位 hex', /^[0-9a-f]{16}\.png$/.test(filename || ''), filename);
    check('昵称没被改', ack.user && ack.user.name === a.self.name, ack.user && ack.user.name);

    const bSaw = await b.wait('avatar');
    check('别人也收到了广播', bSaw.user && bSaw.user.avatar === filename,
      bSaw.user && bSaw.user.avatar);

    console.log('\n[2] 文件真的落盘了');
    const onDisk = path.join(AVATAR_DIR, filename);
    check('文件存在', fs.existsSync(onDisk), onDisk);
    const diskBytes = fs.existsSync(onDisk) ? fs.readFileSync(onDisk) : Buffer.alloc(0);
    check('内容是合法 PNG', diskBytes.subarray(0, 8).equals(png.subarray(0, 8)),
      diskBytes.subarray(0, 8).toString('hex'));
    check('内容与上传的一致', diskBytes.equals(png), `${diskBytes.length} vs ${png.length} 字节`);
    const dbRow = readDb().find((u) => u.avatar === filename);
    check('数据库记下了这个文件', !!dbRow, dbRow ? dbRow.name : '(没找到)');

    console.log('\n[3] /avatar/<token> 能取到图片');
    const got = await fetchAvatar(filename, ROOM_KEY);
    check('返回 200', got.status === 200, `status=${got.status}`);
    check('Content-Type 是 image/png', got.type === 'image/png', got.type);
    check('内容是那张图', got.body.equals(png), `${got.body.length} 字节`);

    console.log('\n[4] 没有口令取不到');
    const noKey = await fetchAvatar(filename, null);
    check('没带口令被拒', noKey.status === 403, `status=${noKey.status}`);
    const badKey = await fetchAvatar(filename, 'wrong-key');
    check('口令错了被拒', badKey.status === 403, `status=${badKey.status}`);

    console.log('\n[5] 非法数据要被拒');
    await sleep(900);
    const notPng = Buffer.from('这不是图片，就是一段文字而已而已而已').toString('base64');
    a.send({ t: 'avatarImage', data: notPng });
    const ackBad = await a.wait('avatarAck');
    check('非 PNG 被拒', ackBad.ok === false, JSON.stringify(ackBad));
    check('给出了原因', typeof ackBad.msg === 'string' && ackBad.msg.length > 0, ackBad.msg);
    const stillSame = readDb().find((u) => u.id === a.self.id);
    check('头像没被换掉', stillSame && stillSame.avatar === filename, stillSame && stillSame.avatar);

    console.log('\n[6] 超大图片要被拒');
    await sleep(900);
    const huge = Buffer.alloc(300 * 1024, 0x41).toString('base64');
    a.send({ t: 'avatarImage', data: huge });
    const ackHuge = await a.wait('avatarAck');
    check('超大被拒', ackHuge.ok === false, JSON.stringify(ackHuge));

    console.log('\n[7] 选颜色会撤掉图片头像（两种形态互斥）');
    await sleep(900);
    const someColor = a.colors.find((c) => c !== a.self.color);
    a.send({ t: 'avatar', color: someColor });
    const ackColor = await a.wait('avatarAck');
    check('换色成功', ackColor.ok === true, JSON.stringify(ackColor));
    check('图片头像被清空了', !ackColor.user.avatar, `avatar="${ackColor.user.avatar}"`);
    check('旧图片文件被删了', !fs.existsSync(onDisk), onDisk);

    console.log('\n[8] 换图片头像不影响昵称');
    await sleep(900);
    const nameBefore = readDb().find((u) => u.id === a.self.id).name;
    a.send({ t: 'avatarImage', data: pngB64 });
    const ack2 = await a.wait('avatarAck');
    check('上传成功', ack2.ok === true, JSON.stringify(ack2));
    const nameAfter = readDb().find((u) => u.id === a.self.id).name;
    check('昵称没变', nameBefore === nameAfter, `${nameBefore} → ${nameAfter}`);

    console.log('\n[9] ⭐ 重连后名字和头像保持不变');
    await sleep(900);
    // 先把名字也改掉，模拟"用户自定义过一切"
    a.send({ t: 'nick', name: '小明' });
    await a.wait('nick');
    const beforeReconnect = readDb().find((u) => u.id === a.self.id);
    check('改名前是自定义名字', beforeReconnect.name === '小明', beforeReconnect.name);
    check('改名前有图片头像', !!beforeReconnect.avatar, beforeReconnect.avatar);

    a.close();
    await sleep(400);
    const a2 = new Client('ai-a');       // 同一个 cid = 同一个浏览器
    await a2.connect();
    clients.push(a2);
    check('重连后昵称不变', a2.self.name === '小明', a2.self.name);
    check('重连后图片头像不变', a2.self.avatar === beforeReconnect.avatar,
      `${a2.self.avatar} vs ${beforeReconnect.avatar}`);
    check('重连后颜色不变', a2.self.color === beforeReconnect.color,
      `${a2.self.color} vs ${beforeReconnect.color}`);

    console.log('\n[10] 历史消息里的头像跟着换');
    await sleep(400);
    // a2 发一条消息，再换一张头像 —— 新人看到的这条消息里，头像应该是最新的
    a2.send({ t: 'msg', text: '在吗' });
    await sleep(700);
    await sleep(900);
    a2.send({ t: 'avatarImage', data: pngB64 });
    const ack3 = await a2.wait('avatarAck');
    await sleep(600);
    const c2 = new Client('ai-c2');
    const initMsg = await c2.connect();
    clients.push(c2);
    await sleep(700);
    const msgFromA = initMsg.history.find((m) => m.from.id === a2.self.id && m.text === '在吗');
    check('历史消息里带头像字段', !!(msgFromA && msgFromA.from.avatar !== undefined),
      msgFromA ? `avatar="${msgFromA.from.avatar}"` : '(没找到消息)');
    check('历史消息里的头像是最新的',
      msgFromA && msgFromA.from.avatar === ack3.user.avatar,
      msgFromA ? `${msgFromA.from.avatar} vs ${ack3.user.avatar}` : '');

  } finally {
    for (const c of clients) c.close();
    server.kill();
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})();
