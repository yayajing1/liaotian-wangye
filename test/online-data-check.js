'use strict';

/**
 * 线上数据核对 —— 通过 WebSocket（走 443）读取服务端真实状态。
 *
 * 不用 SSH 的原因：本地家宽到新加坡跨境链路丢包严重（ping 16% 丢包、
 * 耗时 106~2421ms 波动），SSH 的 TCP 握手经常完不成；而 443 的 TLS
 * 短连接重试十几次总能成一次，WebSocket 握手也一样。
 *
 * 核对项：
 *   1. 服务端版本（init 里的字段）
 *   2. 在线成员列表
 *   3. 历史消息条数与内容
 *   4. 账号系统是否在线（accountInfo）
 *   5. 昵称去重是否生效
 *
 * 用法：node test/online-data-check.js [url]
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readUrl() {
  if (process.argv[2]) return process.argv[2];
  const f = path.join(ROOT, 'share-link.txt');
  const m = fs.readFileSync(f, 'utf8').match(/https?:\/\/[^\s#]+#key=[A-Za-z0-9]+/);
  return m ? m[0] : 'https://8.222.185.143/chat#key=tp4e97xq2cyq';
}

function wsUrl(httpUrl) {
  const u = new URL(httpUrl);
  const key = (u.hash.match(/key=([A-Za-z0-9]+)/) || [])[1] || '';
  u.hash = '';
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  const q = `?cid=online-check-${Date.now()}&key=${key}`;
  return u.toString() + q;
}

function connect(url, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,     // IP 证书，握手阶段先放过
      handshakeTimeout: 20000,
    });
    const msgs = [];
    let init = null;

    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'accountInfo' }));
    });
    ws.on('message', (raw) => {
      let d;
      try { d = JSON.parse(raw.toString()); } catch { return; }
      if (d.t === 'init') { init = d; }
      msgs.push(d);
    });
    ws.on('error', (e) => reject(new Error(`${label}: ${e.message}`)));
    ws.on('close', () => {
      if (init) resolve({ ws, init, msgs });
      else reject(new Error(`${label}: 连上了但没收到 init`));
    });
    setTimeout(() => {
      if (init) { try { ws.close(); } catch { /* ignore */ } }
    }, 6000);
  });
}

(async function main() {
  const URL = readUrl();
  const target = wsUrl(URL);
  console.log(`线上数据核对：${URL}\n`);

  console.log('[0] 尝试建立 WebSocket（最多 25 次）…');
  let r = null, lastErr = '';
  for (let i = 1; i <= 25 && !r; i++) {
    try {
      r = await connect(target, `第 ${i} 次`);
      console.log(`  第 ${i} 次连上了 ✅`);
    } catch (e) {
      lastErr = e.message;
      console.log(`  第 ${i} 次失败：${e.message}`);
      await sleep(4000);
    }
  }
  if (!r) { console.log('\n始终连不上：', lastErr); process.exit(1); }

  const { init, msgs } = r;
  console.log('\n===== [1] init 返回的字段 =====');
  console.log('  字段名：', Object.keys(init).join(', '));

  console.log('\n===== [2] 在线成员 =====');
  const users = init.users || [];
  users.forEach((u) => {
    console.log(`  - ${u.name}${u.color ? '  颜色=' + u.color : ''}${u.avatar ? '  有头像' : ''}`);
  });
  console.log(`  共 ${users.length} 人在线`);

  console.log('\n===== [3] 历史消息 =====');
  const hist = init.history || [];
  const real = hist.filter((m) => m.kind !== 'system');
  console.log(`  总条数 ${hist.length}，其中真实消息 ${real.length} 条`);
  real.forEach((m) => {
    console.log(`  - [${new Date(m.ts).toLocaleString('zh-CN')}] ${m.from ? m.from.name : '?'}：${m.text}`);
  });
  const sys = hist.filter((m) => m.kind === 'system');
  if (sys.length) console.log(`  （另有 ${sys.length} 条系统提示）`);

  console.log('\n===== [4] 账号系统 =====');
  const acc = msgs.find((m) => m.t === 'accountInfo' || m.t === 'accountAck');
  if (acc) console.log('  ' + JSON.stringify(acc).slice(0, 300));
  else console.log('  没收到账号信息回执');

  console.log('\n===== [5] 昵称去重 =====');
  const names = users.map((u) => u.name);
  console.log('  在线昵称：', JSON.stringify(names));

  console.log('\n===== 结论 =====');
  console.log(`  在线 ${users.length} 人 / 历史真实消息 ${real.length} 条`);
  console.log(`  历史消息内容：${real.map((m) => m.text).join(' | ')}`);
  process.exit(0);
})();
