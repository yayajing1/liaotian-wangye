'use strict';

/**
 * 线上验收 —— 用真实浏览器打开线上地址，检查：
 *   1. 页面能打开、能连上房间
 *   2. 打开即自动弹出账号白框，且停在「选登入/注册」这一步
 *   3. 点「登入」才展开登入表单，点「注册」才展开注册表单（不同时出现）
 *   4. 「返回选择」能退回第一步
 *   5. 聊天区右上角有「清除记录」按钮
 *   6. 点「清除记录」弹出的确认框**没有被账号框盖住**
 *   7. 手机尺寸下左右 1:3 比例
 *   8. 线上原有数据还在（成员名 / 历史消息）
 *
 * 用法：node test/online-verify.js [url]
 * 默认 url = https://8.222.185.143/chat#key=<从 share-link.txt 读>
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const CDP_PORT = 9372;

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
  try {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* ignore */ }
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
    return r.result.value;
  }
}

function readUrl() {
  if (process.argv[2]) return process.argv[2];
  const f = path.join(ROOT, 'share-link.txt');
  const m = fs.readFileSync(f, 'utf8').match(/https?:\/\/[^\s#]+#key=[A-Za-z0-9]+/);
  return m ? m[0] : 'https://8.222.185.143/chat#key=tp4e97xq2cyq';
}

(async function main() {
  const URL = readUrl();
  console.log(`线上验收目标：${URL}\n`);

  // 网络可能时通时不通 —— 先等一个能通的窗口
  console.log('[0] 等待线上可连通…');
  let online = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(URL.split('#')[0], { signal: AbortSignal.timeout(6000) });
      if (r.status === 200) { online = true; console.log(`  连上了（第 ${i + 1} 次，HTTP ${r.status}）`); break; }
    } catch { /* 继续等 */ }
    await sleep(3000);
  }
  if (!online) { console.log('  一直连不上，退出。'); process.exit(1); }

  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) { console.log('找不到 Edge，退出。'); process.exit(0); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-online-'));
  const proc = spawn(edge, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--ignore-certificate-errors', 'about:blank',
  ], { stdio: 'ignore' });

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
    if (!target) throw new Error('连不上浏览器 CDP');
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

    /* ---------- [1] 桌面：页面能打开 ---------- */
    console.log('\n[1] 桌面尺寸（1440×900）');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url: URL });

    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      ready = await cdp.evaluate('!!(window.ChatApp && window.ChatApp.state.self)');
      if (ready) break;
    }
    check('进到了房间', ready);
    if (!ready) {
      const st = await cdp.evaluate('(window.ChatApp ? window.ChatApp.state : null)');
      console.log('   state =', JSON.stringify(st).slice(0, 300));
    }

    /* ---------- [2] 自动弹出账号框，停在选步 ---------- */
    console.log('\n[2] 打开即弹账号框（停在「选登入/注册」）');
    await sleep(600);
    const pick = await cdp.evaluate(`(function(){
      var m = document.getElementById('accountModal');
      var pick = document.getElementById('accStepPick');
      var login = document.getElementById('accStepLogin');
      var reg = document.getElementById('accStepReg');
      if (!m) return { missing: true };
      var btns = Array.prototype.map.call(
        document.querySelectorAll('#accStepPick .acc-pick-title'), function(e){ return e.textContent.trim(); });
      return {
        open: !m.hidden,
        pickShown: pick ? !pick.hidden : false,
        loginHidden: login ? login.hidden : null,
        regHidden: reg ? reg.hidden : null,
        picks: btns,
        inScreen: (function(){
          var r = m.querySelector('.modal').getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight + 1;
        })()
      };
    })()`);
    check('账号白框已自动弹出', pick.open && !pick.missing);
    check('停在第 1 步「选择」', pick.pickShown);
    check('「登入」「注册」两个都在', Array.isArray(pick.picks) && pick.picks.length === 2
      && pick.picks.includes('登入') && pick.picks.includes('注册'), JSON.stringify(pick.picks));
    check('此时没有展开任何表单', pick.loginHidden === true && pick.regHidden === true,
      `login.hidden=${pick.loginHidden} reg.hidden=${pick.regHidden}`);
    check('弹窗在屏幕内', pick.inScreen !== false);

    /* ---------- [3] 点「登入」→ 只展开登入表单 ---------- */
    console.log('\n[3] 点「登入」才展开登入表单');
    await cdp.evaluate(`document.getElementById('accPickLogin').click()`);
    await sleep(400);
    const stepLogin = await cdp.evaluate(`(function(){
      return {
        pickShown: !document.getElementById('accStepPick').hidden,
        loginShown: !document.getElementById('accStepLogin').hidden,
        regShown: !document.getElementById('accStepReg').hidden,
        hasPw: !!document.getElementById('accLoginPw')
      };
    })()`);
    check('登入表单出现', stepLogin.loginShown && stepLogin.hasPw);
    check('注册表单没出现', !stepLogin.regShown);
    check('选择页已隐藏', !stepLogin.pickShown);

    /* ---------- [4] 返回选择 → 点「注册」 ---------- */
    console.log('\n[4] 返回选择 → 点「注册」');
    await cdp.evaluate(`document.getElementById('accBackLogin').click()`);
    await sleep(300);
    const backOk = await cdp.evaluate(`!document.getElementById('accStepPick').hidden`);
    check('「返回选择」退回第 1 步', backOk);

    await cdp.evaluate(`document.getElementById('accPickReg').click()`);
    await sleep(400);
    const stepReg = await cdp.evaluate(`(function(){
      return {
        loginShown: !document.getElementById('accStepLogin').hidden,
        regShown: !document.getElementById('accStepReg').hidden,
        hasPw: !!document.getElementById('accRegPw') && !!document.getElementById('accRegPw2')
      };
    })()`);
    check('注册表单出现（含两次密码框）', stepReg.regShown && stepReg.hasPw);
    check('登入表单没出现', !stepLogin.loginShown || !stepReg.loginShown === false ? !stepReg.loginShown : true);

    /* ---------- [5] 清除记录按钮 ---------- */
    console.log('\n[5] 聊天区「清除记录」');
    const clearBtn = await cdp.evaluate(`(function(){
      var b = document.getElementById('clearHistBtn');
      if (!b) return { missing: true };
      var r = b.getBoundingClientRect();
      return { missing: false, visible: r.width > 0 && r.height > 0,
               text: b.textContent.trim(),
               inScreen: r.top >= 0 && r.bottom <= window.innerHeight + 1 };
    })()`);
    check('有「清除记录」按钮', !clearBtn.missing);
    check('按钮可见且在屏幕内', clearBtn.visible && clearBtn.inScreen !== false, clearBtn.text);

    /* ---------- [6] 确认框没被账号框盖住 ---------- */
    console.log('\n[6] 点「清除记录」→ 确认框在最上层');
    await cdp.evaluate(`document.getElementById('clearHistBtn').click()`);
    await sleep(500);
    const cover = await cdp.evaluate(`(function(){
      var m = document.getElementById('clearModal');
      if (!m || m.hidden) return { open: false };
      var box = m.querySelector('.modal');
      var r = box.getBoundingClientRect();
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      var hit = document.elementFromPoint(cx, cy);
      var inBox = !!(hit && (hit === box || box.contains(hit)));
      return { open: true, inBox: inBox,
               hitId: hit ? (hit.id || hit.className || hit.tagName) : 'null',
               title: (m.querySelector('.modal-title')||{}).textContent || '' };
    })()`);
    check('确认框已弹出', cover.open, cover.title);
    check('确认框没有被别的弹窗盖住', cover.inBox === true, `命中元素：${cover.hitId}`);

    // 关掉两个弹窗
    await cdp.evaluate(`(function(){
      var c = document.getElementById('clearCancel'); if (c) c.click();
      var a = document.getElementById('accCloseBtn'); if (a) a.click();
    })()`);
    await sleep(300);

    /* ---------- [7] 线上原有数据 ---------- */
    console.log('\n[7] 线上原有数据还在');
    const data = await cdp.evaluate(`(function(){
      var s = window.ChatApp.state;
      var users = Array.prototype.map.call(
        document.querySelectorAll('#userList .u-name'), function(e){ return e.textContent.trim(); });
      var msgs = Array.prototype.map.call(
        document.querySelectorAll('#messages .bubble'), function(e){ return e.textContent.trim(); });
      return { users: users, msgs: msgs,
               self: s.self ? s.self.name : null,
               total: s.messages.length };
    })()`);
    console.log('   成员：', JSON.stringify(data.users));
    console.log('   消息：', JSON.stringify(data.msgs.slice(0, 6)));
    check('有在线成员', data.users.length > 0, `${data.users.length} 人`);
    check('历史消息还在', data.msgs.length > 0, `${data.msgs.length} 条`);

    /* ---------- [8] 手机 1:3 ---------- */
    console.log('\n[8] 手机尺寸（390×844）左右比例');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(700);
    const ratio = await cdp.evaluate(`(function(){
      var s = document.querySelector('.sidebar'), c = document.querySelector('.chat');
      if (!s || !c) return { missing: true };
      var sw = s.getBoundingClientRect().width, cw = c.getBoundingClientRect().width;
      return { sw: sw, cw: cw, ratio: sw/cw, vw: window.innerWidth };
    })()`);
    check('左窄右宽约 1:3', Math.abs(ratio.ratio - 1/3) < 0.06,
      `${ratio.sw.toFixed(0)} : ${ratio.cw.toFixed(0)} = 1:${(ratio.cw/ratio.sw).toFixed(2)}`);

  } catch (e) {
    console.log('\n运行出错：', e.message);
    fail++;
  } finally {
    killTree(proc);
  }

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();
