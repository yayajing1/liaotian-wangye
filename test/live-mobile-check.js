'use strict';

/**
 * 线上手机版验收（一次性脚本，不属于测试套件）
 * 用真实 Edge + iPhone 12 尺寸打开线上地址，量一下比例并截图。
 *
 * 用法：node test/live-mobile-check.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const KEY = process.env.ROOM_KEY || 'fx1r08kn1ozr';
const URL = `https://8.222.185.143/chat#key=${KEY}`;
const CDP_PORT = 9367;
const OUT = path.join(ROOT, 'live-mobile-check.png');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); return; }
    catch { /* ignore */ }
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

(async () => {
  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge'); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-live-mobile-'));
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await cdp.send('Page.navigate', { url: URL });

    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    console.log('进到房间了：', ready);
    if (!ready) {
      const st = await cdp.evaluate(`(function(){
        return { conn: (document.getElementById('connText')||{}).textContent,
                 keyModal: !document.getElementById('keyModal').hidden };
      })()`);
      console.log('状态：', JSON.stringify(st));
    }

    const m = await cdp.evaluate(`(function(){
      var s = document.querySelector('.sidebar').getBoundingClientRect();
      var c = document.querySelector('.chat').getBoundingClientRect();
      return {
        vw: innerWidth, vh: innerHeight,
        sideW: Math.round(s.width), chatW: Math.round(c.width),
        ratio: +(s.width/c.width).toFixed(3),
        inputFont: getComputedStyle(document.getElementById('input')).fontSize,
        scrollW: document.documentElement.scrollWidth,
        members: document.getElementById('userList').children.length,
        meName: (document.getElementById('meName')||{}).textContent,
        settingsBtn: !!document.getElementById('settingsBtn'),
        loginBtn: !!document.getElementById('loginBtn'),
      };
    })()`);
    console.log('线上手机端量测：', JSON.stringify(m, null, 2));

    // 打开「登录设置」看看
    await cdp.evaluate("document.getElementById('settingsBtn').click()");
    await sleep(400);
    const st = await cdp.evaluate(`(function(){
      return { open: !document.getElementById('settingsModal').hidden,
               title: (document.getElementById('settingsTitle')||{}).textContent };
    })()`);
    console.log('登录设置面板：', JSON.stringify(st));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('截图 →', OUT);
  } catch (err) {
    console.error('出错了：', err.message);
  } finally {
    if (cdp) cdp.close();
    killTree(proc);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(0);
})();
