'use strict';

/**
 * 图片头像（从相册选图）—— 浏览器真实交互测试
 *
 * 验证页面上真的能走通这条路径：
 *   点自己的头像 → 弹出修改框（有「从相册选择图片」入口）→
 *   选一张图 → 弹出「是否确定修改？」→ 取消（不该改）→
 *   再来一次 → 确定修改（真的改了，刷新后还在）
 *
 * 用 CDP 的 DOM.setFileInputFiles 模拟用户在系统相册里选了一张图 ——
 * 这条路径和真机选文件走的是同一个 input 事件。
 *
 * 用法：node test/avatar-image-browser-test.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8814;
const DATA_DIR = path.join(ROOT, 'data', 'test-avatar-img-browser');
const KEY = 'browser-avatar-img-key';
const CDP_PORT = 9364;
const TMP_PNG = path.join(os.tmpdir(), 'avatar-test-pick.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

/* ---------------- 造一张真 PNG（16×16 红色） ---------------- */
function makePng(size = 16) {
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
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;                       // truecolor
  // 每行：过滤字节 0 + size 个像素（红色）
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = 220;          // R
      row[2 + x * 3] = 40;           // G
      row[3 + x * 3] = 40;           // B
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.p = new Map();
    this.ready = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.p.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  console.log('\n=== 图片头像（浏览器交互）测试 ===\n');

  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TMP_PNG, makePng(16));

  const server = spawn(process.execPath, ['server.js'], {
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
  if (!up) { console.log('服务端没起来：\n' + out); process.exit(1); }

  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-avatar-img-'));
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const l = await r.json();
        target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* 等浏览器 */ }
      await sleep(250);
    }
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/chat#key=${KEY}` });

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('进到了房间', ready);
    const selfObj = JSON.parse(await cdp.evaluate('JSON.stringify(window.ChatApp.state.self)'));
    console.log(`  当前身份：${selfObj.name} / ${selfObj.color}`);

    console.log('\n[1] 点自己的头像 → 弹出修改框');
    await cdp.evaluate("document.getElementById('meAvatar').click()");
    await sleep(300);
    const picker = await cdp.evaluate(`(function(){
      var m = document.getElementById('avatarModal');
      var f = document.getElementById('avatarFile');
      return {
        open: !!(m && !m.hidden),
        hasFile: !!f,
        accept: f ? f.getAttribute('accept') : '',
        uploadVisible: !!document.querySelector('.avatar-upload'),
        dots: document.getElementById('colorGrid').children.length,
      };
    })()`);
    check('弹窗出来了', picker.open === true);
    check('有「从相册选择图片」的入口', picker.uploadVisible === true);
    check('file input 的 accept 是 image/*', picker.accept === 'image/*', picker.accept);
    check('调色板还在（颜色头像保留）', picker.dots === 24, `${picker.dots} 个`);

    console.log('\n[2] 选一张图 → 弹「是否确定修改？」');
    // 用 CDP 把文件塞进 file input，触发和真机一样的 change 事件
    const doc = await cdp.send('DOM.getDocument');
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#avatarFile' });
    await cdp.send('DOM.setFileInputFiles', { files: [TMP_PNG], nodeId: node.nodeId });
    await sleep(1200);

    const afterPick = await cdp.evaluate(`(function(){
      var m = document.getElementById('avatarConfirm');
      var prev = document.getElementById('avatarPreview');
      var up = document.getElementById('avatarUploadPreview');
      return {
        confirmOpen: !!(m && !m.hidden),
        title: (document.getElementById('avatarConfirmTitle')||{}).textContent || '',
        previewImg: prev ? prev.style.backgroundImage || '' : '',
        previewText: prev ? prev.textContent : '',
        uploadThumb: up ? up.style.backgroundImage || '' : '',
        pickedLen: (window.ChatApp.state.pickedImageData || '').length,
      };
    })()`);
    check('弹出了确认框', afterPick.confirmOpen === true);
    check('标题是「是否确定修改？」', /是否确定修改/.test(afterPick.title), afterPick.title);
    check('确认框预览显示的是图片', /^url\(/.test(afterPick.previewImg), afterPick.previewImg.slice(0, 40));
    check('上传区也有缩略图', /^url\(/.test(afterPick.uploadThumb), afterPick.uploadThumb.slice(0, 40));
    check('图片已经读进内存了', afterPick.pickedLen > 100, `${afterPick.pickedLen} 字符`);
    check('预览里没有残留文字', afterPick.previewText === '', `"${afterPick.previewText}"`);

    console.log('\n[3] 选「再想想」→ 不该改');
    await cdp.evaluate("document.getElementById('avatarConfirmCancel').click()");
    await sleep(400);
    const afterCancel = await cdp.evaluate(`(function(){
      return {
        confirmOpen: !document.getElementById('avatarConfirm').hidden,
        avatar: window.ChatApp.state.self.avatar,
        color: window.ChatApp.state.self.color,
      };
    })()`);
    check('确认框关掉了', afterCancel.confirmOpen === false);
    check('头像没变（还是默认的）', !afterCancel.avatar, `avatar="${afterCancel.avatar}"`);

    console.log('\n[4] 再来一次 → 确定修改');
    await cdp.evaluate("document.getElementById('meAvatar').click()");
    await sleep(250);
    const doc2 = await cdp.send('DOM.getDocument');
    const node2 = await cdp.send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#avatarFile' });
    await cdp.send('DOM.setFileInputFiles', { files: [TMP_PNG], nodeId: node2.nodeId });
    await sleep(1200);
    await cdp.evaluate("document.getElementById('avatarConfirmOk').click()");
    await sleep(1500);

    const after = await cdp.evaluate(`(function(){
      var av = document.getElementById('meAvatar');
      return {
        avatar: window.ChatApp.state.self.avatar,
        bgImage: av.style.backgroundImage || '',
        dataImg: av.getAttribute('data-img'),
        confirmOpen: !document.getElementById('avatarConfirm').hidden,
        pickerOpen: !document.getElementById('avatarModal').hidden,
      };
    })()`);
    check('头像文件名字有了', /^[0-9a-f]{16}\.png$/.test(after.avatar || ''), after.avatar);
    check('侧栏头像铺上了图片', /^url\(/.test(after.bgImage), after.bgImage.slice(0, 50));
    check('标记成图片头像', after.dataImg === '1', after.dataImg);
    check('两个弹窗都关掉了', after.confirmOpen === false && after.pickerOpen === false);

    console.log('\n[5] 图片真的能加载出来（不是裂图）');
    const imgOk = await cdp.evaluate(`(function(){
      var av = document.getElementById('meAvatar');
      var bg = av.style.backgroundImage;
      if (!bg || bg === 'none') return Promise.resolve({ok:false, why:'没有背景图'});
      var url = bg.slice(5, -2).replace(/^["']|["']$/g, '');
      return fetch(url).then(function(r){
        return r.blob().then(function(b){
          return {ok: r.status === 200 && b.type === 'image/png', status: r.status, type: b.type, size: b.size};
        });
      }).catch(function(e){ return {ok:false, why:String(e)}; });
    })()`);
    check('图片能正常加载', imgOk.ok === true, JSON.stringify(imgOk));

    console.log('\n[6] 刷新后名字和头像都保持不变');
    await cdp.evaluate("location.reload()");
    await sleep(300);
    let ready2 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready2 = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready2) break;
    }
    check('刷新后重新进到房间', ready2);
    const afterReload = await cdp.evaluate(`(function(){
      var av = document.getElementById('meAvatar');
      return {
        avatar: window.ChatApp.state.self.avatar,
        name: window.ChatApp.state.self.name,
        bgImage: av.style.backgroundImage || '',
      };
    })()`);
    check('刷新后图片头像还在', afterReload.avatar === after.avatar,
      `${afterReload.avatar} vs ${after.avatar}`);
    check('刷新后名字也没变', afterReload.name === selfObj.name,
      `${afterReload.name} vs ${selfObj.name}`);
    check('刷新后侧栏头像还是图片', /^url\(/.test(afterReload.bgImage), afterReload.bgImage.slice(0, 50));

  } catch (err) {
    fail++;
    console.log('  ✗ 测试异常：' + err.message);
    console.log(out.slice(-1200));
  } finally {
    if (cdp) cdp.close();
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(TMP_PNG, { force: true }); } catch { /* ignore */ }
    server.kill();
  }

  console.log(`\n通过 ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})();
