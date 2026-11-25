'use strict';

/**
 * 聊天室一键启动器
 *
 * 用法：node launch.js
 * 作用：
 *   1. 启动服务端（node server.js）
 *   2. 启动 Cloudflare 隧道，把本机 8000 暴露成公网 HTTPS 地址
 *   3. 打印公网地址 —— 把这个地址发给朋友，他打开就能进聊天室
 *   4. Ctrl+C 时一并关掉两个子进程
 *
 * 之所以用 Node 而不是批处理/PowerShell：
 *   - 批处理解析 cloudflared 的日志做正则很脆（转义、空格、编码）
 *   - Windows PowerShell 5.1 在环境变量里有 HTTPS_PROXY 和 https_proxy
 *     （大小写不同）时，Start-Process 会抛「已添加项，字典中的关键字」异常
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CF_EXE = path.join(
  ROOT, 'node_modules', '@camera.ui', 'cloudflared-win32-x64', 'cloudflared.exe'
);
const TUNNEL_LOG = path.join(ROOT, 'tunnel.log');
const LOCAL_PORT = process.env.PORT || 8000;

const C = {
  reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m', bold: '\x1b[1m',
};

const say = (s = '') => process.stdout.write(s + '\n');
const children = [];

function shutdown(code = 0) {
  for (const c of children) {
    try { c.kill(); } catch { /* ignore */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  say('');
  say(C.gray + 'Stopping server and tunnel...');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

/* ---------------- 1. 服务端 ---------------- */

say('');
say(C.cyan + '  ============================================');
say(C.cyan + '    Chat Room  -  starting up');
say(C.cyan + '  ============================================');
say('');
say('[1/3] starting server...');

// 房间口令由**服务端**生成并写进 data/room.key（唯一数据源）。
// 启动器只负责读它 —— 两边各写各的会各生成各的，口令就对不上了。

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: false,
});
children.push(server);

server.on('error', (e) => {
  say(C.red + '  [ERROR] cannot start server: ' + e.message);
  shutdown(1);
});

/* ---------------- 2. 隧道 ---------------- */

// 等服务端起来
setTimeout(() => {
  say('[2/3] opening public tunnel (Cloudflare)...');

  // Cloudflare 的免费快速隧道不稳，两种情况都很常见：
  //   1) 被速率限制（429）：申请不到地址
  //   2) 拿到了地址，但连不上边缘节点（context deadline exceeded）→ 访问是 530
  // 所以这里做成「失败自动重试」，并且——隧道失败也**不杀本地服务**：
  // 本机 8000 端口还能正常用，只是暂时没有公网地址而已。
  const MAX_TRIES = 10;
  let tries = 0;
  let tunnel = null;
  let stopped = false;
  let probeUrl = '';       // 当前正在探测的地址（重试时清空）
  let announcedUrl = '';   // 已经宣布过的地址（不重复打印）

  const spawnTunnel = () => {
    if (stopped) return;
    tries++;
    try { fs.unlinkSync(TUNNEL_LOG); } catch { /* 不存在就算了 */ }

    const out = fs.openSync(TUNNEL_LOG, 'w');
    // --edge-ip-version 4：强制走 IPv4。
    // 实测在部分网络环境下走 IPv6 连 Cloudflare 边缘节点会反复
    // 「context deadline exceeded」导致隧道刚拿到地址就断。
    tunnel = spawn(CF_EXE, [
      'tunnel', '--url', `http://localhost:${LOCAL_PORT}`, '--no-autoupdate',
      '--edge-ip-version', '4',
    ], {
      cwd: ROOT,
      stdio: ['ignore', out, out],
      shell: false,
    });
    children.push(tunnel);

    tunnel.on('error', (e) => {
      say(C.red + '  [ERROR] cannot start tunnel: ' + e.message);
      say(C.yellow + '  Is @camera.ui/cloudflared installed? Try: npm install');
    });

    tunnel.on('exit', (code) => {
      if (stopped) return;
      if (tries < MAX_TRIES) {
        const why = probeUrl ? 'tunnel died after getting an address' : 'tunnel exited';
        say(C.yellow + `      ${why} (code ${code}), retry ${tries}/${MAX_TRIES - 1}...`);
        probeUrl = '';
        setTimeout(spawnTunnel, 8000);
      } else {
        giveUp();
      }
    });
  };

  const giveUp = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    say('');
    say(C.red + '  [FAILED] tunnel did not start (Cloudflare quick tunnel is rate-limited or unreachable).');
    say(C.yellow + '  The local server is still running on port ' + LOCAL_PORT + '.');
    say(C.yellow + '  Retry the tunnel later, or use another access method (see README).');
  };

  spawnTunnel();
  say('      waiting for Cloudflare to assign an address...');

  /**
   * 拿到地址不等于能用 —— 隧道刚起来时可能还没连上 Cloudflare 边缘节点，
   * 这时访问会得到 530。所以先探测一下，通了再宣布 READY。
   *
   * 但「分享链接文件」不等探活：地址一拿到就写下来，
   * 免得隧道慢的时候连链接都没有。
   */
  const announceWhenReachable = (url) => {
    writeShareLink(url);

    let waited = 0;
    const probe = setInterval(async () => {
      if (stopped) { clearInterval(probe); return; }
      waited += 1500;
      try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
        if (res.status && res.status < 500) {
          clearInterval(probe);
          if (url !== announcedUrl) {
            announcedUrl = url;
            showReady(url, await waitForRoomKey());
          }
          return;
        }
      } catch { /* 还没通，继续等 */ }
      if (waited > 120000) {
        clearInterval(probe);
        say(C.yellow + `      ${url} 暂时探测不通，隧道进程还在跑，稍后手动访问试试`);
        say(C.gray + '      分享链接已写入 share-link.txt');
      }
    }, 1500);
  };

  // 轮询日志，最多 5 分钟（期间失败会自动重启隧道）
  const deadline = Date.now() + 300000;
  const tick = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(TUNNEL_LOG, 'utf8'); } catch { /* 还没写 */ }

    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== probeUrl) {
      probeUrl = m[0];
      announceWhenReachable(m[0]);
      return;
    }

    if (Date.now() > deadline) giveUp();
  }, 1000);
}, 2500);

/* ---------------- 3. 结果 ---------------- */

function showReady(url, key = readRoomKey()) {
  const line = '  ' + '-'.repeat(44);

  say('');
  say(C.green + '  ============================================');
  say(C.green + '    READY');
  say(C.green + '  ============================================');
  say('');
  say('  On this PC:  http://localhost:' + LOCAL_PORT + '/chat');
  say('');
  say('  Share this with your friend:');
  say('');
  // 链接里带上房间口令 —— 朋友点开就能进，陌生人点开会被挡在门外
  const share = key ? `${url}/chat#key=${key}` : `${url}/chat`;
  say(C.bold + C.yellow + '    ' + share);
  say('');
  if (key) say(C.gray + '  Room key: ' + key);
  say(C.gray + '  已写入 share-link.txt（可直接复制）');
  say(C.gray + '  Notes:');
  say(C.gray + '    - Only people with the link (and its key) can get in.');
  say(C.gray + '    - The link changes every restart. Send the new one.');
  say(C.gray + '    - Tunnel log: tunnel.log');
  say(C.gray + '    - Press Ctrl+C to stop everything.');
  say('');

  // 自动打开本机页面（带上口令，免得多问一句）
  const opener = process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const localUrl = key ? `http://localhost:${LOCAL_PORT}/chat#key=${key}` : `http://localhost:${LOCAL_PORT}/chat`;
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', localUrl]
    : [localUrl];
  try {
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开浏览器无所谓 */ }
}

/**
 * 等服务端把口令写进文件。
 *
 * 服务端一启动就会写，正常是立刻就有；万一慢一点就等几秒。
 */
async function waitForRoomKey() {
  for (let i = 0; i < 50; i++) {
    const key = readRoomKey();
    if (key) return key;
    await new Promise((r) => setTimeout(r, 200));
  }
  return '';
}

/**
 * 把分享链接写进 share-link.txt。
 *
 * 单独放一个函数，是因为「隧道刚起来还没探活通过」时也该先把链接给出去 ——
 * 免得用户干等着。
 */
function writeShareLink(url) {
  const key = readRoomKey();
  const share = key ? `${url}/chat#key=${key}` : `${url}/chat`;
  try {
    fs.writeFileSync(path.join(ROOT, 'share-link.txt'),
      `本机地址  : http://localhost:${LOCAL_PORT}/chat\n` +
      `发给朋友  : ${share}\n` +
      `房间口令  : ${key || '(公开房间，谁都能进)'}\n`, 'utf8');
  } catch { /* 写不了就算了，终端上也会打印 */ }
}

/**
 * 读房间口令。
 *
 * 口令由服务端生成并写进 data/room.key —— 这里是唯一的读取方，
 * 不自己生成，避免和服务端各写各的。
 */
function readRoomKey() {
  if (process.env.ROOM_KEY !== undefined) return String(process.env.ROOM_KEY).trim();
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'room.key'), 'utf8').trim();
  } catch {
    return '';
  }
}
