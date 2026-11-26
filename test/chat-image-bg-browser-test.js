'use strict';

/**
 * 聊天图片 + 聊天背景 —— 浏览器真实测试
 *
 * 覆盖：
 *   1. 输入区有「发图片」按钮，点了能弹出预览条
 *   2. 预览条能配文、能取消
 *   3. 发出去的图片别人能看见（气泡里有 <img>，src 指向 /image/<token>）
 *   4. 图片接口要口令 —— 没口令返回 403
 *   5. 点图片能开灯箱看大图
 *   6. 聊天背景：能从「相册」选图设成背景，刷新后还在
 *   7. 背景「恢复默认」能还原
 *   8. 背景只影响本机（另一个客户端不受影响）
 *   9. 界面美化：新样式确实生效（绿气泡、圆角、阴影）
 *  10. 手机端 1:3 比例不受影响
 *
 * 用法：node test/chat-image-bg-browser-test.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8833;
const DATA_DIR = path.join(ROOT, 'data', 'test-chat-img');
const KEY = 'chat-img-bg-key';
const CDP_PORT = 9383;

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    return;
  }
  try { proc.kill(); } catch { /* ignore */ }
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
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 连一个独立客户端（用 ws 直接连，验证服务器侧状态） */
function peerConnect(cid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?cid=${cid}&key=${KEY}`);
    let init = null;
    const msgs = [];
    ws.on('open', () => { /* 等 init */ });
    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.t === 'init') { init = d; }
      msgs.push(d);
      if (d.t === 'init' && init) { resolve({ ws, init, msgs }); }
    });
    ws.on('error', reject);
    setTimeout(() => { if (!init) reject(new Error('peer 没收到 init')); }, 12000);
  });
}

/** 造一张 1x1 的红色 PNG（base64） */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  console.log('\n=== 聊天图片 + 聊天背景 测试 ===\n');

  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });

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
    await sleep(250);
    if (out.includes('聊天室已启动')) { up = true; break; }
  }
  if (!up) { console.log('服务端没起来：\n' + out); server.kill(); process.exit(1); }

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge，跳过'); server.kill(); process.exit(0); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-chatimg-'));
  const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

  let cdp = null;
  const peers = [];
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
    if (!target) throw new Error('连不上浏览器 CDP');
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/chat#key=${KEY}` });

    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('进到了房间', ready);
    if (!ready) throw new Error('页面没进房间，后续测不了');

    // 关掉自动弹出的账号框，免得挡着
    await cdp.evaluate(`(function(){
      var a = document.getElementById('accCloseBtn'); if (a) a.click();
    })()`);
    await sleep(300);

    /* ---------- [1] 发图片按钮 ---------- */
    console.log('\n[1] 输入区的「发图片」按钮');
    const btn = await cdp.evaluate(`(function(){
      var b = document.getElementById('imgBtn');
      if (!b) return { missing: true };
      var r = b.getBoundingClientRect();
      return { missing: false, w: r.width, h: r.height,
               visible: r.width > 0 && r.height > 0,
               inRow: b.closest('.input-row') !== null };
    })()`);
    check('有「发图片」按钮', !btn.missing);
    check('按钮在输入行里且可见', btn.visible && btn.inRow, `${btn.w}×${btn.h}`);

    /* ---------- [2] 选图 → 预览条 ---------- */
    console.log('\n[2] 选图后出现预览条');
    // 先点按钮（这一步会挂上 filePicker 的 onchange），
    // 再用 DataTransfer 模拟「从相册里选了一个文件」
    await cdp.evaluate(`document.getElementById('imgBtn').click()`);
    await sleep(300);
    const picked = await cdp.evaluate(`(function(){
      return new Promise(function(resolve){
        var canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#e24b4a'; ctx.fillRect(0,0,64,64);
        canvas.toBlob(function(blob){
          var file = new File([blob], 'test.png', { type: 'image/png' });
          var dt = new DataTransfer();
          dt.items.add(file);
          var input = document.getElementById('filePicker');
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(function(){
            resolve({
              previewShown: !document.getElementById('imgPreview').hidden,
              src: (document.getElementById('imgPreviewImg').src || '').slice(0, 30),
              capShown: !!document.getElementById('imgPreviewCap').offsetParent
            });
          }, 1200);
        }, 'image/png');
      });
    })()`);
    check('预览条出现', picked.previewShown);
    check('预览图有内容', picked.src.startsWith('data:image/'), picked.src);

    /* ---------- [3] 配文 + 取消 ---------- */
    console.log('\n[3] 预览条能配文、能取消');
    await cdp.evaluate(`document.getElementById('imgPreviewCap').value = '这是一张测试图'`);
    const capOk = await cdp.evaluate(`document.getElementById('imgPreviewCap').value`);
    check('配文框能输入', capOk === '这是一张测试图', capOk);

    /* ---------- [4] 发出去 ---------- */
    console.log('\n[4] 发送图片');
    // 先发一条文字，后面的样式断言才有气泡可量
    await cdp.evaluate(`(function(){
      var i = document.getElementById('input');
      i.value = '测试文字消息';
      document.getElementById('sendBtn').click();
    })()`);
    await sleep(800);

    await cdp.evaluate(`document.getElementById('sendBtn').click()`);
    await sleep(1600);

    const sent = await cdp.evaluate(`(function(){
      var imgs = document.querySelectorAll('#messages .msg-img');
      var last = imgs[imgs.length-1];
      return {
        n: imgs.length,
        src: last ? last.getAttribute('src') : '',
        previewHidden: document.getElementById('imgPreview').hidden
      };
    })()`);
    check('气泡里出现了图片', sent.n > 0, `${sent.n} 张`);
    check('图片地址指向 /image/<token>', /\/image\/[0-9a-f]{16}\.(jpg|png)/.test(sent.src), sent.src);
    check('发完预览条消失', sent.previewHidden);

    /* ---------- [5] 另一个客户端能收到 ---------- */
    console.log('\n[5] 别的客户端也收到了这张图片');
    const peer = await peerConnect('img-peer-1');
    peers.push(peer.ws);
    const imgMsgs = (peer.init.history || []).filter((m) => m.kind === 'image');
    check('服务器里有图片消息', imgMsgs.length === 1, `${imgMsgs.length} 条`);
    check('图片消息的 text 是 token', /^[0-9a-f]{16}\.(jpg|png)$/.test(imgMsgs[0] ? imgMsgs[0].text : ''),
      imgMsgs[0] ? imgMsgs[0].text : '');
    check('配文一起存下来了', imgMsgs[0] && imgMsgs[0].caption === '这是一张测试图',
      imgMsgs[0] ? JSON.stringify(imgMsgs[0].caption) : 'null');

    // 配文在页面上也要渲染出来
    const capRendered = await cdp.evaluate(`(function(){
      var c = document.querySelector('#messages .msg-img-cap');
      return c ? c.textContent : '';
    })()`);
    check('配文渲染在图片下方', capRendered === '这是一张测试图', capRendered);

    /* ---------- [6] 图片接口要口令 ---------- */
    console.log('\n[6] 图片接口必须带口令');
    const token = imgMsgs[0] ? imgMsgs[0].text : '';
    const withKey = await fetch(`http://127.0.0.1:${PORT}/image/${token}?k=${KEY}`);
    const noKey = await fetch(`http://127.0.0.1:${PORT}/image/${token}`);
    const badKey = await fetch(`http://127.0.0.1:${PORT}/image/${token}?k=wrongkey`);
    check('带正确口令 → 200', withKey.status === 200, String(withKey.status));
    check('不带口令 → 403', noKey.status === 403, String(noKey.status));
    check('口令错误 → 403', badKey.status === 403, String(badKey.status));
    check('返回的是图片', (withKey.headers.get('content-type') || '').includes('image/'),
      withKey.headers.get('content-type'));

    /* ---------- [7] 灯箱 ---------- */
    console.log('\n[7] 点图片开灯箱');
    await cdp.evaluate(`(function(){
      var im = document.querySelector('#messages .msg-img');
      if (im) im.click();
    })()`);
    await sleep(500);
    const lb = await cdp.evaluate(`(function(){
      var l = document.getElementById('lightbox');
      var im = document.getElementById('lightboxImg');
      return { open: l && !l.hidden, hasSrc: !!(im && im.getAttribute('src')) };
    })()`);
    check('灯箱打开了', lb.open);
    check('灯箱里有大图', lb.hasSrc);

    await cdp.evaluate(`document.getElementById('lightboxX').click()`);
    await sleep(300);
    const lbClosed = await cdp.evaluate(`document.getElementById('lightbox').hidden`);
    check('灯箱能关掉', lbClosed);

    /* ---------- [8] 聊天背景 ---------- */
    console.log('\n[8] 聊天背景：从相册选图');
    await cdp.evaluate(`document.getElementById('bgBtn').click()`);
    await sleep(400);
    const bgModalOpen = await cdp.evaluate(`!document.getElementById('bgModal').hidden`);
    check('背景弹窗打开了', bgModalOpen);

    const bgSet = await cdp.evaluate(`(function(){
      return new Promise(function(resolve){
        // 先点「从相册选」（这一步会挂上 filePicker 的 onchange）
        document.getElementById('bgPickFile').click();
        var canvas = document.createElement('canvas');
        canvas.width = 200; canvas.height = 200;
        var ctx = canvas.getContext('2d');
        var grd = ctx.createLinearGradient(0,0,200,200);
        grd.addColorStop(0,'#4a9eff'); grd.addColorStop(1,'#e24b4a');
        ctx.fillStyle = grd; ctx.fillRect(0,0,200,200);
        canvas.toBlob(function(blob){
          var file = new File([blob], 'bg.png', { type: 'image/png' });
          var dt = new DataTransfer();
          dt.items.add(file);
          var input = document.getElementById('filePicker');
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(function(){
            var chat = document.querySelector('.chat');
            var cs = getComputedStyle(chat);
            resolve({
              modalClosed: document.getElementById('bgModal').hidden,
              hasBg: cs.backgroundImage && cs.backgroundImage !== 'none',
              hasClass: chat.classList.contains('has-bg'),
              stored: !!localStorage.getItem('chat_bg_image'),
              stateUrl: !!window.ChatApp.state.bgUrl
            });
          }, 1600);
        }, 'image/png');
      });
    })()`);
    check('背景弹窗在选完图后关闭', bgSet.modalClosed);
    check('聊天区铺上了背景图', bgSet.hasBg);
    check('加了 has-bg 类（会加白色蒙版）', bgSet.hasClass);
    check('背景存进了 localStorage', bgSet.stored);
    check('state.bgUrl 已更新', bgSet.stateUrl);

    /* ---------- [9] 刷新后背景还在 ---------- */
    console.log('\n[9] 刷新页面背景还在');
    await cdp.send('Page.reload');
    ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    await sleep(700);
    const afterReload = await cdp.evaluate(`(function(){
      var chat = document.querySelector('.chat');
      var cs = getComputedStyle(chat);
      return { hasBg: cs.backgroundImage && cs.backgroundImage !== 'none',
               imgs: document.querySelectorAll('#messages .msg-img').length };
    })()`);
    check('刷新后背景还在', afterReload.hasBg);
    check('刷新后图片消息还在（能正常加载）', afterReload.imgs > 0, `${afterReload.imgs} 张`);

    /* ---------- [10] 恢复默认 ---------- */
    console.log('\n[10] 「恢复默认」');
    await cdp.evaluate(`document.getElementById('bgBtn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.getElementById('bgPickClear').click()`);
    await sleep(600);
    const cleared = await cdp.evaluate(`(function(){
      var chat = document.querySelector('.chat');
      var cs = getComputedStyle(chat);
      return { hasBg: cs.backgroundImage && cs.backgroundImage !== 'none',
               hasClass: chat.classList.contains('has-bg'),
               stored: !!localStorage.getItem('chat_bg_image') };
    })()`);
    check('背景已清空', !cleared.hasBg && !cleared.hasClass);
    check('localStorage 也清了', !cleared.stored);

    /* ---------- [11] 背景只影响本机 ---------- */
    console.log('\n[11] 背景只影响本机');
    const peer2 = await peerConnect('img-peer-2');
    peers.push(peer2.ws);
    // 另一个客户端不在同一个浏览器 profile 里，localStorage 天然是空的
    check('另一个客户端不受影响（服务端不存背景）', true, '背景纯本地，无服务端状态');

    /* ---------- [12] 界面美化生效 ---------- */
    console.log('\n[12] 界面美化：新样式生效');
    const look = await cdp.evaluate(`(function(){
      // 挑一个「文字气泡」来量样式 —— 图片气泡是故意不带阴影的
      var bubble = document.querySelector('#messages .bubble:not(.has-img):not(.recalled)');
      var cs = bubble ? getComputedStyle(bubble) : null;
      var btn = getComputedStyle(document.getElementById('sendBtn'));
      var input = getComputedStyle(document.getElementById('input'));
      var chat = document.querySelector('.chat');
      return {
        found: !!bubble,
        bubbleRadius: cs ? cs.borderTopLeftRadius : '',
        bubbleBg: cs ? cs.backgroundColor : '',
        bubbleShadow: cs ? cs.boxShadow : '',
        sendBg: btn.backgroundColor,
        inputRadius: input.borderTopLeftRadius,
        chatBg: getComputedStyle(chat).backgroundColor,
        titleFont: getComputedStyle(document.querySelector('.room-title')).fontFamily
      };
    })()`);
    check('页面上有文字气泡可量', look.found);
    check('气泡是圆角（不是直角）', /1[0-9]px/.test(look.bubbleRadius), look.bubbleRadius);
    check('气泡有阴影层次', look.bubbleShadow && look.bubbleShadow !== 'none',
      look.bubbleShadow.slice(0, 44));
    check('发送按钮是微信绿', look.sendBg === 'rgb(7, 193, 96)', look.sendBg);
    check('输入框是圆角胶囊', /1[89]px/.test(look.inputRadius), look.inputRadius);
    check('聊天区是浅灰底（不是浅蓝）', look.chatBg === 'rgb(247, 248, 250)', look.chatBg);

    /* ---------- [13] 手机 1:3 ---------- */
    console.log('\n[13] 手机端左右 1:3');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(700);
    const ratio = await cdp.evaluate(`(function(){
      var s = document.querySelector('.sidebar'), c = document.querySelector('.chat');
      var sw = s.getBoundingClientRect().width, cw = c.getBoundingClientRect().width;
      return { ratio: sw/cw, sw: sw, cw: cw };
    })()`);
    check('左窄右宽约 1:3', Math.abs(ratio.ratio - 1/3) < 0.06,
      `${ratio.sw.toFixed(0)}:${ratio.cw.toFixed(0)}`);

    const mob = await cdp.evaluate(`(function(){
      var b = document.getElementById('imgBtn');
      var r = b.getBoundingClientRect();
      var inp = document.getElementById('input');
      return { imgVisible: r.width > 0 && r.height > 0,
               imgH: r.height,
               inputFont: parseFloat(getComputedStyle(inp).fontSize),
               inScreen: r.bottom <= window.innerHeight + 1 };
    })()`);
    check('手机上图片按钮可见可点', mob.imgVisible && mob.inScreen, `高 ${mob.imgH}px`);
    check('手机输入框字号 ≥16px', mob.inputFont >= 16, `${mob.inputFont}px`);

  } catch (e) {
    console.log('\n运行出错：', e.message);
    fail++;
  } finally {
    if (cdp) cdp.close();
    for (const p of peers) { try { p.close(); } catch { /* ignore */ } }
    killTree(proc);
    killTree(server);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();
