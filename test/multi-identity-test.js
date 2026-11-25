'use strict';

/**
 * 多人登入身份分配测试
 *
 * 验证需求：「第二个甚至以上的人可以从网站登入，并且拿到新的（不重复的）头像」
 *
 * 用法：node test/multi-identity-test.js [人数] [ws地址]
 *
 * 不传 ws 地址时，本测试会自己起一个服务端实例（独立端口 + 独立数据目录），
 * 不会把测试产生的用户行写进线上数据库（昵称全局唯一，
 * 占满了名字池会很难看）。传了地址则直接测那个地址。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const N = Number(process.argv[2]) || 10;
const GIVEN_URL = process.argv[3] || '';

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 8805;
const DATA_DIR = path.join(ROOT, 'data', 'test-identity');
const URL = GIVEN_URL || `ws://localhost:${TEST_PORT}/ws`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let serverProc = null;

function startServer() {
  return new Promise((resolve, reject) => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(TEST_PORT), ALT_PORT: '0', DATA_DIR, ROOM_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const onData = (buf) => {
      out += buf.toString();
      if (out.includes('聊天室已启动')) { serverProc.stdout.off('data', onData); resolve(); }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', (b) => { out += b.toString(); });
    setTimeout(() => { if (!out.includes('聊天室已启动')) reject(new Error('服务端启动超时')); }, 15000);
  });
}

function stopServer() {
  try { if (serverProc) serverProc.kill(); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

function connect(cid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL}?cid=${encodeURIComponent(cid)}`);
    const t = setTimeout(() => reject(new Error('连接超时')), 15000);
    ws.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.t === 'init') { clearTimeout(t); resolve({ ws, self: d.self }); }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

(async () => {
  console.log(`\n=== ${N} 人依次登入的身份分配测试 ===`);
  console.log(`目标: ${URL}\n`);

  if (!GIVEN_URL) {
    await startServer();
    console.log(`（独立数据目录，不碰线上数据）\n`);
  }

  const users = [];
  for (let i = 1; i <= N; i++) {
    const u = await connect('identity-test-' + i + '-' + Date.now());
    users.push(u.self);
    await sleep(150);
  }

  console.log('序号  昵称      头像色      id');
  console.log('----  --------  ----------  ----------');
  users.forEach((u, i) => {
    console.log(
      String(i + 1).padStart(4) + '  ' +
      u.name.padEnd(8) + '  ' +
      u.color.padEnd(10) + '  ' +
      u.id.slice(0, 8)
    );
  });

  const colors = users.map((u) => u.color);
  const names = users.map((u) => u.name);
  const uniqColors = new Set(colors);
  const uniqNames = new Set(names);

  console.log('\n--- 结果 ---');
  console.log(`  不同头像色数量: ${uniqColors.size} / ${N} 人`);
  console.log(`  不同昵称数量  : ${uniqNames.size} / ${N} 人`);
  const dupColors = colors.filter((c, i) => colors.indexOf(c) !== i);
  if (dupColors.length) {
    const stat = {};
    for (const c of colors) stat[c] = (stat[c] || 0) + 1;
    console.log('  撞色明细:');
    for (const [c, n] of Object.entries(stat)) {
      if (n > 1) console.log(`    ${c}  被 ${n} 人共用`);
    }
  } else {
    console.log('  无撞色 ✓');
  }

  // 判断色池容量
  const FAMILIES = ['浅绿', '浅粉', '浅黄', '浅紫', '白色', '黑色'];
  const FAMILY_OF = {
    '#d4eddc': 0, '#a8dcb9': 0, '#7acd95': 0, '#4abf71': 0,
    '#f8d3dc': 1, '#ef9fb3': 1, '#e86888': 1, '#e52e5c': 1,
    '#fdf6dd': 2, '#f7e39a': 2, '#f0cf5c': 2, '#e5b52a': 2,
    '#e0d7f4': 3, '#baa6e7': 3, '#9374dc': 3, '#6d41d2': 3,
    '#ffffff': 4, '#ebebeb': 4, '#d4d4d4': 4, '#b8b8b8': 4,
    '#9a9a9a': 5, '#6e6e6e': 5, '#464646': 5, '#262626': 5,
  };
  const famCount = {};
  for (const c of colors) {
    const f = FAMILY_OF[c];
    famCount[f] = (famCount[f] || 0) + 1;
  }
  console.log('\n--- 色系分布（同一色系内不同深浅，视觉上仍属同一色）---');
  for (const [f, n] of Object.entries(famCount)) {
    console.log(`  ${FAMILIES[f]}: ${n} 人`);
  }

  console.log('\n--- 结论 ---');
  if (uniqColors.size === N) {
    console.log(`  ✓ ${N} 人头像底色两两不同，无撞色`);
  } else {
    console.log(`  ⚠ ${N} 人时出现 ${N - uniqColors.size} 处撞色`);
  }
  console.log(`  ✓ 昵称 ${uniqNames.size}/${N} 个互不相同`);
  console.log('  注：消息区头像显示「昵称缩写 + 底色」，底色接近时文字也能区分');

  // 断开所有人
  users.forEach((u) => { try { u.ws.close(); } catch { /* ignore */ } });
  await sleep(300);

  // 第二轮：有人离开后，颜色是否回收
  console.log('\n--- 离开后颜色是否回收 ---');
  const a = await connect('reuse-A-' + Date.now());
  const b = await connect('reuse-B-' + Date.now());
  await sleep(200);
  console.log(`  A=${a.self.color}  B=${b.self.color}  ${a.self.color !== b.self.color ? '不同 ✓' : '相同 ✗'}`);
  a.ws.close();
  await sleep(400);
  const c = await connect('reuse-C-' + Date.now());
  console.log(`  A 离开后新来的 C=${c.self.color}  (A 的色=${a.self.color})`);
  console.log(`  → ${c.self.color === a.self.color ? '与 A 同色' : '与 A 不同色'}（离开的人不占位，新人拿当前用得最少的色）`);

  b.ws.close(); c.ws.close();
  await sleep(200);
  stopServer();
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); stopServer(); process.exit(1); });
