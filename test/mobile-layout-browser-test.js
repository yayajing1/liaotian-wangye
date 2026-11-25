'use strict';

/**
 * 手机版布局 + 登录设置 —— 浏览器真实测试
 *
 * 验证：
 *   1. 左边（在线成员）:右边（聊天）= 1:3（手机和桌面都要成立）
 *   2. 手机上「在线成员」那一栏明显变窄（不再占掉半屏）
 *   3. 手机上输入框字号 ≥16px（否则 iOS 会自动放大页面）
 *   4. 手机上没有横向滚动条
 *   5. 输入区在屏幕内、不被键盘挤没
 *   6. 「登录设置」能设密码
 *   7. 「登录身份」能用昵称+密码把身份换回来
 *
 * 用法：node test/mobile-layout-browser-test.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8816;
const DATA_DIR = path.join(ROOT, 'data', 'test-mobile-layout');
const KEY = 'mobile-layout-key';
const CDP_PORT = 9366;
const OUT_MOBILE = path.join(ROOT, 'mobile-check.png');
const OUT_DESKTOP = path.join(ROOT, 'desktop-check.png');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch { /* ignore */ }
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
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 量一下当前布局 */
const MEASURE = `(function(){
  var side = document.querySelector('.sidebar');
  var chat = document.querySelector('.chat');
  var input = document.getElementById('input');
  var composer = document.querySelector('.composer');
  var users = document.getElementById('userList');
  var app = document.querySelector('.app');
  var sr = side.getBoundingClientRect();
  var cr = chat.getBoundingClientRect();
  var ir = input.getBoundingClientRect();
  var kr = composer.getBoundingClientRect();
  var ar = app.getBoundingClientRect();
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    sideW: sr.width,
    chatW: cr.width,
    ratio: sr.width / cr.width,
    appH: ar.height,
    inputFont: parseFloat(getComputedStyle(input).fontSize),
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    composerBottom: kr.bottom,
    composerTop: kr.top,
    inputVisible: ir.width > 0 && ir.height > 0,
    usersW: users.getBoundingClientRect().width,
    usersH: users.getBoundingClientRect().height,
    sideFont: parseFloat(getComputedStyle(document.querySelector('.room-title')).fontSize),
    sidePad: getComputedStyle(side).paddingLeft,
    msgFont: parseFloat(getComputedStyle(document.querySelector('.bubble') || document.body).fontSize),
  };
})()`;

(async () => {
  console.log('\n=== 手机版布局 + 登录设置（浏览器）测试 ===\n');

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
    await sleep(200);
    if (out.includes('聊天室已启动')) { up = true; break; }
  }
  if (!up) { console.log('服务端没起来：\n' + out); process.exit(1); }

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge，跳过'); server.kill(); process.exit(0); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-mobile-'));
  const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
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

    /* ================= [1] 手机尺寸 ================= */
    console.log('[1] 手机尺寸（iPhone 12：390×844）');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/chat#key=${KEY}` });

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('进到了房间', ready);

    const m = await cdp.evaluate(MEASURE);
    console.log(`    视口 ${m.vw}×${m.vh}｜左 ${m.sideW.toFixed(0)}px ｜右 ${m.chatW.toFixed(0)}px ｜比例 ${m.ratio.toFixed(3)}`);

    check('左右比例接近 1:3', Math.abs(m.ratio - 1 / 3) < 0.03, m.ratio.toFixed(3));
    check('左边（在线成员）明显变窄了', m.sideW < 120, `${m.sideW.toFixed(0)}px`);
    check('右边（聊天）占了大部分', m.chatW / m.vw > 0.7, `${(m.chatW / m.vw * 100).toFixed(0)}%`);
    check('输入框字号 ≥16px（iOS 才不会自动放大）', m.inputFont >= 16, `${m.inputFont}px`);
    check('没有横向滚动', m.scrollW <= m.vw + 1, `scrollWidth=${m.scrollW} vw=${m.vw}`);
    check('输入区在屏幕内', m.composerBottom <= m.vh + 2, `bottom=${m.composerBottom.toFixed(0)} vh=${m.vh}`);
    check('输入框可见', m.inputVisible === true);
    check('成员列表还在（没被藏掉）', m.usersW > 0 && m.usersH > 0,
      `${m.usersW.toFixed(0)}×${m.usersH.toFixed(0)}`);
    check('页面高度铺满可视区', Math.abs(m.appH - m.vh) < 4, `app=${m.appH.toFixed(0)} vh=${m.vh}`);

    console.log('\n[1b] 手机上发一条长消息，看会不会溢出');
    await cdp.evaluate(`(function(){
      var i = document.getElementById('input');
      i.value = '这是一条很长的消息用来测试气泡在窄屏上会不会撑破或者被切掉，本聊天室支持换行和引用回复功能。';
      document.getElementById('sendBtn').click();
    })()`);
    await sleep(700);
    const bubble = await cdp.evaluate(`(function(){
      var b = document.querySelector('.msg.self .bubble');
      if (!b) return { ok: false, why: '没找到自己的气泡' };
      var r = b.getBoundingClientRect();
      var c = document.querySelector('.chat').getBoundingClientRect();
      return {
        ok: true, left: r.left, right: r.right, w: r.width,
        chatLeft: c.left, chatRight: c.right, chatW: c.width,
        overflowLeft: c.left - r.left,
        overflowRight: r.right - c.right,
      };
    })()`);
    check('长消息渲染出来了', bubble.ok === true, bubble.why || '');
    check('气泡没超出聊天区右边', bubble.ok && bubble.overflowRight <= 1,
      `溢出 ${(bubble.overflowRight || 0).toFixed(1)}px`);
    check('气泡没超出聊天区左边', bubble.ok && bubble.overflowLeft <= 1,
      `溢出 ${(bubble.overflowLeft || 0).toFixed(1)}px`);
    check('气泡宽度不超过聊天区的 85%', bubble.ok && bubble.w <= bubble.chatW * 0.85,
      `${bubble.w.toFixed(0)} / ${bubble.chatW.toFixed(0)}`);

    const ph = await cdp.evaluate("document.getElementById('input').placeholder");
    check('手机上提示文字换短了（不会折行撑高输入框）', ph === '说点什么…', ph);

    const shotM = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT_MOBILE, Buffer.from(shotM.data, 'base64'));
    console.log(`    截图 → ${OUT_MOBILE}`);

    /* ================= [2] 桌面尺寸 ================= */
    console.log('\n[2] 桌面尺寸（1440×900）');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);
    const d = await cdp.evaluate(MEASURE);
    console.log(`    视口 ${d.vw}×${d.vh}｜左 ${d.sideW.toFixed(0)}px ｜右 ${d.chatW.toFixed(0)}px ｜比例 ${d.ratio.toFixed(3)}`);
    check('桌面左右比例也是 1:3', Math.abs(d.ratio - 1 / 3) < 0.03, d.ratio.toFixed(3));
    check('桌面没有横向滚动', d.scrollW <= d.vw + 1, `scrollWidth=${d.scrollW}`);
    check('桌面输入框不被放大（保持原样）', d.inputFont >= 13 && d.inputFont < 16, `${d.inputFont}px`);

    const shotD = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT_DESKTOP, Buffer.from(shotD.data, 'base64'));
    console.log(`    截图 → ${OUT_DESKTOP}`);

    /* ================= [3] 登录设置：设密码 ================= */
    console.log('\n[3] 登录设置 → 设置密码');
    await cdp.evaluate("document.getElementById('settingsBtn').click()");
    await sleep(300);
    const st1 = await cdp.evaluate(`(function(){
      return {
        open: !document.getElementById('settingsModal').hidden,
        setView: !document.getElementById('pwViewSet').hidden,
        set2View: !document.getElementById('pwViewSet2').hidden,
        title: (document.getElementById('settingsTitle')||{}).textContent || '',
      };
    })()`);
    check('设置面板弹出来了', st1.open === true);
    check('标题是「登录设置」', /登录设置/.test(st1.title), st1.title);
    check('默认显示「第一次设密码」这一屏', st1.setView === true && st1.set2View === false);

    // 两次不一样 → 应该报错，不该发出去
    await cdp.evaluate("document.getElementById('pwSet1').value='abcd';"
      + "document.getElementById('pwSet2').value='abce';"
      + "document.getElementById('pwSave').click();");
    await sleep(300);
    const errShown = await cdp.evaluate(`(function(){
      var e = document.getElementById('settingsErr');
      return { hidden: e.hidden, text: e.textContent || '' };
    })()`);
    check('两次密码不一致 → 提示错误', errShown.hidden === false && /不一样/.test(errShown.text), errShown.text);

    // 输对了 → 保存
    await cdp.evaluate("document.getElementById('pwSet1').value='mypw1234';"
      + "document.getElementById('pwSet2').value='mypw1234';"
      + "document.getElementById('pwSave').click();");
    await sleep(800);
    const st2 = await cdp.evaluate(`(function(){
      return {
        set: window.ChatApp.state.loginSet,
        set2View: !document.getElementById('pwViewSet2').hidden,
        state: (document.querySelector('.pw-state')||{}).textContent || '',
        pw1: document.getElementById('pwSet1').value,
      };
    })()`);
    check('密码设成功了', st2.set === true, `loginSet=${st2.set}`);
    check('面板切到「已设置」', st2.set2View === true, st2.state.trim());
    check('密码输入框被清空了（不留明文）', st2.pw1 === '', `"${st2.pw1}"`);

    /* ================= [4] 登录身份 ================= */
    console.log('\n[4] 登录身份 → 换设备登录');
    const myName = await cdp.evaluate('window.ChatApp.state.self.name');

    // 清掉本机身份，模拟「换了一台设备」
    // ⚠️ 必须用 Page.reload —— 导航到同一个 URL（只是 hash 相同）
    //    浏览器会当成「同文档跳转」，页面根本不刷新，localStorage 也白清了。
    await cdp.evaluate("try{localStorage.removeItem('chat_client_id');}catch(e){}");
    await cdp.send('Page.reload', { ignoreCache: true });
    let ready2 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready2 = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready2) break;
    }
    check('新设备进来了（拿到临时昵称）', ready2);
    const tempName = await cdp.evaluate('window.ChatApp.state.self.name');
    check('临时昵称和原来不一样', tempName !== myName, `${tempName} vs ${myName}`);

    await cdp.evaluate("document.getElementById('loginBtn').click()");
    await sleep(300);
    const lg1 = await cdp.evaluate(`(function(){
      return {
        open: !document.getElementById('loginModal').hidden,
        title: (document.getElementById('loginTitle')||{}).textContent || '',
      };
    })()`);
    check('登录面板弹出来了', lg1.open === true);
    check('标题是「登录身份」', /登录身份/.test(lg1.title), lg1.title);

    // 密码错 → 报错
    await cdp.evaluate(`(function(){
      document.getElementById('loginName').value = ${JSON.stringify(myName)};
      document.getElementById('loginPw').value = 'wrongpass';
      document.getElementById('loginOk').click();
    })()`);
    await sleep(800);
    const lgErr = await cdp.evaluate(`(function(){
      var e = document.getElementById('loginErr');
      return { hidden: e.hidden, text: e.textContent || '', name: window.ChatApp.state.self.name };
    })()`);
    check('密码错 → 提示错误', lgErr.hidden === false && /不对/.test(lgErr.text), lgErr.text);
    check('密码错 → 身份没变', lgErr.name === tempName, lgErr.name);

    // 密码对 → 换回来
    await cdp.evaluate(`(function(){
      document.getElementById('loginName').value = ${JSON.stringify(myName)};
      document.getElementById('loginPw').value = 'mypw1234';
      document.getElementById('loginOk').click();
    })()`);
    await sleep(1200);
    const lg2 = await cdp.evaluate(`(function(){
      return {
        name: window.ChatApp.state.self.name,
        open: !document.getElementById('loginModal').hidden,
        loginSet: window.ChatApp.state.loginSet,
      };
    })()`);
    check('身份换回来了', lg2.name === myName, `${lg2.name} vs ${myName}`);
    check('登录面板自动关掉', lg2.open === false);
    check('换回来后密码状态也跟着回来了', lg2.loginSet === true, `loginSet=${lg2.loginSet}`);

    /* ================= [5] 手机上弹窗能用 ================= */
    console.log('\n[5] 手机上弹窗不超出屏幕');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await sleep(400);
    await cdp.evaluate("document.getElementById('settingsBtn').click()");
    await sleep(300);
    const modalBox = await cdp.evaluate(`(function(){
      var m = document.querySelector('#settingsModal .modal');
      var r = m.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: window.innerWidth, vh: window.innerHeight };
    })()`);
    check('弹窗在屏幕内（上下左右都没出界）',
      modalBox.top >= -1 && modalBox.bottom <= modalBox.vh + 1
      && modalBox.left >= -1 && modalBox.right <= modalBox.vw + 1,
      JSON.stringify(modalBox));
    check('弹窗宽度没超出手机屏', modalBox.right - modalBox.left <= modalBox.vw,
      `${(modalBox.right - modalBox.left).toFixed(0)} / ${modalBox.vw}`);

  } catch (err) {
    fail++;
    console.error('  ✗ 测试炸了：', err);
  } finally {
    if (cdp) cdp.close();
    killTree(proc);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    try { server.kill(); } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})();
