'use strict';

/**
 * 账号白框弹窗 —— 浏览器真实测试
 *
 * 验证：
 *   1. 侧栏有「注册账号」入口
 *   2. 弹出来是**白框**（白色背景 + 细边框）
 *   3. 上面是「登入」框、下面是「注册」框，两个都在屏幕上
 *   4. 两个按钮都在（登入 + 注册）
 *   5. 登入框在注册框**上面**（垂直位置）
 *   6. 注册 → 身份不变、昵称不变、token 存下来了
 *   7. 登入 → 换设备后能把身份认回来
 *   8. 弱密码在前端就被拦下（不发请求）
 *   9. 登录后侧栏按钮显示账号名
 *  10. 手机尺寸下弹窗不溢出屏幕、能滚动
 *
 * 用法：node test/account-modal-browser-test.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8818;
const DATA_DIR = path.join(ROOT, 'data', 'test-account-modal');
const KEY = 'account-modal-key';
const CDP_PORT = 9368;
const OUT = path.join(ROOT, 'account-modal-check.png');
const OUT_MOBILE = path.join(ROOT, 'account-modal-mobile-check.png');

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

/** 量白框弹窗的布局 */
const MEASURE_MODAL = `(function(){
  var modal = document.querySelector('.modal-account');
  var mask = document.getElementById('accountModal');
  if (!modal || mask.hidden) return { hidden: true };
  var mr = modal.getBoundingClientRect();
  var cs = getComputedStyle(modal);
  var boxes = document.querySelectorAll('#accountModal .acc-box');
  var loginBox = boxes[0], regBox = boxes[1];
  var lr = loginBox.getBoundingClientRect();
  var rr = regBox.getBoundingClientRect();
  var loginBtn = document.getElementById('accLoginBtn');
  var regBtn = document.getElementById('accRegBtn');
  var br1 = loginBtn.getBoundingClientRect();
  var br2 = regBtn.getBoundingClientRect();
  return {
    hidden: false,
    bg: cs.backgroundColor,
    border: cs.borderTopWidth,
    borderStyle: cs.borderTopStyle,
    top: mr.top, bottom: mr.bottom, h: mr.height, w: mr.width,
    vh: window.innerHeight, vw: window.innerWidth,
    loginTitle: (loginBox.querySelector('.acc-box-title') || {}).textContent,
    regTitle: (regBox.querySelector('.acc-box-title') || {}).textContent,
    loginBoxTop: lr.top, regBoxTop: rr.top,
    loginBoxVisible: lr.height > 0 && lr.width > 0,
    regBoxVisible: rr.height > 0 && rr.width > 0,
    loginBtnText: loginBtn.textContent.trim(),
    regBtnText: regBtn.textContent.trim(),
    loginBtnVisible: br1.width > 0 && br1.height > 0 && br1.bottom <= window.innerHeight + 1,
    regBtnVisible: br2.width > 0 && br2.height > 0 && br2.bottom <= window.innerHeight + 1,
    scrollable: modal.scrollHeight > modal.clientHeight,
    modalScrollH: modal.scrollHeight,
    modalClientH: modal.clientHeight,
    inputFont: parseFloat(getComputedStyle(document.getElementById('accLoginName')).fontSize),
  };
})()`;

(async () => {
  console.log('\n=== 账号白框弹窗（浏览器）测试 ===\n');

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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-acct-'));
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

    /* ================= [1] 桌面尺寸 ================= */
    console.log('[1] 桌面尺寸（1440×900）');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/chat#key=${KEY}` });

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('进到了房间', ready);

    // 侧栏入口
    const btn = await cdp.evaluate(`(function(){
      var b = document.getElementById('accountBtn');
      if (!b) return { ok: false };
      var t = document.getElementById('accountBtnTxt');
      return { ok: true, text: t ? t.textContent : '', visible: b.getBoundingClientRect().width > 0 };
    })()`);
    check('侧栏有账号入口', btn.ok === true, btn.why || '');
    check('入口按钮可见', btn.visible === true);
    check('未登录时显示「注册账号」', /注册/.test(btn.text || ''), btn.text);

    /* ================= [2] 打开白框 ================= */
    console.log('\n[2] 白框弹窗');
    await cdp.evaluate("document.getElementById('accountBtn').click()");
    await sleep(400);

    const m = await cdp.evaluate(MEASURE_MODAL);
    check('弹窗打开了', m.hidden === false);
    check('是白框（白色背景）', /255,\s*255,\s*255/.test(m.bg || ''), m.bg);
    check('白框有细边框', parseFloat(m.border) >= 1 && m.borderStyle === 'solid',
      `${m.border} ${m.borderStyle}`);
    check('上面是「登入」框', (m.loginTitle || '').indexOf('登入') >= 0, m.loginTitle);
    check('下面是「注册」框', (m.regTitle || '').indexOf('注册') >= 0, m.regTitle);
    check('登入框可见', m.loginBoxVisible === true);
    check('注册框可见', m.regBoxVisible === true);
    check('登入框在注册框上面', m.loginBoxTop < m.regBoxTop,
      `登入 top=${m.loginBoxTop.toFixed(0)} 注册 top=${m.regBoxTop.toFixed(0)}`);
    check('有两个按钮：登入 + 注册',
      m.loginBtnText === '登入' && m.regBtnText === '注册',
      `${m.loginBtnText} / ${m.regBtnText}`);
    check('两个按钮都在屏幕内', m.loginBtnVisible && m.regBtnVisible);
    check('弹窗没有超出屏幕', m.top >= -1 && m.bottom <= m.vh + 1,
      `top=${m.top.toFixed(0)} bottom=${m.bottom.toFixed(0)} vh=${m.vh}`);

    // 截图
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

    /* ================= [3] 弱密码前端拦截 ================= */
    console.log('\n[3] 弱密码前端拦截');
    const weakRes = await cdp.evaluate(`(function(){
      document.getElementById('accRegName').value = 'testuser';
      document.getElementById('accRegPw').value = 'abc';
      document.getElementById('accRegPw2').value = 'abc';
      document.getElementById('accRegBtn').click();
      var e = document.getElementById('accRegErr');
      return { hidden: e.hidden, msg: e.textContent };
    })()`);
    check('太短的密码被前端拦下', weakRes.hidden === false, weakRes.msg);
    check('提示留在注册框里', /8 位/.test(weakRes.msg || ''), weakRes.msg);

    const mismatch = await cdp.evaluate(`(function(){
      document.getElementById('accRegPw').value = 'goodpw123';
      document.getElementById('accRegPw2').value = 'different123';
      document.getElementById('accRegBtn').click();
      var e = document.getElementById('accRegErr');
      return { hidden: e.hidden, msg: e.textContent };
    })()`);
    check('两次密码不一致被前端拦下', mismatch.hidden === false, mismatch.msg);

    /* ================= [4] 注册 ================= */
    console.log('\n[4] 注册');
    const before = await cdp.evaluate('JSON.stringify({id: window.ChatApp.state.self.id, name: window.ChatApp.state.self.name})');
    const beforeObj = JSON.parse(before);

    await cdp.evaluate(`(function(){
      document.getElementById('accRegName').value = 'testuser';
      document.getElementById('accRegPw').value = 'goodpw123';
      document.getElementById('accRegPw2').value = 'goodpw123';
      document.getElementById('accRegBtn').click();
    })()`);
    await sleep(900);

    const afterReg = await cdp.evaluate(`(function(){
      return JSON.stringify({
        registered: window.ChatApp.state.registered,
        username: window.ChatApp.state.username,
        token: window.ChatApp.getToken(),
        modalHidden: document.getElementById('accountModal').hidden,
        btnTxt: document.getElementById('accountBtnTxt').textContent,
        selfId: window.ChatApp.state.self.id,
        selfName: window.ChatApp.state.self.name,
      });
    })()`);
    const reg = JSON.parse(afterReg);
    check('注册成功（状态变了）', reg.registered === true);
    check('账号名记住了', reg.username === 'testuser', reg.username);
    check('会话 token 存到 localStorage', typeof reg.token === 'string' && reg.token.length >= 32,
      reg.token ? `${reg.token.length} 位` : '没有');
    check('注册后弹窗关掉了', reg.modalHidden === true);
    check('侧栏按钮显示账号名', /testuser/.test(reg.btnTxt || ''), reg.btnTxt);
    check('注册后身份没变', reg.selfId === beforeObj.id, reg.selfId);
    check('注册后昵称没变', reg.selfName === beforeObj.name, reg.selfName);

    /* ================= [5] 换设备登入 ================= */
    console.log('\n[5] 换设备登入');
    // 清掉本机身份，模拟「换了台设备」
    await cdp.evaluate("try{localStorage.removeItem('chat_client_id');}catch(e){}");
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/chat#key=${KEY}` });
    let ready2 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready2 = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready2) break;
    }
    check('新设备进来了', ready2);

    // token 还在 → 应该直接认回身份，不用再输密码
    const auto = await cdp.evaluate(`JSON.stringify({
      selfId: window.ChatApp.state.self.id,
      selfName: window.ChatApp.state.self.name,
      registered: window.ChatApp.state.registered,
      sessionOk: window.ChatApp.state.self ? true : false,
    })`);
    const autoObj = JSON.parse(auto);
    check('带 token 自动认回身份（不用再输密码）', autoObj.selfId === beforeObj.id,
      `${autoObj.selfId} vs ${beforeObj.id}`);
    check('昵称也是原来的', autoObj.selfName === beforeObj.name, autoObj.selfName);
    check('状态显示已注册', autoObj.registered === true);

    /* ================= [6] 手机尺寸 ================= */
    console.log('\n[6] 手机尺寸（iPhone 12：390×844）');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/chat#key=${KEY}` });
    let ready3 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready3 = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready3) break;
    }
    check('手机上也能进房间', ready3);

    await cdp.evaluate("window.ChatApp.openAccount()");
    await sleep(400);

    const mm = await cdp.evaluate(MEASURE_MODAL);
    check('手机上弹窗打开了', mm.hidden === false);
    check('手机上宽度没超出屏幕', mm.w <= mm.vw + 1, `${mm.w.toFixed(0)} / ${mm.vw}`);
    check('手机上能滚动（内容高就滚）', mm.scrollable === true,
      `scrollH=${mm.modalScrollH} clientH=${mm.modalClientH}`);
    check('手机上输入框字号 ≥16px', mm.inputFont >= 16, `${mm.inputFont}px`);
    check('手机上两个框都还在', mm.loginBoxVisible && mm.regBoxVisible);

    const shotM = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT_MOBILE, Buffer.from(shotM.data, 'base64'));
  } catch (err) {
    fail++;
    console.log('\n  ✗ 测试异常：' + (err && err.stack ? err.stack : err));
  } finally {
    if (cdp) cdp.close();
    killTree(proc);
    try { server.kill(); } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})();
