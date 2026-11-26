'use strict';

/**
 * 图片消息端到端验收 —— 真发一张图，走完整链路。
 *
 * 两种跑法：
 *   node test/online-image-e2e.js             打线上服务器（真实链路验收）
 *   node test/online-image-e2e.js --local     本地临时起一个服务端跑同一套流程（离线也能验）
 *   node test/online-image-e2e.js --url "https://xxx/chat#key=yyy"
 *
 * ─────────────────────────────────────────────────────────────
 * 关于「发的图会被过滤」这件事
 *
 * 服务端有魔数校验，只放两种文件头：
 *   PNG : 89 50 4E 47 0D 0A 1A 0A
 *   JPEG: FF D8 FF
 * 再加一条「纯 base64」的正则（不能带 data: 前缀、不能有空格换行）。
 *
 * 这个脚本以前塞的是一段手抄的 JPEG 片段，看着像 JPEG、其实是一堆糊字节，
 * 发出去要么被魔数挡回来（imageAck 报「只支持 JPG / PNG 图片」），
 * 要么存成一张解不开的坏图。现在改成：
 *
 *   运行时用 zlib 现造一张真正的 PNG（RGB 渐变，320×200）
 *
 * 这样保证三件事：
 *   1) 魔数一定对，不会被服务端挡回来
 *   2) 是一张浏览器能正常解码显示的图（不是坏文件）
 *   3) 体积只有几 KB，上传快，线上验收不心疼流量
 *
 * 发之前还会用「和服务端一模一样的规则」自检一遍（自检不过就地报错，
 * 不再像以前那样闷声不响地等 12 秒然后报「没收到」）。
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 服务端的硬限制（改服务端时记得同步这里） */
const MAX_IMAGE_BYTES = 1536 * 1024;
const MAX_IMAGE_B64 = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
function bail(msg) {
  console.log(`\n✗ 中断：${msg}`);
  console.log(`===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(1);
}

/* ================================================================
 * 一、造一张真 PNG（纯 Node，零依赖）
 * ================================================================ */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 造一张 width×height 的真 PNG（8bit 真彩 RGB，颜色渐变） */
function makePngBuffer(width = 320, height = 200) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                                  // 每行的 filter 字节（0 = None）
    for (let x = 0; x < width; x++) {
      raw[o++] = Math.floor((x * 255) / (width - 1));   // R 横着渐变
      raw[o++] = Math.floor((y * 255) / (height - 1));  // G 竖着渐变
      raw[o++] = 0x80;                                 // B 固定
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type = truecolor RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 用和服务端一模一样的规则自检 payload。
 * 返回 { ok, msg } —— 不过就别发出去，省得白等。
 */
function inspectPayload(b64) {
  if (!b64) return { ok: false, msg: 'payload 是空的' };
  if (b64.length > MAX_IMAGE_B64) return { ok: false, msg: `base64 太大：${b64.length} > ${MAX_IMAGE_B64}` };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, msg: '不是纯 base64（有前缀/空格/换行？）' };

  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { ok: false, msg: '解码后是空的' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, msg: `解码后太大：${buf.length} > ${MAX_IMAGE_BYTES}` };

  const isJpeg = buf.subarray(0, 3).equals(JPEG_MAGIC);
  const isPng = buf.subarray(0, 8).equals(PNG_MAGIC);
  if (!isJpeg && !isPng) {
    return { ok: false, msg: `魔数不对：头三字节 ${buf.subarray(0, 3).toString('hex')}（PNG 要 89504e47…，JPEG 要 ffd8ff）` };
  }
  if (isPng) {
    // 顺手确认这是一张「能解开」的 PNG：把 IDAT 解压回去，长度必须对得上
    try {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      const idat = [];
      let p = 8;
      while (p + 8 <= buf.length) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('ascii', p + 4, p + 8);
        if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
        p += 12 + len;
        if (type === 'IEND') break;
      }
      const raw = zlib.inflateSync(Buffer.concat(idat));
      if (raw.length !== (w * 3 + 1) * h) {
        return { ok: false, msg: `PNG 像素数据对不上（解出 ${raw.length}，应为 ${(w * 3 + 1) * h}）` };
      }
    } catch (e) {
      return { ok: false, msg: `PNG 解不开：${e.message}` };
    }
  }
  return { ok: true, msg: `${buf.length} 字节 · ${isPng ? 'PNG' : 'JPEG'}` };
}

/* ================================================================
 * 二、连线上（默认）或本地（--local）
 * ================================================================ */

function readShareUrl() {
  try {
    const f = path.join(ROOT, 'share-link.txt');
    const m = fs.readFileSync(f, 'utf8').match(/https?:\/\/[^\s#]+#key=[A-Za-z0-9]+/);
    if (m) return m[0];
  } catch { /* ignore */ }
  return 'https://8.222.185.143/chat#key=fx1r08kn1ozr';
}

function wsUrl(httpUrl, cid) {
  const u = new URL(httpUrl);
  const key = (u.hash.match(/key=([A-Za-z0-9]+)/) || [])[1] || '';
  u.hash = '';
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return `${u.toString()}?cid=${cid}&key=${key}&st=`;
}

function connect(url, label = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 20000 });
    const msgs = [];
    let init = null;
    ws.on('open', () => { /* 等 init */ });
    ws.on('message', (raw) => {
      let d;
      try { d = JSON.parse(raw.toString()); } catch { return; }
      msgs.push(d);
      if (d.t === 'init') init = d;
      if (init) resolve({ ws, init, msgs });
    });
    ws.on('error', reject);
    setTimeout(() => { if (!init) reject(new Error('没收到 init')); }, 20000);
  });
}

/** 连不上就重试，最后一次失败要能看出是「网络不通」还是「口令不对」 */
async function connectWithRetry(url, label, tries = 25) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const c = await connect(url);
      console.log(`  ${label} 连上了（第 ${i} 次尝试）`);
      return c;
    } catch (e) {
      last = e;
      console.log(`  ${label} 第 ${i} 次失败：${e.message}`);
      await sleep(4000);
    }
  }
  console.log('\n连不上服务端。常见原因：');
  console.log('  · 本机到服务器的网络不通（跨境链路抖动）—— 先用浏览器打开链接看看');
  console.log('  · 链接里的房间口令过期了 —— 用 deploy/print-link.sh 重新生成');
  console.log('  · 服务端挂了 —— SSH 上去 systemctl status chat-room');
  throw last || new Error('连接失败');
}

/* ================================================================
 * 三、正式流程
 * ================================================================ */

async function run(URL, opts = {}) {
  console.log(`图片消息验收：${URL}\n`);

  section('[0] 造测试图片（运行时生成的真 PNG）');
  const png = makePngBuffer(320, 200);
  const b64 = png.toString('base64');
  const info = inspectPayload(b64);
  check('图片通过服务端同款自检（魔数/大小/base64）', info.ok, info.msg);
  if (!info.ok) bail(`图片没过自检：${info.msg} —— 发出去也只会被服务端挡回来`);
  check('PNG 头是 89504e47', png.subarray(0, 4).toString('hex') === '89504e47', png.subarray(0, 8).toString('hex'));

  section('[1] 连接服务端');
  let A = null;
  try {
    A = await connectWithRetry(wsUrl(URL, `img-e2e-a-${Date.now()}`), '客户端 A');
  } catch (e) {
    bail(`连不上：${e.message}`);
  }
  let B = null;
  try {
    B = await connectWithRetry(wsUrl(URL, `img-e2e-b-${Date.now()}`), '客户端 B');
  } catch (e) {
    A.ws.close();
    bail(`第二个客户端连不上：${e.message}`);
  }
  console.log('  两个客户端都在线（用来验证「别人能看见」）');

  section('[2] 发送图片');
  A.ws.send(JSON.stringify({ t: 'image', data: b64, caption: '线上验收测试图' }));

  let sent = null, ack = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const m = A.msgs.find((x) => x.t === 'msg' && x.msg && x.msg.kind === 'image');
    if (m) sent = m.msg;
    const a = A.msgs.find((x) => x.t === 'imageAck');
    if (a) ack = a;
    if (sent && ack) break;
  }

  if (ack && ack.ok === false) {
    console.log(`  服务端拒绝原因：${ack.msg}`);
    A.ws.close(); B.ws.close();
    bail(`服务端把图挡回来了：「${ack.msg}」 —— 说明 payload 格式仍不合服务端要求`);
  }
  check('图片消息广播出来了', !!sent, sent ? sent.text : '没收到');
  if (!sent) {
    console.log('  （没收到 imageAck，说明服务端压根没处理这个包）');
    A.ws.close(); B.ws.close();
    bail('没等到广播');
  }
  check('服务端回了 imageAck ok', !!(ack && ack.ok), ack ? JSON.stringify(ack) : '没收到 ack');
  check('图片 token 格式正确', /^[0-9a-f]{16}\.(jpg|png)$/.test(sent.text), sent.text);
  check('配文带上了', sent.caption === '线上验收测试图', JSON.stringify(sent.caption));

  section('[3] 另一个客户端也收到了');
  const gotByB = (B.msgs.find((x) => x.t === 'msg' && x.msg && x.msg.kind === 'image') || {}).msg;
  check('B 也收到了这条图片消息', !!gotByB, gotByB ? gotByB.text : '没收到');

  section('[4] 图片能真的取到（要口令）');
  const base = URL.split('#')[0].replace(/\/chat.*$/, '');
  const key = (URL.match(/key=([A-Za-z0-9]+)/) || [])[1] || '';
  const withKey = await fetch(`${base}/image/${sent.text}?k=${key}`);
  const noKey = await fetch(`${base}/image/${sent.text}`);
  check('带口令 → 200', withKey.status === 200, String(withKey.status));
  const ct = withKey.headers.get('content-type') || '';
  check('返回的是图片', ct.includes('image/'), ct);
  // Content-Type 必须跟文件真实格式一致 —— 服务端带 nosniff，写错了浏览器会拒渲染
  const wantCt = sent.text.endsWith('.png') ? 'image/png' : 'image/jpeg';
  check('Content-Type 和文件格式对得上', ct === wantCt, `期望 ${wantCt}，实际 ${ct}`);
  const bytes = Buffer.from(await withKey.arrayBuffer());
  check('取回来的字节和发上去的一致', bytes.equals(png), `${bytes.length} vs ${png.length} 字节`);
  check('取回来的文件头合法', bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.subarray(0, 3).equals(JPEG_MAGIC),
    bytes.subarray(0, 8).toString('hex'));
  check('不带口令 → 403', noKey.status === 403, String(noKey.status));

  section('[5] 撤回测试消息（不留垃圾）');
  A.ws.send(JSON.stringify({ t: 'recall', id: sent.id }));
  await sleep(1500);
  const recalled = A.msgs.find((x) => x.t === 'recall' && x.id === sent.id);
  check('撤回成功', !!recalled);

  const after = (await connect(wsUrl(URL, `img-e2e-c-${Date.now()}`))).init.history || [];
  const imgLeft = after.filter((m) => m.kind === 'image').length;
  check('撤回后不再显示图片消息', imgLeft === 0, `还剩 ${imgLeft} 条`);

  A.ws.close(); B.ws.close();
}

/* ================================================================
 * 四、入口
 * ================================================================ */

(async () => {
  const argv = process.argv.slice(2);
  const useLocal = argv.includes('--local');
  const urlIdx = argv.indexOf('--url');
  const customUrl = urlIdx >= 0 ? argv[urlIdx + 1] : '';

  let server = null;
  let URL = customUrl || readShareUrl();

  if (useLocal) {
    // 本地起一个临时服务端，跑同一套流程 —— 离线也能验这套脚本本身没坏
    const PORT = 8831;
    const KEY = 'imgE2eLocal01';
    const DATA_DIR = path.join(ROOT, 'data', 'img-e2e-local');
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(DATA_DIR, { recursive: true });

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), ALT_PORT: '0', DATA_DIR, ROOM_KEY: KEY },
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
    if (!up) {
      server.kill();
      console.log('本地服务端没起来：\n' + out);
      process.exit(1);
    }
    URL = `http://127.0.0.1:${PORT}/chat#key=${KEY}`;
    console.log(`本地模式：临时服务端已启动 → ${URL}`);
  }

  try {
    await run(URL, { local: useLocal });
  } catch (e) {
    console.error('\n✗ 异常：', e && e.message ? e.message : e);
    fail++;
  } finally {
    if (server) { try { server.kill(); } catch { /* ignore */ } }
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();
