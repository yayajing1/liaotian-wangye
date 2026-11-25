'use strict';

/**
 * 线上站点图片头像全流程验证（一次性脚本，不进仓库）
 *
 * 走真实公网 HTTPS + 真实浏览器：
 *   选图 → 确认 → 生效 → 图片真的能加载 → 刷新后仍是新头像 → 名字不变
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT = 9371;
const BASE = 'https://8.222.185.143';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function makePng(size = 24) {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); row[0] = 0;
    for (let x = 0; x < size; x++) { row[1 + x * 3] = 40; row[2 + x * 3] = 180; row[3 + x * 3] = 90; }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
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
  console.log('\n=== 线上图片头像全流程验证 ===\n');

  // 口令从服务器按字节取回 —— 不手敲
  const key = execFileSync('ssh', ['-o', 'ConnectTimeout=30', 'root@8.222.185.143',
    'tr -d "\\r\\n" < /opt/chat-room/app/data/room.key'], { encoding: 'utf8' }).trim();
  console.log(`  已取回房间口令（${key.length} 位）`);

  const tmpPng = path.join(os.tmpdir(), 'live-avatar-pick.png');
  fs.writeFileSync(tmpPng, makePng(24));

  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-live-av-'));
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

    // 走带口令的分享链接进房间
    await cdp.send('Page.navigate', { url: `${BASE}/chat#key=${key}` });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('用分享链接进到了房间', ready);
    if (!ready) throw new Error('进不去房间');

    const selfObj = JSON.parse(await cdp.evaluate('JSON.stringify(window.ChatApp.state.self)'));
    console.log(`  当前身份：${selfObj.name} / ${selfObj.color} / avatar="${selfObj.avatar}"`);

    console.log('\n[1] 弹窗里有「从相册选择图片」');
    await cdp.evaluate("document.getElementById('meAvatar').click()");
    await sleep(400);
    const picker = await cdp.evaluate(`(function(){
      return {
        open: !document.getElementById('avatarModal').hidden,
        upload: !!document.querySelector('.avatar-upload'),
        fileAccept: (document.getElementById('avatarFile')||{}).accept || '',
        dots: document.getElementById('colorGrid').children.length,
      };
    })()`);
    check('弹窗打开', picker.open === true);
    check('有相册入口', picker.upload === true);
    check('accept=image/*', picker.fileAccept === 'image/*', picker.fileAccept);
    check('调色板还在（24 色）', picker.dots === 24, `${picker.dots} 个`);

    console.log('\n[2] 选图 → 确认框');
    const doc = await cdp.send('DOM.getDocument');
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#avatarFile' });
    await cdp.send('DOM.setFileInputFiles', { files: [tmpPng], nodeId: node.nodeId });
    await sleep(1500);
    const picked = await cdp.evaluate(`(function(){
      return {
        confirmOpen: !document.getElementById('avatarConfirm').hidden,
        title: (document.getElementById('avatarConfirmTitle')||{}).textContent||'',
        preview: (document.getElementById('avatarPreview')||{}).style.backgroundImage||'',
      };
    })()`);
    check('弹出了确认框', picked.confirmOpen === true);
    check('标题「是否确定修改？」', /是否确定修改/.test(picked.title), picked.title);
    check('预览是图片', /^url\(/.test(picked.preview), picked.preview.slice(0, 40));

    console.log('\n[3] 确定修改 → 生效');
    await cdp.evaluate("document.getElementById('avatarConfirmOk').click()");
    await sleep(2000);
    const after = await cdp.evaluate(`(function(){
      var av = document.getElementById('meAvatar');
      return {
        avatar: window.ChatApp.state.self.avatar,
        bg: av.style.backgroundImage||'',
        dataImg: av.getAttribute('data-img'),
      };
    })()`);
    check('拿到头像文件名', /^[0-9a-f]{16}\.png$/.test(after.avatar||''), after.avatar);
    check('侧栏铺上了图片', /^url\(/.test(after.bg), after.bg.slice(0, 50));
    check('标记为图片头像', after.dataImg === '1', after.dataImg);

    console.log('\n[4] 图片真的能加载（不是裂图）');
    const img = await cdp.evaluate(`(function(){
      var bg = document.getElementById('meAvatar').style.backgroundImage;
      if (!bg) return Promise.resolve({ok:false,why:'没有背景图'});
      var url = bg.slice(5,-2).replace(/^["']|["']$/g,'');
      return fetch(url).then(function(r){ return r.blob().then(function(b){
        return {ok:r.status===200 && b.type==='image/png', status:r.status, type:b.type, size:b.size};
      });}).catch(function(e){return {ok:false,why:String(e)};});
    })()`);
    check('图片正常加载', img.ok === true, JSON.stringify(img));

    console.log('\n[5] 刷新后名字和头像都不变');
    await cdp.evaluate('location.reload()');
    await sleep(400);
    let ready2 = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      ready2 = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready2) break;
    }
    check('刷新后重新进到房间', ready2);
    const re = await cdp.evaluate(`(function(){
      var av = document.getElementById('meAvatar');
      return {
        avatar: window.ChatApp.state.self.avatar,
        name: window.ChatApp.state.self.name,
        bg: av.style.backgroundImage||'',
      };
    })()`);
    check('图片头像还在', re.avatar === after.avatar, `${re.avatar} vs ${after.avatar}`);
    check('名字没变', re.name === selfObj.name, `${re.name} vs ${selfObj.name}`);
    check('侧栏还是图片', /^url\(/.test(re.bg), re.bg.slice(0, 50));

    console.log('\n[6] 别人能看到这个头像（模拟第二个人）');
    // 用另一个 cid 连上去，看 init 里下发的头像是不是同一个
    const seen = await new Promise((resolve) => {
      const crypto = require('crypto');
      const cid = 'probe-' + crypto.randomBytes(6).toString('hex');
      const q = new URLSearchParams({ cid, key });
      const ws = new WebSocket(`wss://8.222.185.143/ws?${q.toString()}`);
      const to = setTimeout(() => { ws.close(); resolve(null); }, 12000);
      ws.on('message', (raw) => {
        const d = JSON.parse(raw.toString());
        if (d.t === 'init') {
          clearTimeout(to);
          const u = d.users.find((x) => x.avatar);
          ws.close();
          resolve(u || null);
        }
      });
      ws.on('error', () => { clearTimeout(to); resolve(null); });
    });
    check('第二个人收到的成员列表里有这张头像', !!seen && seen.avatar === after.avatar,
      seen ? `${seen.avatar} / ${seen.name}` : '(没找到)');

  } catch (err) {
    fail++;
    console.log('  ✗ 测试异常：' + err.message);
  } finally {
    if (cdp) cdp.close();
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmpPng, { force: true }); } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})();
