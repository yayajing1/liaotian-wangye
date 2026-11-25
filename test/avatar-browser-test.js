'use strict';

/**
 * 换头像 —— 浏览器真实交互测试
 *
 * 验证页面上真的能走通这条路径：
 *   点自己的头像 → 弹出调色板 → 点一个颜色 → 弹出「是否确定修改？」→
 *   取消（不该改）→ 再来一次 → 确定修改（真的改了）
 *   另外回归一下改名（点「点击改名」还能用）
 *
 * 用法：node test/avatar-browser-test.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8810;
const DATA_DIR = path.join(ROOT, 'data', 'test-avatar-browser');
const KEY = 'browser-avatar-key';
const CDP_PORT = 9361;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  (' + detail + ')' : ''}`); }
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
  console.log('\n=== 换头像（浏览器交互）测试 ===\n');

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

  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-avatar-'));
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
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/chat#key=${KEY}` });

    // 等进房间
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('进到了房间', ready);

    const self = await cdp.evaluate('JSON.stringify(window.ChatApp.state.self)');
    const selfObj = JSON.parse(self);
    console.log(`  当前身份：${selfObj.name} / ${selfObj.color}`);

    console.log('\n[1] 点自己的头像 → 调色板');
    await cdp.evaluate("document.getElementById('meAvatar').click()");
    await sleep(300);
    const picker = await cdp.evaluate(`(function(){
      var m = document.getElementById('avatarModal');
      var dots = document.getElementById('colorGrid').children.length;
      return {open: !!(m && !m.hidden), dots: dots};
    })()`);
    check('调色板弹出来了', picker.open === true);
    check('里面有 24 个颜色可选', picker.dots === 24, `${picker.dots} 个`);

    console.log('\n[2] 点一个颜色 → 弹「是否确定修改？」');
    const targetColor = await cdp.evaluate(`(function(){
      var grid = document.getElementById('colorGrid');
      for (var i = 0; i < grid.children.length; i++) {
        var c = grid.children[i].getAttribute('title');
        if (c !== window.ChatApp.state.self.color) { grid.children[i].click(); return c; }
      }
      return null;
    })()`);
    await sleep(300);
    const confirm = await cdp.evaluate(`(function(){
      var m = document.getElementById('avatarConfirm');
      var title = document.getElementById('avatarConfirmTitle');
      return {
        open: !!(m && !m.hidden),
        title: title ? title.textContent : '',
        previewColor: (document.getElementById('avatarPreview')||{}).style.background || '',
      };
    })()`);
    check('确认框弹出来了', confirm.open === true);
    check('标题是「是否确定修改？」', /是否确定修改/.test(confirm.title), confirm.title);
    check('预览显示的是选中的颜色', /rgb|#[0-9a-f]{6}/i.test(confirm.previewColor), confirm.previewColor);

    console.log('\n[3] 选「再想想」→ 不该改');
    await cdp.evaluate("document.getElementById('avatarConfirmCancel').click()");
    await sleep(300);
    const afterCancel = await cdp.evaluate(`(function(){
      return {
        confirmOpen: !document.getElementById('avatarConfirm').hidden,
        pickerOpen: !document.getElementById('avatarModal').hidden,
        color: window.ChatApp.state.self.color,
      };
    })()`);
    check('确认框关掉了', afterCancel.confirmOpen === false);
    check('调色板还开着（可以再挑一个颜色）', afterCancel.pickerOpen === true);
    check('颜色没变', afterCancel.color === selfObj.color, afterCancel.color);

    console.log('\n[4] 再来一次 → 确定修改');
    await cdp.evaluate("document.getElementById('meAvatar').click()");
    await sleep(250);
    await cdp.evaluate(`(function(){
      var grid = document.getElementById('colorGrid');
      for (var i = 0; i < grid.children.length; i++) {
        var c = grid.children[i].getAttribute('title');
        if (c !== window.ChatApp.state.self.color) { grid.children[i].click(); return; }
      }
    })()`);
    await sleep(250);
    await cdp.evaluate("document.getElementById('avatarConfirmOk').click()");
    await sleep(900);
    const after = await cdp.evaluate(`(function(){
      return {
        color: window.ChatApp.state.self.color,
        bg: document.getElementById('meAvatar').style.background,
        confirmOpen: !document.getElementById('avatarConfirm').hidden,
        pickerOpen: !document.getElementById('avatarModal').hidden,
      };
    })()`);
    check('颜色真的改了', after.color !== selfObj.color, `${selfObj.color} → ${after.color}`);
    check('侧栏头像跟着变了', /rgb|#[0-9a-f]{6}/i.test(after.bg), after.bg);
    check('两个弹窗都关掉了', after.confirmOpen === false && after.pickerOpen === false);

    console.log('\n[5] 回归：改名照旧能用');
    await cdp.evaluate("document.getElementById('nickBtn').click()");
    await sleep(250);
    const hasInput = await cdp.evaluate("!!document.querySelector('.rename-input')");
    check('点「点击改名」出现输入框', hasInput === true);
    await cdp.evaluate(`(function(){
      var i = document.querySelector('.rename-input');
      i.value = '阿改';
      i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await sleep(800);
    const renamed = await cdp.evaluate("window.ChatApp.state.self.name");
    check('改名生效', renamed === '阿改', renamed);

  } catch (err) {
    fail++;
    console.log('  ✗ 测试异常：' + err.message);
    console.log(out.slice(-1200));
  } finally {
    if (cdp) cdp.close();
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    server.kill();
  }

  console.log(`\n通过 ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})();
