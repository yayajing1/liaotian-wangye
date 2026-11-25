'use strict';

/**
 * 多人网页聊天室服务端
 *
 *  - HTTP  ：托管 public/ 静态资源
 *  - WS    ：路径 /ws，消息广播、在线成员、进出提示、输入中提示、撤回
 *  - SQLite：node:sqlite 内置模块，零原生依赖
 *
 * 设计要点：
 *  1. 消息表只存 sender_id，昵称/颜色存在 users 表 —— 改名后历史消息跟着显示新名
 *  2. 消息保留 7 天，定时清理
 *  3. 撤回只能撤回本人 2 分钟内的消息
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8000;          // 主端口：入口页 + 聊天室
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// 备用端口：仅本地开发需要。部署环境（容器/云主机）通常只开放一个端口，
// 用 ALT_PORT=0 关闭；没显式设置时默认开 3000。
const ALT_PORT = process.env.ALT_PORT === '0'
  ? 0
  : (process.env.ALT_PORT ? Number(process.env.ALT_PORT) : 3000);

const MAX_TEXT = 1000;
const MAX_NAME = 12;
const PAGE_SIZE = 50;

// 换头像色的最小间隔：防止连点把广播刷爆。
// 只针对「颜色」计时，不影响改名（改名走原来的逻辑，一行没动）。
const COLOR_COOLDOWN_MS = Number(process.env.COLOR_COOLDOWN_MS) || 1000;

// ---- 图片头像 ----
//
// 用户可以从手机相册里挑一张图当头像。图片走「上传 → 存文件 → 引用 token」的模式：
//   1. 客户端用 canvas 把图片居中裁剪成 128×128 的 PNG，base64 后发给服务端
//   2. 服务端校验大小和文件头，存到 data/avatars/<token>.png
//   3. users.avatar 只存 token（比如 "a1b2c3d4"）
//   4. 别人渲染头像时请求 /avatar/<token>.png
//
// 为什么存文件而不是塞进数据库：
//   - 图片是二进制大块，混在聊天库里会让备份/清理逻辑变复杂
//   - 单独目录可以直接被 backup.sh 打包迁移
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const AVATAR_SIZE = 128;                        // 边长（像素）
const MAX_AVATAR_BYTES = 256 * 1024;            // 单张上限 256KB（base64 解码后）
const MAX_AVATAR_B64 = Math.ceil(MAX_AVATAR_BYTES * 4 / 3) + 16;
const AVATAR_COOLDOWN_MS = Number(process.env.AVATAR_COOLDOWN_MS) || 3000;

// 消息保留 7 天，定时清理
// 保留期和清理间隔都做成环境变量可调 —— 测试里用小值快速验证
// 「消息过期 → 用户行被清理 → 昵称释放」这条链路。
const RETENTION_MS = Number(process.env.RETENTION_MS) || 7 * 24 * 60 * 60 * 1000;
const RECALL_WINDOW_MS = 2 * 60 * 1000;         // 撤回时限 2 分钟
const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || 60 * 60 * 1000;

/* ================================================================== */
/* 数据库                                                              */
/* ================================================================== */

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));

/* ================================================================== */
/* 房间口令                                                            */
/* ================================================================== */
/**
 * 内测期间房间是私有的：只有拿到口令的人才能进来。
 *
 * 口令来源优先级：
 *   1) 环境变量 ROOM_KEY   —— 部署时用（比如容器里注入）
 *   2) data/room.key 文件  —— 本地开发，自动生成一次就固定下来
 *   3) 都没有              —— 自动生成一个随机口令并写进文件
 *
 * 想要「谁都能进」的公开房间，设 ROOM_KEY='' 即可（口令校验会跳过）。
 */
const ROOM_KEY = loadRoomKey();

/**
 * 备用口令（可选，来自环境变量 ROOM_KEY_SPARE）。
 *
 * 主口令靠链接传递，链接触手过程中字符容易被被动过：
 * 聊天软件转码、手抄时把 1 看成 l / 0 看成 o。
 * 多认一把备用口令，主口令那一版失效了链接照样能进。
 * 空串 = 没有备用口令。
 */
const ROOM_KEY_SPARE = (process.env.ROOM_KEY_SPARE === undefined)
  ? '' : normalizeKey(process.env.ROOM_KEY_SPARE);

/**
 * 口令字符集：故意去掉 0/O、1/l/I 这些"长得太像"的字符。
 *
 * 踩过的坑：原来的口令是十六进制，人工从聊天记录往手机里誊的时候，
 * 一眼看错就把 1 当成 l、把 b 当成 6，服务端直接判定"口令不正确"，
 * 对方反复弹框也进不来。字符集里根本没有这些字符，就从根上杜绝。
 */
const KEY_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** 生成一个不含易混淆字符的房间口令 */
function generateRoomKey(len = 16) {
  const max = Math.floor(256 / KEY_ALPHABET.length) * KEY_ALPHABET.length;
  let out = '';
  while (out.length < len) {
    const buf = crypto.randomBytes(len * 2);
    for (const b of buf) {
      if (b >= max) continue;                 // 丢弃有偏置的取值
      out += KEY_ALPHABET[b % KEY_ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
}

function loadRoomKey() {
  const fromEnv = process.env.ROOM_KEY;
  if (fromEnv !== undefined) return String(fromEnv).trim();   // 空串 = 公开房间

  const file = path.join(DATA_DIR, 'room.key');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch { /* 文件还没有，下面生成 */ }

  const key = generateRoomKey();
  try { fs.writeFileSync(file, key, 'utf8'); } catch { /* 只读文件系统也不影响运行 */ }
  console.log(`[room] 已生成新房间口令：${key}`);
  return key;
}

/**
 * 口令归一化。
 *
 * 手机上把口令敲对很难，一个字符的"脏"就足以让它变成错的：
 *   - 首尾空格 / 换行（复制时带上的）
 *   - 全角字符（中文输入法下的 ａｂｃ、０９）
 *   - 大小写（手机键盘把首字母自动大写了）
 *   - 中间被插入的空格
 * 这些都不是用户本意，一律在比对前抹平。
 */
function normalizeKey(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .normalize('NFKC')          // 全角 → 半角
    .replace(/\s+/g, '')        // 去掉所有空白
    .toLowerCase();
}

/** 定长比较，避免用时序差异泄漏口令 */
function keyMatches(given) {
  if (!ROOM_KEY) return true;                       // 公开房间，不校验
  const a = Buffer.from(normalizeKey(given), 'utf8');
  const b = Buffer.from(normalizeKey(ROOM_KEY), 'utf8');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;

  // 备用口令：长度必须一样才比，否则 timingSafeEqual 会抛异常
  if (ROOM_KEY_SPARE) {
    const c = Buffer.from(ROOM_KEY_SPARE, 'utf8');
    if (a.length === c.length && crypto.timingSafeEqual(a, c)) return true;
  }
  return false;
}

// WAL 模式需要额外的 -wal/-shm 文件，在某些容器/网络文件系统上会失败。
// 失败就退回默认的 DELETE 日志模式 —— 功能不受影响，只是并发写入性能略低。
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
} catch (err) {
  console.warn(`[warn] WAL 模式不可用（${err.message}），使用默认日志模式`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    sender_id    TEXT NOT NULL,
    text         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'text',
    reply_to_id  TEXT,
    created_at   INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);');

// ---- 设备绑定表 ----
//
// 一个账号可以同时在好几台设备上（手机 + 电脑 + 平板）。
// 老的 users.client_id 一行只能记一个设备，第二个设备一来就把第一个顶掉了，
// 所以单独开一张表：client_id → user_id，一台设备只属于一个人，
// 一个人可以有很多台设备。
db.exec(`
  CREATE TABLE IF NOT EXISTS user_devices (
    client_id  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);');

// ---- 账号表 ----
//
// 账号 = 「用户名 + 密码」，用来跨设备认回同一个身份。
// 和 users 表的关系：accounts.user_id 指向 users.id ——
// 一个账号绑一个聊天身份（昵称/头像/历史消息都跟着 users 行走）。
//
// 为什么和 users.login_hash（上一轮做的「个人登录密码」）并存：
//   login_hash  → 昵称 + 密码，认回身份（老方案，靠昵称找人）
//   accounts    → 账号名 + 密码，认回身份（新方案，账号名唯一、不占昵称）
// 两套并存不冲突：老用户还能用老办法，新用户用账号。
//
// 密码只存 scrypt 哈希 + 随机盐，**永不存明文**。
// fail_count / locked_until → 连续输错密码就锁账号，防暴力破解。
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id           TEXT PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE,   -- 账号名（已归一化：小写去空格）
    display_name TEXT NOT NULL,           -- 账号名原样（登录时显示用）
    pass_hash    TEXT NOT NULL,
    pass_salt    TEXT NOT NULL,
    user_id      TEXT NOT NULL,           -- 绑定的聊天身份
    created_at   INTEGER NOT NULL,
    last_login   INTEGER,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);');

// ---- 会话表 ----
//
// 登入成功后服务端发一个 session token，客户端存在 localStorage。
// 之后每次连接带上它 → 服务端直接认回身份，不用再输密码。
//
// ⚠️ 库里只存 token 的 sha256 —— 就算数据库被人整个拖走，
//    拿到的哈希也换不出可用的 token（会话劫持成本极高）。
// expires_at 支持「滑动续期」：每次用到就往后延，长期活跃的会话不会被踢。
db.exec(`
  CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash TEXT PRIMARY KEY,          -- sha256(token)，不存明文
    account_id TEXT NOT NULL,
    client_id  TEXT,                      -- 绑到哪台设备（可空）
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_account ON account_sessions(account_id);');

// 昵称全局唯一（在线 + 历史一起算）
//
// 老版本只在「在线成员」之间去重：人一离线昵称就被释放，
// 于是历史消息里会同时出现两个「小满」，根本分不清谁是谁。
// 现在从数据库层面保证 users.name 唯一 —— 历史消息显示的昵称
// 就是 users.name，所以这一条约束直接堵住了「历史撞名」。
//
// 唯一索引建之前必须先把已有的重名数据修掉，否则建索引会失败。
function migrateUniqueNames() {
  // 1) 找出重名的昵称
  const dupes = db.prepare(`
    SELECT name FROM users GROUP BY name HAVING COUNT(*) > 1
  `).all();

  for (const d of dupes) {
    // 消息最多的人保留原名（他在历史里出现最频繁，改名影响最大），
    // 其余人依次加数字后缀
    const rows = db.prepare(`
      SELECT u.id, u.created_at,
             (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS c
      FROM users u WHERE u.name = ?
      ORDER BY c DESC, u.created_at ASC
    `).all(d.name);

    rows.slice(1).forEach((r, i) => {
      // 找一个当前没人占用的后缀名（小满 → 小满2 → 小满3 …）
      let candidate = null;
      for (let n = i + 2; n <= 999; n++) {
        const c = d.name.slice(0, MAX_NAME - 3) + n;
        const taken = db.prepare('SELECT 1 FROM users WHERE name = ?').get(c);
        if (!taken) { candidate = c; break; }
      }
      if (!candidate) return;
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(candidate, r.id);
    });
    console.log(`[migrate] 昵称「${d.name}」重名 ${rows.length} 人，已拆分`);
  }

  // 2) 建唯一索引
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(name);');
  } catch (err) {
    console.warn(`[warn] 昵称唯一索引创建失败：${err.message}`);
  }
}

// 客户端持久身份：同一浏览器刷新后仍是同一个人（id / 昵称 / 颜色都不变）
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('client_id')) {
  db.exec('ALTER TABLE users ADD COLUMN client_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_client ON users(client_id)');

// 图片头像：存的是 data/avatars/ 下的文件名（token.png），
// 为空表示用「颜色底 + 昵称首字」那种默认头像。
// 加这列是为了让「换过的头像」在刷新、重连、换设备后都还在。
if (!userCols.includes('avatar')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
}

// ---- 个人登录密码 ----
//
// 这是「用户自己设的密码」，和房间口令是两回事：
//   房间口令   → 管「谁能进这个房间」，是大家一起用的
//   个人密码   → 管「谁是我」，用来在别的设备上把原来的身份认回来
//
// 存的是 scrypt 哈希 + 随机盐，不存明文。
if (!userCols.includes('login_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN login_hash TEXT');
}
if (!userCols.includes('login_salt')) {
  db.exec('ALTER TABLE users ADD COLUMN login_salt TEXT');
}

const S = {
  // 新用户：纯 INSERT。名字的唯一性由 idx_users_name 唯一索引在存储层兜底
  insertUser: db.prepare(`
    INSERT INTO users (id, name, color, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `),
  renameUser: db.prepare('UPDATE users SET name = ?, color = ?, last_seen = ? WHERE id = ?'),
  // 换图片头像：只改 avatar 字段，不碰昵称和颜色
  setAvatar: db.prepare('UPDATE users SET avatar = ?, last_seen = ? WHERE id = ?'),
  getUser: db.prepare('SELECT id, name, color, avatar FROM users WHERE id = ?'),
  findByClient: db.prepare('SELECT id, name, color, avatar FROM users WHERE client_id = ?'),
  setClient: db.prepare('UPDATE users SET client_id = ?, last_seen = ? WHERE id = ?'),
  // 换过身份之后，client_id 可能还挂在别的用户行上 → 先摘掉再写，避免撞唯一索引
  clearClientOther: db.prepare('UPDATE users SET client_id = NULL WHERE client_id = ? AND id <> ?'),
  // ---- 设备绑定（一个账号可以有多台设备） ----
  findDevice: db.prepare('SELECT user_id FROM user_devices WHERE client_id = ?'),
  setDevice: db.prepare(`
    INSERT INTO user_devices (client_id, user_id, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET user_id = excluded.user_id, last_seen = excluded.last_seen
  `),
  touchDevice: db.prepare('UPDATE user_devices SET last_seen = ? WHERE client_id = ?'),
  deleteDevice: db.prepare('DELETE FROM user_devices WHERE client_id = ?'),
  // 昵称占用查询：排除自己后，还有没有别人占着这个名字（在线 + 历史一起算）
  takenByName: db.prepare('SELECT COUNT(*) AS c FROM users WHERE name = ? AND id <> ?'),
  // 所有已被占用的昵称（自动分配昵称时避开）
  listUsers: db.prepare('SELECT id, name, color, avatar FROM users'),
  // ---- 个人登录密码用到的几条 ----
  // 取完整行（含密码哈希），只在自己这条连接里用
  getUserLogin: db.prepare('SELECT id, name, color, avatar, login_hash, login_salt FROM users WHERE id = ?'),
  // 按昵称精确找一个人（登录时用）
  findByName: db.prepare('SELECT id, name, color, avatar, login_hash, login_salt FROM users WHERE name = ?'),
  setLogin: db.prepare('UPDATE users SET login_hash = ?, login_salt = ? WHERE id = ?'),
  clearLogin: db.prepare("UPDATE users SET login_hash = NULL, login_salt = NULL WHERE id = ?"),
  // 房间里有没有人设过密码 → 决定要不要显示「登录已有身份」入口
  countLoginUsers: db.prepare("SELECT COUNT(*) AS c FROM users WHERE login_hash IS NOT NULL AND login_hash <> ''"),
  // 某人发过多少条消息 → 决定临时身份能不能直接删掉
  countMsgs: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender_id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

  /* ---------- 账号 ---------- */
  // 按归一化账号名查（username 存的是小写去空格版）
  findAccount: db.prepare('SELECT * FROM accounts WHERE username = ?'),
  findAccountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  findAccountByUser: db.prepare('SELECT * FROM accounts WHERE user_id = ?'),
  insertAccount: db.prepare(`
    INSERT INTO accounts (id, username, display_name, pass_hash, pass_salt, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  touchAccountLogin: db.prepare('UPDATE accounts SET last_login = ? WHERE id = ?'),
  bumpAccountFail: db.prepare('UPDATE accounts SET fail_count = fail_count + 1, locked_until = ? WHERE id = ?'),
  resetAccountFail: db.prepare('UPDATE accounts SET fail_count = 0, locked_until = 0 WHERE id = ?'),
  updateAccountPw: db.prepare('UPDATE accounts SET pass_hash = ?, pass_salt = ? WHERE id = ?'),
  countAccounts: db.prepare('SELECT COUNT(*) AS c FROM accounts'),

  /* ---------- 会话 ---------- */
  insertSession: db.prepare(`
    INSERT INTO account_sessions (token_hash, account_id, client_id, created_at, expires_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  // 取会话 + 顺带滑动续期
  getSession: db.prepare('SELECT * FROM account_sessions WHERE token_hash = ?'),
  touchSession: db.prepare('UPDATE account_sessions SET expires_at = ?, last_seen = ? WHERE token_hash = ?'),
  bindSessionDevice: db.prepare('UPDATE account_sessions SET client_id = ? WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM account_sessions WHERE token_hash = ?'),
  deleteAccountSessions: db.prepare('DELETE FROM account_sessions WHERE account_id = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM account_sessions WHERE expires_at < ?'),
  // 在线成员的心跳（防止久不发言的在线用户被清理掉）
  touchUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  insertMsg: db.prepare(
    'INSERT INTO messages (id, sender_id, text, kind, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getMsg: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.kind, m.reply_to_id, m.created_at, u.name, u.color, u.avatar
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `),
  recallMsg: db.prepare("UPDATE messages SET text = '', kind = 'recalled' WHERE id = ?"),
  latest: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.kind, m.reply_to_id, m.created_at, u.name, u.color, u.avatar
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    ORDER BY m.created_at DESC LIMIT ?
  `),
  olderThan: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.kind, m.reply_to_id, m.created_at, u.name, u.color, u.avatar
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.created_at < ?
    ORDER BY m.created_at DESC LIMIT ?
  `),
  countAll: db.prepare('SELECT COUNT(*) AS c FROM messages'),
  deleteOlder: db.prepare('DELETE FROM messages WHERE created_at < ?'),
  // ⚠️ 设过个人登录密码、或已绑定账号的用户不会被自动清理 ——
  //    否则「我设了密码，7 天没用，密码自己没了」，登录功能等于白做。
  //    代价是这个名字会被一直占着，但对这种小房间完全够用。
  deleteStaleUsers: db.prepare(`
    DELETE FROM users
    WHERE id NOT IN (SELECT DISTINCT sender_id FROM messages)
      AND last_seen < ?
      AND (login_hash IS NULL OR login_hash = '')
      AND id NOT IN (SELECT user_id FROM accounts)
  `),
};

/** 把数据库行转成前端用的消息对象（昵称实时关联 users 表） */
function toMessage(row) {
  return {
    id: row.id,
    from: {
      id: row.sender_id,
      name: row.name || '未知用户',
      color: row.color || '#8a929c',
      avatar: row.avatar || '',
    },
    text: row.text,
    kind: row.kind,
    replyTo: row.reply_to_id || null,
    ts: row.created_at,
  };
}

/**
 * 定期清理：过期消息 + 过期用户行
 *
 * 用户行只在「没有任何消息」且「很久没上线」时才删 ——
 * 因为昵称占用权是绑在用户行上的：
 *   删掉这一行 → 这个人不再出现在历史里 → 他的昵称才允许被别人用
 * 消息过期（7 天）后，对应用户行会被这条规则一并清掉，
 * 于是昵称占用期和消息保留期自然对齐。
 */
function cleanupOldData() {
  const cutoff = Date.now() - RETENTION_MS;
  const removed = S.deleteOlder.run(cutoff).changes;
  const removedUsers = S.deleteStaleUsers.run(cutoff).changes;
  if (removed) console.log(`[cleanup] 清理过期消息 ${removed} 条`);
  if (removedUsers) console.log(`[cleanup] 清理过期用户 ${removedUsers} 人（昵称已释放）`);

  // 用户行被删了，他们的图片头像也就没人引用了 —— 一并清掉
  const orphans = cleanupOrphanAvatars();
  if (orphans) console.log(`[cleanup] 清理无主头像文件 ${orphans} 个`);
}

/**
 * 旧色池 → 新色池：把库里已有的头像色映射到新的 24 色阶色池。
 *
 * 两步：
 *   1. 按 COLOR_MIGRATE 表做已知映射
 *   2. 兜底：任何仍不在新色池里的颜色，统一归到该色系的最浅档
 *      （靠 familyOf 判断归属；连色系都判断不了的归浅黄）
 */
function migrateColors() {
  let n = 0;
  for (const [from, to] of Object.entries(COLOR_MIGRATE)) {
    n += db.prepare('UPDATE users SET color = ? WHERE color = ?').run(to, from).changes;
  }

  // 兜底：不在新色池里的颜色，按"最接近的色系"归位
  const rows = db.prepare('SELECT DISTINCT color FROM users').all();
  for (const r of rows) {
    if (COLOR_POOL.includes(r.color)) continue;
    // 找亮度最接近的色阶，映射到它
    const yiq = (hex) => {
      const c = String(hex).replace('#', '');
      const r0 = parseInt(c.slice(0, 2), 16);
      const g0 = parseInt(c.slice(2, 4), 16);
      const b0 = parseInt(c.slice(4, 6), 16);
      return (r0 * 299 + g0 * 587 + b0 * 114) / 1000;
    };
    const target = COLOR_POOL.reduce((best, c) => {
      const d = Math.abs(yiq(c) - yiq(r.color));
      const bd = Math.abs(yiq(best) - yiq(r.color));
      return d < bd ? c : best;
    }, COLOR_POOL[0]);
    n += db.prepare('UPDATE users SET color = ? WHERE color = ?').run(target, r.color).changes;
  }

  if (n) console.log(`[migrate] ${n} 条历史用户头像色已迁移到新色池`);
}

/* ================================================================== */
/* 身份分配                                                            */
/* ================================================================== */

const NICK_POOL = [
  '青柠', '晚风', '小满', '阿白', '松果', '半夏', '云朵', '月牙', '布丁', '木木',
  '橙子', '芝麻', '山丘', '小雨', '棉花', '柚子', '海盐', '松鼠', '兔子', '奶盖',
  '灰灰', '桃桃', '薄荷', '雪梨', '柠檬', '企鹅', '栗子', '春山', '银杏', '灯塔',
  '杏仁', '榛果', '花生', '核桃', '橡果', '枫叶', '桑叶', '芦苇', '稻穗', '麦田',
  '麦浪', '竹叶', '桃枝', '杏花', '梨花', '梅花', '樱花', '桂花', '茉莉', '荷花',
  '莲花', '石榴', '芒果', '荔枝', '葡萄', '草莓', '樱桃', '山楂', '橄榄', '柚香',
];

/**
 * 头像色池
 *
 * 用户指定的 6 个「基础款」色系：浅绿 / 浅粉 / 浅黄 / 浅紫 / 白色 / 黑色。
 * 每个色系下 4 个色阶，**同色系内任意两色的 YIQ 亮度差 ≥ 20**，
 * 保证即使昵称首字相同，两个头像也能一眼分辨。
 *
 * 亮度差校验方式：YIQ = (R*299 + G*587 + B*114) / 1000
 */
const COLOR_POOL = [
  // 浅绿
  '#d4eddc', '#a8dcb9', '#7acd95', '#4abf71',
  // 浅粉
  '#f8d3dc', '#ef9fb3', '#e86888', '#e52e5c',
  // 浅黄
  '#fdf6dd', '#f7e39a', '#f0cf5c', '#e5b52a',
  // 浅紫
  '#e0d7f4', '#baa6e7', '#9374dc', '#6d41d2',
  // 白色
  '#ffffff', '#ebebeb', '#d4d4d4', '#b8b8b8',
  // 黑色
  '#9a9a9a', '#6e6e6e', '#464646', '#262626',
];

/** 色系归类：同一色系算"相近色"，不同色系才算明显不同 */
const COLOR_FAMILY = [
  ['#d4eddc', '#a8dcb9', '#7acd95', '#4abf71'],   // 浅绿
  ['#f8d3dc', '#ef9fb3', '#e86888', '#e52e5c'],   // 浅粉
  ['#fdf6dd', '#f7e39a', '#f0cf5c', '#e5b52a'],   // 浅黄
  ['#e0d7f4', '#baa6e7', '#9374dc', '#6d41d2'],   // 浅紫
  ['#ffffff', '#ebebeb', '#d4d4d4', '#b8b8b8'],   // 白色
  ['#9a9a9a', '#6e6e6e', '#464646', '#262626'],   // 黑色
];

function familyOf(color) {
  for (let i = 0; i < COLOR_FAMILY.length; i++) {
    if (COLOR_FAMILY[i].includes(color)) return i;
  }
  return -1;
}

/**
 * 旧色 → 新色 的一次性迁移，保证历史消息里的头像色也在新色池里。
 * 映射到每个色系的最浅一档，视觉上最接近原来的观感。
 */
const COLOR_MIGRATE = {
  // 第一版 6 色
  '#b7e4c7': '#d4eddc', '#f7c6d4': '#f8d3dc', '#f9e3a0': '#fdf6dd',
  '#d5c6f0': '#e0d7f4', '#ffffff': '#ffffff', '#2f2f2f': '#262626',
  // 更早的 10 色池
  '#f56565': '#f8d3dc', '#f6a623': '#fdf6dd', '#f7c948': '#fdf6dd',
  '#5bc236': '#d4eddc', '#3fb984': '#d4eddc', '#26c6da': '#e0d7f4',
  '#4a9eff': '#e0d7f4', '#6c5ce7': '#e0d7f4', '#a55eea': '#e0d7f4',
  '#ff6b9d': '#f8d3dc',
  // 中间过渡版本（4 阶色池的第一版）
  '#8fd3a8': '#a8dcb9', '#c8edd5': '#d4eddc', '#a3d9b8': '#a8dcb9',
  '#f0a8be': '#ef9fb3', '#fadce5': '#f8d3dc', '#eeb3c6': '#ef9fb3',
  '#f2d36b': '#f7e39a', '#fceec4': '#fdf6dd', '#f0d488': '#f7e39a',
  '#bda7e4': '#baa6e7', '#e3d9f6': '#e0d7f4', '#cbb8ec': '#baa6e7',
  '#f2f2f2': '#ebebeb', '#e8e8e8': '#d4d4d4', '#fafafa': '#ebebeb',
  '#4a4a4a': '#464646', '#1f1f1f': '#262626', '#5c5c5c': '#6e6e6e',
};

/**
 * 昵称占用判定
 *
 * 「占用」= 这个昵称已经绑定在某个 users 行上。
 *
 * 为什么查数据库而不是只查在线成员：
 *   messages 表只存 sender_id，历史消息显示的是发送者「当前」的昵称。
 *   只要某人发过言（消息还在 7 天保留期内），他的昵称就会一直出现在
 *   历史里 —— 这时让别人用同一个昵称，历史中就会同时出现两个「小满」，
 *   谁是谁根本分不清。
 *
 * 生命周期与消息保留期天然对齐：
 *   在线              → 行在，昵称占用
 *   离线但发过言      → 行在，昵称占用（← 历史去重的关键）
 *   消息全部过期      → 用户行被清理，昵称自动释放
 *
 * excludeId：排除自己（自己当然可以继续用这个昵称）。
 */
function nameTaken(name, excludeId) {
  return S.takenByName.get(name, excludeId || '').c > 0;
}

/** 保证昵称唯一：冲突时自动加数字后缀 */
function uniqueName(name, excludeId) {
  if (!nameTaken(name, excludeId)) return name;
  for (let i = 2; i <= 99; i++) {
    const candidate = name.slice(0, MAX_NAME - 2) + i;
    if (!nameTaken(candidate, excludeId)) return candidate;
  }
  // 极端情况：数字后缀排到 99 还撞 → 换随机后缀，同样要确认没被占用
  for (let i = 0; i < 50; i++) {
    const candidate = name.slice(0, MAX_NAME - 4) + Math.floor(Math.random() * 900 + 100);
    if (!nameTaken(candidate, excludeId)) return candidate;
  }
  return name.slice(0, MAX_NAME - 3) + Math.floor(Math.random() * 900 + 100);
}

/**
 * 自动分配昵称
 *
 * 优先从 60 个昵称池里挑没被占用的；
 * 池子被历史用户占满时（长期使用会攒下几十个人），
 * 改成「小满2」「灯塔2」这类「原名 + 数字后缀」，再不行才退到「用户XXXX」。
 */
function pickNickname() {
  // held = 所有已被占用的昵称（在线的 + 留在历史里的，一起算）
  const held = new Set(S.listUsers.all().map((r) => r.name));
  const pool = [...NICK_POOL].sort(() => Math.random() - 0.5);

  for (const base of pool) {
    if (!held.has(base)) return base;
  }

  // 池子用完了 → 用「原名 + 数字后缀」继续（而不是换一批随机名，避免和历史名撞车）
  //
  // 优先用「后缀用得最少」的底名，把新名字散开：
  //   杏2、灯塔2、春山2、山楂2 ……
  // 而不是所有人共用一个底名（杏2、杏3、杏4……）——
  // 后者首字都一样，侧栏头像就分不清谁是谁了。
  const scored = pool.map((base) => {
    let used = 0;
    for (let i = 2; i <= 99; i++) {
      if (held.has(base.slice(0, MAX_NAME - 2) + i)) used++;
    }
    return { base, used };
  });
  scored.sort((a, b) => a.used - b.used || Math.random() - 0.5);

  for (const { base } of scored) {
    for (let i = 2; i <= 99; i++) {
      const candidate = base.slice(0, MAX_NAME - 2) + i;
      if (!held.has(candidate)) return candidate;
    }
  }

  // 兜底
  for (let i = 0; i < 200; i++) {
    const fallback = `用户${Math.floor(Math.random() * 9000 + 1000)}`;
    if (!held.has(fallback)) return fallback;
  }
  return `用户${Date.now().toString(36).slice(-4)}`;
}

/**
 * 头像色：优先挑「在线成员里用得最少」的那种颜色。
 *
 * 旧逻辑只在"完全没被用过"的颜色里挑，一旦某个颜色被占满就开始随机重复，
 * 导致 10 人场景只用到 5 种色、浅紫被 4 人共用。
 * 现在的做法：按各颜色的使用次数排序，取用得最少的（并列时随机），
 * 保证颜色分布均匀 —— 10 人时每种色用 1~2 次，不会出现 4 人同色。
 */
function pickColor() {
  const inUse = new Map();
  for (const u of clients.values()) {
    inUse.set(u.color, (inUse.get(u.color) || 0) + 1);
  }

  // 没被用过的色排最前；其次是用得最少的
  const sorted = [...COLOR_POOL].sort((a, b) => {
    const ca = inUse.get(a) || 0;
    const cb = inUse.get(b) || 0;
    if (ca !== cb) return ca - cb;
    return Math.random() - 0.5;   // 同频次时随机打散
  });

  return sorted[0];
}

function createUser() {
  return {
    id: crypto.randomUUID(),
    name: pickNickname(),
    color: pickColor(),
    avatar: '',        // 空 = 用颜色头像
  };
}

/**
 * 写入一个新用户行（昵称占用权就登记在这一行上）。
 *
 * 昵称唯一性最终靠 idx_users_name 唯一索引兜底（存储层）。
 * 但 pickNickname() 只是「先查再取」，两个新用户恰好同时上线时
 * 仍可能挑到同一个名字 —— 这时 INSERT 会撞唯一约束。
 * 所以这里撞了就换个名字重试，最多重试 10 次。
 */
function persistUser(user, now) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      S.insertUser.run(user.id, user.name, user.color, now, now);
      return true;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!/UNIQUE|constraint/i.test(msg)) throw err;
      user.name = uniqueName(user.name, user.id);   // 撞名 → 加后缀重试
    }
  }
  // 兜底：用随机串当昵称，几乎不可能再撞（撞了也只能靠唯一索引报错）
  user.name = `用户${crypto.randomBytes(4).toString('hex').slice(0, 8)}`;
  S.insertUser.run(user.id, user.name, user.color, now, now);
  return true;
}

function publicUser(u) {
  // avatar 是图片头像的文件名（token.png），空字符串表示用颜色头像。
  // 客户端拿到它后会去请求 /avatar/<token>。
  return { id: u.id, name: u.name, color: u.color, avatar: u.avatar || '' };
}

/* ================================================================== */
/* 个人登录密码                                                        */
/* ================================================================== */

// scrypt 参数：安全系数调高一档。
//
// N=16384 → N=32768，内存占用 32MB→64MB，单次耗时约翻倍。
// 这台机器只有 1.6G 内存，但 scryptSync 是**同步**的 —— 同一时刻只跑一个，
// 峰值内存就是 64MB，不会因为并发登录叠加。
//
// ⚠️ 换参数后老哈希会验不过（参数不一样，算法结果就不同）。
// 所以哈希必须**自描述**：把 N/r/p 和盐一起写进哈希串里，
// 验证时按串里写的参数重算。这样以后再调参数也不会作废老密码。
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_OPTS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 };

// 旧版参数：上一轮做的「个人登录密码」用的就是这套。
// 库里那些哈希没有自描述信息，只能按老参数验 → 保留一份专门给它用。
const SCRYPT_LEGACY = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// 自描述哈希的前缀。以后再改参数，只改这里的版本号就行。
const HASH_PREFIX = 's2';

/**
 * 生成密码哈希 + 随机盐
 *
 * 返回的 hash 是自描述串：`s2$N$r$p$盐$哈希`
 * —— 参数、盐、结果全在里面，验证时不需要额外的列。
 * （兼容老格式：verifyPassword 会自动识别。）
 */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32, SCRYPT_OPTS).toString('hex');
  return { salt, hash: `${HASH_PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}` };
}

/**
 * 校验密码。
 * 用 timingSafeEqual 比字节，避免「逐字符猜」的时间差。
 *
 * 支持两种格式：
 *   1. 自描述串  s2$N$r$p$salt$hash  → 按串里的参数重算
 *   2. 老格式    裸 hex + 单独的 salt 列 → 按老参数（SCRYPT_LEGACY）重算
 */
function verifyPassword(pw, hash, salt) {
  if (!hash) return false;
  const raw = String(hash);

  let opts = SCRYPT_LEGACY;
  let useSalt = salt;
  let expected = raw;

  const parts = raw.split('$');
  if (parts.length === 6 && parts[0] === HASH_PREFIX) {
    const [, n, r, p, s, h] = parts;
    opts = {
      N: Number(n) || SCRYPT_N,
      r: Number(r) || SCRYPT_R,
      p: Number(p) || SCRYPT_P,
      maxmem: 128 * 1024 * 1024,
    };
    useSalt = s;
    expected = h;
  }

  if (!useSalt || !expected) return false;
  try {
    const calc = crypto.scryptSync(String(pw), useSalt, 32, opts);
    const known = Buffer.from(expected, 'hex');
    if (known.length !== calc.length) return false;
    return crypto.timingSafeEqual(known, calc);
  } catch {
    return false;
  }
}

/**
 * 这个哈希是不是用老参数算的（该升级成新参数了）。
 * 老参数强度低，能验就顺手续一次强度 —— 用户完全无感。
 */
function needsRehash(hash) {
  const parts = String(hash || '').split('$');
  if (parts.length === 6 && parts[0] === HASH_PREFIX) {
    return Number(parts[1]) < SCRYPT_N;
  }
  return true;    // 老格式（裸 hex）→ 需要升级
}

const LOGIN_PW_MIN = 8;      // 安全系数调高：最少 8 位
const LOGIN_PW_MAX = 64;

/**
 * 常见弱口令 —— 即便满足「有字母有数字」也得拦掉。
 *
 * 「12345678」「password1」这类密码字典里全有，撞库时先被试的就是它们。
 * 用户朋友之间互相传密码很常见，这层检查能挡掉大部分「图省事」。
 */
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000',
  'password', 'password1', 'passw0rd', 'p@ssw0rd', 'password123',
  'qwerty123', 'qwertyui', 'abc12345', 'abcd1234', 'a1234567', 'asdf1234',
  'admin123', 'root1234', 'test1234', 'user1234', 'iloveyou', 'sunshine',
  'princess', 'football', 'charlie', 'welcome1', 'letmein1', 'monkey12',
  'dragon12', 'trustno1', 'baseball', 'shadow12', 'superman', 'michael1',
]);

/** 密码强度校验，返回 null 表示没问题，否则返回一句提示 */
function checkPassword(pw) {
  const s = String(pw ?? '');
  if (s.length < LOGIN_PW_MIN) return `密码至少 ${LOGIN_PW_MIN} 位`;
  if (s.length > LOGIN_PW_MAX) return `密码最多 ${LOGIN_PW_MAX} 位`;
  if (WEAK_PASSWORDS.has(s.toLowerCase())) return '这个密码太常见了，换一个难猜的';
  // 至少含一个字母和一个数字
  if (!/[a-zA-Z]/.test(s)) return '密码里要有字母';
  if (!/[0-9]/.test(s)) return '密码里要有数字';
  return null;
}

/* ================================================================== */
/* 账号 + 会话                                                        */
/* ================================================================== */

// 会话有效期：30 天。每次用到就往后延（滑动续期），
// 天天在用的人不会被莫名其妙踢下线。
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 30 * 24 * 60 * 60 * 1000;

// 账号名规则：3-20 位，字母/数字/下划线/短横线/中文。
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{3,20}$/;

// 连续输错密码的容忍次数与锁定时长（逐级加长）
const ACCOUNT_MAX_FAIL = 5;
const ACCOUNT_LOCK_MS = [0, 0, 0, 0, 0, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 3600 * 1000];

/**
 * 账号名归一化：去首尾空格 + 转小写 + 内部空格去掉。
 *
 * 「 Xiao Ming 」和「xiaoming」应该是同一个账号 —— 否则用户换个输入法
 * 空格就登不上。中文不受 toLowerCase 影响。
 */
function normalizeAccountName(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 生成不可预测的会话 token（256 位熵） */
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** sha256 十六进制 —— 会话 token 在库里只存这个 */
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * 校验会话 token，成功返回 { account, user }，失败返回 null。
 *
 * 做了三件事：
 *   1. 过期会话直接删掉（顺便清理）
 *   2. 滑动续期 —— 每次用到就往后延 30 天
 *   3. 绑上当前设备
 */
function resolveSession(token, now, clientId) {
  if (!token) return null;
  const h = sha256(token);
  const s = S.getSession.get(h);
  if (!s) return null;

  if (s.expires_at < now) {
    S.deleteSession.run(h);
    return null;
  }

  const acc = S.findAccountById.get(s.account_id);
  if (!acc) { S.deleteSession.run(h); return null; }

  const urow = S.getUser.get(acc.user_id);
  if (!urow) {
    // 账号还在但身份被删了（理论上不会，因为账号用户受保护）→ 会话作废
    S.deleteSession.run(h);
    return null;
  }

  // 滑动续期
  S.touchSession.run(now + SESSION_TTL_MS, now, h);
  if (clientId) S.bindSessionDevice.run(clientId, h);

  return { account: acc, user: urow };
}

/** 建一个会话，返回明文 token（只在这一刻出现在网络上） */
function createSession(accountId, clientId, now) {
  const token = newSessionToken();
  S.insertSession.run(sha256(token), accountId, clientId || null, now, now + SESSION_TTL_MS, now);
  return token;
}

/* ---------- 按 IP 限流（防暴力破解 / 防刷注册） ---------- */

/**
 * 按 IP 限流（防暴力破解 / 防刷注册）
 *
 * 内存里存，进程重启就清空 —— 对付「脚本不停换 IP」也没用，
 * 但能挡住最常见的「同一个 IP 疯狂试密码」。
 *
 * ⚠️ **只统计失败的认证请求**。
 * 一开始是「所有认证请求都计数」，结果正常用户也有影响：
 * 密码管理器偶尔填错一次、用户自己手滑输错几次，
 * 10 分钟内 20 次就把这个 IP 整个封了 —— 后面连正确的密码都登不进去。
 * 改成只算失败之后，正常使用完全不受影响。
 *
 * 真正的大杀器是账号级锁定（fail_count），这里是第一道闸。
 */
const ipBuckets = new Map();
const IP_LIMIT_WINDOW_MS = 10 * 60 * 1000;    // 10 分钟一个窗口
const IP_LIMIT_MAX = 30;                      // 窗口内最多 30 次**失败**

/** 查一下这个 IP 现在还能不能继续尝试（不计数） */
function ipAllowed(ip, now) {
  if (!ip) return true;      // 拿不到 IP 就放过（本地开发）
  const b = ipBuckets.get(ip);
  if (!b || b.resetAt < now) return true;
  return b.count < IP_LIMIT_MAX;
}

/** 记一次失败 */
function ipFail(ip, now) {
  if (!ip) return;
  const b = ipBuckets.get(ip);
  if (!b || b.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + IP_LIMIT_WINDOW_MS });
    return;
  }
  b.count++;
}

/** 成功了就清零 —— 别让正常用户的历史失误一直挂着 */
function ipSuccess(ip, now) {
  if (!ip) return;
  const b = ipBuckets.get(ip);
  if (b) ipBuckets.delete(ip);
}

/** 定时清掉过期的限流桶，别让内存无限涨 */
function cleanupIpBuckets() {
  const now = Date.now();
  for (const [ip, b] of ipBuckets) {
    if (b.resetAt < now) ipBuckets.delete(ip);
  }
}

/* ================================================================== */
/* 图片头像                                                            */
/* ================================================================== */

/**
 * 校验并保存一张上传的头像图片。
 *
 * 客户端用 canvas 把图片裁成 128×128 的 PNG，base64 发过来。
 * 服务端不信任客户端，所以这里逐项自己验：
 *
 *  1. 长度上限 —— base64 不能超过 MAX_AVATAR_B64
 *  2. 必须是合法的 base64（Buffer 解码不抛错）
 *  3. 魔数必须是 PNG（\x89PNG\r\n\x1a\n）—— 挡掉伪装成图片的任意二进制
 *  4. 解码后不能超过 MAX_AVATAR_BYTES
 *
 * 通过就落盘成 data/avatars/<token>.png，token 是 8 位随机 hex。
 * 返回文件名，存进 users.avatar。
 */
function saveAvatarImage(b64) {
  const raw = String(b64 || '');
  if (!raw) return { ok: false, msg: '没有收到图片' };
  if (raw.length > MAX_AVATAR_B64) return { ok: false, msg: '图片太大了，换一张小一点的' };

  // 只接受纯 base64（不带 data: 前缀）—— 客户端统一剥掉前缀再发
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { ok: false, msg: '图片格式不对' };

  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return { ok: false, msg: '图片格式不对' };
  }
  if (!buf.length) return { ok: false, msg: '图片格式不对' };
  if (buf.length > MAX_AVATAR_BYTES) return { ok: false, msg: '图片太大了，换一张小一点的' };

  // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, msg: '只支持 PNG 图片' };
  }

  const token = crypto.randomBytes(8).toString('hex');
  const filename = `${token}.png`;
  try {
    fs.writeFileSync(path.join(AVATAR_DIR, filename), buf);
  } catch {
    return { ok: false, msg: '保存失败了，稍后再试' };
  }
  return { ok: true, filename };
}

/** 删掉一张头像文件（换掉旧的、或用户行被清理时） */
function removeAvatarFile(filename) {
  if (!filename) return;
  // 只允许我们自己生成的文件名格式 —— 防止路径穿越
  if (!/^[0-9a-f]{16}\.png$/.test(filename)) return;
  try {
    fs.unlinkSync(path.join(AVATAR_DIR, filename));
  } catch { /* 文件本来就不在，无所谓 */ }
}

/**
 * 扫一遍头像目录，把数据库里没人引用的文件删掉。
 *
 * 什么时候会留下孤儿文件：
 *   - 用户换头像时旧文件被覆盖式的替换掉（这个是主动删的）
 *   - 用户行被清理（7 天无消息）后文件还在
 * 所以定期扫一次，避免目录无限膨胀。
 */
function cleanupOrphanAvatars() {
  let names;
  try {
    names = fs.readdirSync(AVATAR_DIR);
  } catch {
    return 0;
  }
  const used = new Set(
    db.prepare("SELECT avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''").all()
      .map((r) => r.avatar)
  );
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{16}\.png$/.test(name)) continue;   // 不认识的文件别乱动
    if (used.has(name)) continue;
    removeAvatarFile(name);
    removed++;
  }
  return removed;
}

/* ================================================================== */
/* 安全响应头                                                          */
/* ================================================================== */
/**
 * 一组安全响应头 —— 浏览器一收到就按这些规则执行。
 *
 * CSP（内容安全策略）是主角：它规定「这个页面只准从自己家里加载东西」。
 * 就算有人想注入一段恶意脚本（XSS），没有 'unsafe-inline' 也执行不了。
 *
 * ⚠️ 这里没写 'unsafe-inline' 是故意的：
 *   - script-src 'self'  → 页面里的 JS 只能来自本服务器
 *   - style-src 允许 inline → 因为 app.js 里有动态设置 style 的逻辑
 *     （设置元素样式属性不算 inline style，CSP 不会拦；
 *      但 style-src 不写 'unsafe-inline' 的话有些浏览器会连
 *      element.style.xxx 都拦掉，所以这里留个口子）
 *
 * connect-src 要带上 wss: —— WebSocket 连的是自己，但协议不同。
 */
const SECURITY_HEADERS = {
  // 禁止被 iframe 嵌套（防点击劫持）
  'X-Frame-Options': 'DENY',
  // 禁止浏览器瞎猜 MIME 类型（防脚本被当 HTML 执行）
  'X-Content-Type-Options': 'nosniff',
  // 页面可能被嵌到哪 → 只告诉它「别把 referer 带走」
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // 关掉一堆用不上的浏览器能力（摄像头、麦克风、地理位置…）
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=()',
  // 内容安全策略
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '),
  // 不泄露服务器用的是 Node.js
  'X-Powered-By': '',
};

// HSTS：告诉浏览器「以后这个域名只准走 HTTPS」。
// 只在真正的 HTTPS 连接上发 —— 本地 http 开发时发这个会让浏览器拒绝再走 http。
// 由 nginx 在 https server 块里加更合适（那是唯一确定是 https 的地方），
// 这里只在 x-forwarded-proto 表明是 https 时才加，双保险。
function securityHeadersFor(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const h = { ...SECURITY_HEADERS };
  if (proto === 'https') {
    // max-age 1 年 + includeSubDomains + preload（preload 需要单独申请，先不加）
    h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

/* ================================================================== */
/* 静态资源                                                            */
/* ================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  // 每个响应都带上安全头（HSTS 只在 https 时加）
  const sec = securityHeadersFor(req);

  // 路由：
  //   /           → 「聊天网页」入口页（点进去就是聊天室）
  //   /chat       → 聊天室本体
  //   其余        → public/ 下的静态文件
  if (pathname === '/' || pathname === '/index.html') pathname = '/entry.html';
  else if (pathname === '/chat' || pathname === '/chat/') pathname = '/index.html';

  /* ---------- 本机取房间口令 ---------- */
  // 只有「从本机直接访问」才给口令：请求来源是回环地址，
  // 且 Host 头是 localhost / 127.0.0.1 —— 公网隧道过来的请求
  // Host 是 xxx.trycloudflare.com，所以拿不到。
  //
  // 效果：主人在本机打开页面能自动进（不用手输口令），
  // 朋友必须用带口令的分享链接，陌生人什么都拿不到。
  if (pathname === '/api/room-key') {
    // ⚠️ 安全要点：反向代理后面 req.socket.remoteAddress 永远是 nginx 的 127.0.0.1，
    // 所以「只看 remoteAddress」等于没校验 —— 任何人都能伪造 `Host: localhost`
    // 拿到房间口令。必须用 X-Forwarded-For 里的**真实客户端 IP**来判断。
    // 没有该头 = 直连本机（本地开发），这时才看 remoteAddress。
    const fwd = String(req.headers['x-forwarded-for'] || '');
    const realIp = (fwd ? fwd.split(',')[0] : String(req.socket.remoteAddress || '')).trim();
    const isLoopback = realIp === '127.0.0.1' || realIp === '::1' || realIp === '::ffff:127.0.0.1';
    const host = String(req.headers.host || '').split(':')[0];
    const localHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!isLoopback || !localHost) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', ...sec });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...sec,
    });
    res.end(JSON.stringify({ key: ROOM_KEY }));
    return;
  }

  /* ---------- 图片头像 ---------- */
  //
  // /avatar/<token>.png
  //
  // 头像是真人照片，所以和房间一样要口令才能看。
  // 但 <img> 标签没法带自定义 header，所以口令走查询参数 ?k=xxx。
  //
  // token 本身是 64 位随机（16 个 hex），猜不到；
  // 口令校验是第二道保险 —— 万一链接被转发，别人的照片不会裸奔。
  if (pathname.startsWith('/avatar/')) {
    const m = /^([0-9a-f]{16})\.png$/.exec(pathname.slice('/avatar/'.length));
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...sec });
      res.end('头像不存在');
      return;
    }
    let given = '';
    try {
      given = new URL(req.url, 'http://localhost').searchParams.get('k') || '';
    } catch { given = ''; }
    if (!keyMatches(given)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...sec });
      res.end('需要房间口令');
      return;
    }
    const avatarPath = path.join(AVATAR_DIR, `${m[1]}.png`);
    fs.readFile(avatarPath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...sec });
        res.end('头像不存在');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        // 文件名带随机 token，内容变了就是新 URL —— 可以放心长期缓存
        'Cache-Control': 'private, max-age=31536000, immutable',
        ...sec,
      });
      res.end(data);
    });
    return;
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><h1>404</h1>页面不存在');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

/* ================================================================== */
/* WebSocket                                                           */
/* ================================================================== */

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true });
const clients = new Map();   // ws -> user
const cidClients = new Map(); // client_id -> ws（同一浏览器重连时顶掉旧连接）

/**
 * WebSocket 升级：路径必须是 /ws
 *
 * 反向代理（Nginx / Cloudflare / 云厂商 LB）后面跑时，Host 头可能是公网域名，
 * 这里不做 Host 校验，只认路径 —— 代理已经把真实域名带过来了。
 */
function handleUpgrade(req, socket, head) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}
server.on('upgrade', handleUpgrade);

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, exceptWs) {
  const raw = JSON.stringify(payload);
  for (const ws of clients.keys()) {
    if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(raw);
  }
}

wss.on('connection', (ws, req) => {
  const now = Date.now();

  /* ---------- 房间口令校验 ---------- */
  // 口令不对的人根本进不来 —— 他不会占用昵称、不会出现在成员列表里，
  // 也不会往历史里写任何东西。内测期间这就是「只留我和朋友」的那道门。
  let roomKey = '';
  try {
    roomKey = String(new URL(req.url, 'http://localhost').searchParams.get('key') || '');
  } catch { roomKey = ''; }

  if (process.env.WS_DEBUG) {
    const ua = String(req.headers['user-agent'] || '').slice(0, 40);
    // ⚠️ 不要把口令原文（req.url 里就有）打进日志：
    //    journalctl 里明文留口令 = 口令等于公开。改成只记长度 + 指纹。
    const fp = crypto.createHash('sha256').update(normalizeKey(roomKey)).digest('hex').slice(0, 8);
    console.log(`[ws] key len=${normalizeKey(roomKey).length} fp=${fp} match=${keyMatches(roomKey)} ua=${ua}`);
  }

  if (!keyMatches(roomKey)) {
    send(ws, { t: 'error', code: 'bad_key', msg: '房间口令不正确' });
    try { ws.close(4001, 'bad key'); } catch { /* ignore */ }
    return;
  }

  /* ---------- 身份解析：优先复用这台设备上次的身份 ---------- */
  let clientId = '';
  let sessionToken = '';
  try {
    const q = new URL(req.url, 'http://localhost').searchParams;
    clientId = String(q.get('cid') || '').slice(0, 64);
    sessionToken = String(q.get('st') || '').slice(0, 128);
  } catch { clientId = ''; sessionToken = ''; }

  /* ---------- 真实客户端 IP（给限流用） ---------- */
  //
  // ⚠️ 反向代理后面 req.socket.remoteAddress 永远是 nginx 的 127.0.0.1，
  // 所以必须取 X-Forwarded-For 里的第一个（最靠近客户端的那个）。
  // 拿不到该头 = 直连本机（本地开发），这时才看 remoteAddress。
  let clientIp = '';
  try {
    const fwd = String(req.headers['x-forwarded-for'] || '');
    clientIp = (fwd ? fwd.split(',')[0] : String(req.socket.remoteAddress || '')).trim();
  } catch { clientIp = ''; }
  ws.clientIp = clientIp;

  // 先查设备绑定表（一台设备只属于一个人）
  let known = null;
  if (clientId) {
    const dev = S.findDevice.get(clientId);
    if (dev) known = S.getUser.get(dev.user_id) || null;
    // 兼容老数据：还没有设备表记录，但 users.client_id 上有
    if (!known) {
      known = S.findByClient.get(clientId);
      if (known) S.setDevice.run(clientId, known.id, now);
    }
  }

  let user;
  if (known) {
    // 同一台设备刷新/重连 → 沿用原来的 id、昵称、颜色、图片头像
    //
    // ⚠️ 用户的核心要求：「进去后名字和头像，没要求改动就保持不变」。
    // 所以这里必须把 avatar 一起带回来 —— 少了它，用户换了图片头像后
    // 一刷新就退回默认头像了。
    user = { id: known.id, name: known.name, color: known.color, avatar: known.avatar || '' };
    user.name = uniqueName(user.name, user.id);   // 期间被别人占用过则自动改名
    if (clientId) {
      // 这个 client_id 可能还挂在别的用户行上（换过身份）→ 先摘掉
      try { S.clearClientOther.run(clientId, user.id); } catch { /* ignore */ }
      try { S.setClient.run(clientId, now, user.id); } catch { /* ignore */ }
      S.setDevice.run(clientId, user.id, now);
    }
    try {
      S.renameUser.run(user.name, user.color, now, user.id);
    } catch (err) {
      // 撞上昵称唯一索引（极端并发）→ 换个名字再写
      user.name = uniqueName(`${user.name}`.slice(0, MAX_NAME - 2) + Math.floor(Math.random() * 90 + 10), user.id);
      S.renameUser.run(user.name, user.color, now, user.id);
    }
  } else {
    user = createUser();
    persistUser(user, now);
    if (clientId) {
      try { S.clearClientOther.run(clientId, user.id); } catch { /* ignore */ }
      try { S.setClient.run(clientId, now, user.id); } catch { /* ignore */ }
      // 这台设备绑定到这个新账号（之后刷新就是「我」了）
      S.setDevice.run(clientId, user.id, now);
    }
  }

  /* ---------- 账号会话：带着 token 连进来 → 直接认回身份 ---------- */
  //
  // 客户端登入成功后把 session token 存 localStorage，之后每次连接都带上。
  // 这样「换设备 + 登入」之后，刷新页面不用再输密码，
  // 而且进来就是原来的名字、头像、历史消息。
  //
  // 优先级：**会话 > 设备绑定**。
  // 场景：设备上先登入了账号 A，后来又在同一台设备登入了账号 B ——
  // 设备绑定指向 B，但会话也指向 B，一致。
  // 反过来（设备绑的是临时身份，会话是账号）→ 账号优先，这正是我们要的。
  let session = null;
  if (sessionToken) {
    session = resolveSession(sessionToken, now, clientId);
    if (session && session.user.id !== user.id) {
      // 会话指向的身份和当前解析出来的不是同一个 → 换成会话那个
      const target = session.user;
      // 当前这个临时身份（一条消息都没发过的）直接清掉，别留僵尸行
      try { S.setClient.run(null, now, user.id); } catch { /* ignore */ }
      if (S.countMsgs.get(user.id).c === 0) {
        try { S.deleteUser.run(user.id); } catch { /* ignore */ }
      }
      user = { id: target.id, name: target.name, color: target.color, avatar: target.avatar || '' };
      user.name = uniqueName(user.name, user.id);
      try { S.renameUser.run(user.name, user.color, now, user.id); } catch { /* ignore */ }
      if (clientId) {
        try { S.clearClientOther.run(clientId, user.id); } catch { /* ignore */ }
        try { S.setClient.run(clientId, now, user.id); } catch { /* ignore */ }
        S.setDevice.run(clientId, user.id, now);
      }
    }
  }
  ws.sessionHash = session ? sha256(sessionToken) : '';

  // 同一 client_id 重新连接（刷新页面）→ 顶掉旧连接，且不广播 leave
  if (clientId) {
    const old = cidClients.get(clientId);
    if (old && old !== ws) {
      old.replaced = true;
      // 用专属关闭码 4002：客户端据此知道「你被新连接顶替了」，
      // 而不是当成网络故障去无限重连（那会造成两个标签页互相踢、无限循环）。
      try { old.close(4002, 'replaced'); } catch { /* ignore */ }
    }
    cidClients.set(clientId, ws);
  }

  ws.user = user;
  ws.clientId = clientId;
  ws.isAlive = true;
  clients.set(ws, user);
  // 注意：这里不再往内存里登记「已占用昵称」。
  // 昵称占用权登记在 users 表上（persistUser 已写入），
  // 离线后依然保留 —— 历史消息里的昵称才不会撞车。

  // 初始化：身份 + 在线成员 + 最近一页历史
  const rows = S.latest.all(PAGE_SIZE);
  const total = S.countAll.get().c;
  const meRow = S.getUserLogin.get(user.id);
  const myAccount = S.findAccountByUser.get(user.id);
  send(ws, {
    t: 'init',
    self: publicUser(user),
    users: [...clients.values()].map(publicUser),
    history: rows.reverse().map(toMessage),
    hasMore: total > rows.length,
    // 头像可选的颜色列表 —— 由服务端下发，客户端照着渲染调色板，
    // 这样客户端和服务端永远用同一份色池，不会出现「选了却没生效」。
    colors: COLOR_POOL,
    // 个人登录密码的状态：
    //   set    → 我自己设过密码（设置面板里显示「已设置」）
    //   hasAny → 房间里有人设过密码（决定要不要显示「登录已有身份」入口）
    loginSet: !!(meRow && meRow.login_hash),
    hasLogin: S.countLoginUsers.get().c > 0,
    // 账号状态：
    //   registered → 我已经注册了账号
    //   username   → 我的账号名
    //   hasAny     → 房间里有人注册了账号（决定要不要显示「登录已有账号」入口）
    registered: !!myAccount,
    username: myAccount ? myAccount.display_name : '',
    hasAnyAccount: S.countAccounts.get().c > 0,
    // 会话是否还有效（带 token 连进来时）
    sessionOk: !!session,
  });

  broadcast({ t: 'join', user: publicUser(user) }, ws);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data.t !== 'string') return;

    switch (data.t) {
      /* ---------- 发送消息 ---------- */
      case 'msg': {
        const text = String(data.text ?? '').slice(0, MAX_TEXT);
        if (!text.trim()) return;

        const replyTo = data.replyTo ? String(data.replyTo).slice(0, 64) : null;
        if (replyTo && !S.getMsg.get(replyTo)) return;   // 引用的消息已不存在

        const id = crypto.randomUUID();
        const ts = Date.now();
        S.insertMsg.run(id, user.id, text, 'text', replyTo, ts);
        S.touchUser.run(ts, user.id);   // 只刷新在线时间，不回写昵称

        broadcast({ t: 'msg', msg: toMessage(S.getMsg.get(id)) });
        break;
      }

      /* ---------- 撤回 ---------- */
      case 'recall': {
        const id = String(data.id ?? '');
        const row = S.getMsg.get(id);
        if (!row) return;
        if (row.sender_id !== user.id) return;                    // 只能撤回自己的
        if (Date.now() - row.created_at > RECALL_WINDOW_MS) return; // 超时
        if (row.kind === 'recalled') return;

        S.recallMsg.run(id);
        broadcast({ t: 'recall', id });
        break;
      }

      /* ---------- 正在输入 ---------- */
      case 'typing': {
        broadcast({ t: 'typing', user: publicUser(user) }, ws);
        break;
      }

      /* ---------- 改名（原有逻辑，不动） ---------- */
      case 'nick': {
        const raw = String(data.name ?? '').trim().slice(0, MAX_NAME);
        if (!raw) return;
        // 与「在线 + 历史」中的任何昵称冲突时自动加后缀
        let name = uniqueName(raw, user.id);
        // 撞上唯一索引（两人同时改名）时换个后缀再试
        for (let i = 0; i < 5; i++) {
          try {
            S.renameUser.run(name, user.color, Date.now(), user.id);
            break;
          } catch (err) {
            const msg = String((err && err.message) || err);
            if (!/UNIQUE|constraint/i.test(msg)) throw err;
            name = uniqueName(`${name}`.slice(0, MAX_NAME - 2) + Math.floor(Math.random() * 90 + 10), user.id);
          }
        }
        user.name = name;
        broadcast({ t: 'nick', user: publicUser(user) });
        break;
      }

      /* ---------- 换头像色（新增） ---------- */
      case 'avatar': {
        const now = Date.now();
        const c = String(data.color ?? '').trim().toLowerCase();
        // 只认服务端色池里的颜色 —— 客户端传什么都不能写进库里
        if (!COLOR_POOL.includes(c)) {
          send(ws, { t: 'avatarAck', ok: false, msg: '这个颜色不可用' });
          return;
        }
        if (c !== user.color) {
          // 连点保护：1 秒内不让反复换（防刷广播）
          if (user.colorAt && now - user.colorAt < COLOR_COOLDOWN_MS) {
            send(ws, { t: 'avatarAck', ok: false, msg: '换得太快啦，等一下再试' });
            return;
          }
          user.color = c;
          user.colorAt = now;
          S.renameUser.run(user.name, user.color, now, user.id);
        }
        // 选了颜色 = 回到「字母头像」，把之前的图片头像撤掉
        if (user.avatar) {
          removeAvatarFile(user.avatar);
          user.avatar = '';
          S.setAvatar.run('', now, user.id);
        }
        broadcast({ t: 'avatar', user: publicUser(user) });
        send(ws, { t: 'avatarAck', ok: true, user: publicUser(user) });
        break;
      }

      /* ---------- 上传图片头像（从相册选一张） ---------- */
      case 'avatarImage': {
        const now = Date.now();
        // 连点保护：3 秒内不让连续上传（换图比换色重，间隔给足）
        if (user.avatarAt && now - user.avatarAt < AVATAR_COOLDOWN_MS) {
          send(ws, { t: 'avatarAck', ok: false, msg: '换得太快啦，等一下再试' });
          return;
        }

        const saved = saveAvatarImage(data.data);
        if (!saved.ok) {
          send(ws, { t: 'avatarAck', ok: false, msg: saved.msg });
          return;
        }

        // 旧的图片头像用完就删 —— 不留孤儿文件在磁盘上
        const oldAvatar = user.avatar;
        user.avatar = saved.filename;
        user.avatarAt = now;
        S.setAvatar.run(user.avatar, now, user.id);
        if (oldAvatar && oldAvatar !== saved.filename) removeAvatarFile(oldAvatar);

        broadcast({ t: 'avatar', user: publicUser(user) });
        send(ws, { t: 'avatarAck', ok: true, user: publicUser(user) });
        break;
      }

      /* ---------- 加载更早的历史 ---------- */
      case 'loadMore': {
        const before = Number(data.before) || Date.now();
        const rows = S.olderThan.all(before, PAGE_SIZE);
        const remaining = S.countAll.get().c;
        send(ws, {
          t: 'history',
          messages: rows.reverse().map(toMessage),
          hasMore: remaining > PAGE_SIZE + rows.length,
        });
        break;
      }

      /* ================= 个人登录密码 ================= */

      /* ---------- 查询状态：我设了没？房间里有人设了没？ ---------- */
      case 'loginInfo': {
        const row = S.getUserLogin.get(user.id);
        send(ws, {
          t: 'loginInfo',
          set: !!(row && row.login_hash),
          hasAny: S.countLoginUsers.get().c > 0,
        });
        break;
      }

      /* ---------- 设置密码（第一次） ---------- */
      case 'loginSet': {
        const pw = String(data.pw ?? '');
        const bad = checkPassword(pw);
        if (bad) { send(ws, { t: 'loginAck', ok: false, msg: bad }); break; }

        const { salt, hash } = hashPassword(pw);
        S.setLogin.run(hash, salt, user.id);
        send(ws, { t: 'loginAck', ok: true, msg: '登录密码已设置', set: true });
        break;
      }

      /* ---------- 修改密码（要验旧密码） ---------- */
      case 'loginChange': {
        const row = S.getUserLogin.get(user.id);
        if (!row || !row.login_hash) {
          send(ws, { t: 'loginAck', ok: false, msg: '还没设置过密码' });
          break;
        }
        if (!verifyPassword(String(data.oldPw ?? ''), row.login_hash, row.login_salt)) {
          send(ws, { t: 'loginAck', ok: false, msg: '原密码不对' });
          break;
        }
        const bad = checkPassword(String(data.newPw ?? ''));
        if (bad) { send(ws, { t: 'loginAck', ok: false, msg: bad }); break; }

        const { salt, hash } = hashPassword(String(data.newPw));
        S.setLogin.run(hash, salt, user.id);
        send(ws, { t: 'loginAck', ok: true, msg: '密码已修改', set: true });
        break;
      }

      /* ---------- 移除密码 ---------- */
      case 'loginRemove': {
        const row = S.getUserLogin.get(user.id);
        if (!row || !row.login_hash) {
          send(ws, { t: 'loginAck', ok: false, msg: '还没设置过密码' });
          break;
        }
        if (!verifyPassword(String(data.pw ?? ''), row.login_hash, row.login_salt)) {
          send(ws, { t: 'loginAck', ok: false, msg: '密码不对' });
          break;
        }
        S.clearLogin.run(user.id);
        send(ws, { t: 'loginAck', ok: true, msg: '密码已移除', set: false });
        break;
      }

      /* ---------- 登录：把原来的身份认回来 ---------- */
      //
      // 场景：换手机、换电脑、清了浏览器缓存 → 本机没有 client_id，
      // 服务端给的是个临时昵称。这时用「昵称 + 密码」把原来的身份换回来。
      case 'loginClaim': {
        const name = String(data.name ?? '').trim().slice(0, MAX_NAME);
        const pw = String(data.pw ?? '');
        if (!name || !pw) {
          send(ws, { t: 'loginAck', ok: false, msg: '请填写昵称和密码' });
          break;
        }

        const row = S.findByName.get(name);
        // 密码错 / 没设过密码 —— 两种情况给同一句话，避免被拿来探昵称
        if (!row || !row.login_hash || !verifyPassword(pw, row.login_hash, row.login_salt)) {
          send(ws, { t: 'loginAck', ok: false, msg: '昵称或密码不对' });
          break;
        }
        if (row.id === user.id) {
          // 已经是这个身份了，不用换
          send(ws, { t: 'loginOk', user: publicUser(user), unchanged: true });
          break;
        }

        const oldUser = user;
        const now = Date.now();

        // 1) 临时身份先摘掉 client_id（不然会撞唯一索引），一条消息都没发过的直接删掉，
        //    把这个昵称立刻释放回池子 —— 不留「用完就扔」的僵尸行
        try { S.setClient.run(null, now, oldUser.id); } catch { /* ignore */ }
        if (S.countMsgs.get(oldUser.id).c === 0) {
          try { S.deleteUser.run(oldUser.id); } catch { /* ignore */ }
        }

        // 2) 这台设备绑定到这个账号 → 以后刷新就是「我」，不用再输密码。
        //    老设备（手机、电脑）的绑定不动 —— 同一个账号可以同时在好几台上。
        if (ws.clientId) {
          try { S.setDevice.run(ws.clientId, row.id, now); } catch { /* ignore */ }
        }

        // 3) 切换身份
        user = { id: row.id, name: row.name, color: row.color, avatar: row.avatar || '' };
        ws.user = user;
        clients.set(ws, user);

        // 4) 告诉其他人：临时昵称走了，「我」回来了
        broadcast({ t: 'identity', user: publicUser(user), prev: publicUser(oldUser) }, ws);

        // 5) 回执 + 最新一页历史（把身份换回来后，历史消息里「我」的那些也会变成自己的）
        const rows2 = S.latest.all(PAGE_SIZE);
        const total2 = S.countAll.get().c;
        send(ws, {
          t: 'loginOk',
          user: publicUser(user),
          prev: publicUser(oldUser),
          // 换回来的这个身份设过密码 → 客户端把「已设置」状态也带过去
          loginSet: !!row.login_hash,
          history: rows2.reverse().map(toMessage),
          hasMore: total2 > rows2.length,
        });
        break;
      }

      /* ================= 账号（注册 / 登入） ================= */

      /* ---------- 查询账号状态 ---------- */
      case 'accountInfo': {
        const acc = S.findAccountByUser.get(user.id);
        send(ws, {
          t: 'accountInfo',
          registered: !!acc,
          username: acc ? acc.display_name : '',
          hasAny: S.countAccounts.get().c > 0,
        });
        break;
      }

      /* ---------- 注册账号 ---------- */
      //
      // 注册时**绑定当前这个身份**（昵称、头像、历史消息全都保留）——
      // 不是新建一个空身份。用户在房间里用着「小明」，注册一下，
      // 从此这个身份就能在任何设备上用账号密码认回来。
      case 'accountRegister': {
        const now = Date.now();
        const rawName = String(data.username ?? '').trim().slice(0, 20);
        const pw = String(data.password ?? '');
        const pw2 = String(data.password2 ?? '');

        if (!ipAllowed(ws.clientIp, now)) {
          send(ws, { t: 'accountAck', ok: false, msg: '尝试次数太多，先歇一会儿再试' });
          break;
        }

        if (!ACCOUNT_NAME_RE.test(rawName)) {
          send(ws, { t: 'accountAck', ok: false, msg: '账号名要 3-20 位，字母、数字、下划线或中文' });
          break;
        }
        const nameKey = normalizeAccountName(rawName);
        if (!nameKey) {
          send(ws, { t: 'accountAck', ok: false, msg: '账号名不能只有空格' });
          break;
        }
        if (S.findAccount.get(nameKey)) {
          send(ws, { t: 'accountAck', ok: false, msg: '这个账号名已经被占了' });
          break;
        }
        if (S.findAccountByUser.get(user.id)) {
          send(ws, { t: 'accountAck', ok: false, msg: '你已经注册过账号了' });
          break;
        }
        const bad = checkPassword(pw);
        if (bad) { send(ws, { t: 'accountAck', ok: false, msg: bad }); break; }
        if (pw !== pw2) { send(ws, { t: 'accountAck', ok: false, msg: '两次输入的密码不一样' }); break; }

        const { salt, hash } = hashPassword(pw);
        const accId = crypto.randomUUID();
        try {
          S.insertAccount.run(accId, nameKey, rawName, hash, salt, user.id, now);
        } catch (err) {
          const m = String((err && err.message) || err);
          if (/UNIQUE|constraint/i.test(m)) {
            send(ws, { t: 'accountAck', ok: false, msg: '这个账号名已经被占了' });
          } else {
            send(ws, { t: 'accountAck', ok: false, msg: '注册失败，稍后再试' });
          }
          break;
        }

        const token = createSession(accId, ws.clientId, now);
        send(ws, {
          t: 'accountAck',
          ok: true,
          msg: '账号已创建',
          username: rawName,
          token,
          user: publicUser(user),
        });
        break;
      }

      /* ---------- 登入账号 ---------- */
      case 'accountLogin': {
        const now = Date.now();
        const nameKey = normalizeAccountName(data.username ?? '');
        const pw = String(data.password ?? '');

        if (!ipAllowed(ws.clientIp, now)) {
          send(ws, { t: 'accountAck', ok: false, msg: '尝试次数太多，先歇一会儿再试' });
          break;
        }
        if (!nameKey || !pw) {
          send(ws, { t: 'accountAck', ok: false, msg: '请填写账号和密码' });
          break;
        }

        const acc = S.findAccount.get(nameKey);

        // 账号被锁了（连续输错太多次）
        if (acc && acc.locked_until > now) {
          const mins = Math.ceil((acc.locked_until - now) / 60000);
          send(ws, { t: 'accountAck', ok: false, msg: `密码错太多次，${mins} 分钟后再试` });
          break;
        }

        // 账号不存在 / 密码错 —— 给同一句话，不泄露「这个账号存在」
        // （否则可以拿账号名列表来试探谁注册过）
        if (!acc || !verifyPassword(pw, acc.pass_hash, acc.pass_salt)) {
          ipFail(ws.clientIp, now);
          if (acc) {
            // 失败计数 + 逐级锁定
            const fails = acc.fail_count + 1;
            const lockIdx = Math.min(fails, ACCOUNT_LOCK_MS.length - 1);
            const until = fails >= ACCOUNT_MAX_FAIL ? now + ACCOUNT_LOCK_MS[lockIdx] : 0;
            S.bumpAccountFail.run(until, acc.id);
            // ⚠️ 达到阈值的那一次就直接告诉用户「已锁定」，
            //    别让人再输第 6、7 次才知道自己被挡了。
            if (until > 0) {
              const mins = Math.ceil((until - now) / 60000);
              send(ws, { t: 'accountAck', ok: false, msg: `密码错太多次，账号已锁定，${mins} 分钟后再试` });
              break;
            }
          }
          send(ws, { t: 'accountAck', ok: false, msg: '账号或密码不对' });
          break;
        }

        // 密码对上了
        ipSuccess(ws.clientIp, now);
        S.resetAccountFail.run(acc.id);
        S.touchAccountLogin.run(now, acc.id);

        const targetId = acc.user_id;
        const row = S.getUser.get(targetId);
        if (!row) {
          send(ws, { t: 'accountAck', ok: false, msg: '这个账号绑定的身份已经不在了' });
          break;
        }

        const token = createSession(acc.id, ws.clientId, now);

        if (row.id === user.id) {
          // 已经是这个身份 —— 不用换，直接发 token
          send(ws, {
            t: 'accountAck',
            ok: true,
            msg: '登录成功',
            username: acc.display_name,
            token,
            user: publicUser(user),
            unchanged: true,
          });
          break;
        }

        const oldUser = user;

        // 1) 临时身份摘掉 client_id 并按需删掉（一条消息都没发过的直接清掉）
        try { S.setClient.run(null, now, oldUser.id); } catch { /* ignore */ }
        if (S.countMsgs.get(oldUser.id).c === 0) {
          try { S.deleteUser.run(oldUser.id); } catch { /* ignore */ }
        }

        // 2) 这台设备绑到这个账号 → 以后刷新就是「我」
        if (ws.clientId) {
          try { S.setDevice.run(ws.clientId, row.id, now); } catch { /* ignore */ }
        }

        // 3) 切换身份
        user = { id: row.id, name: row.name, color: row.color, avatar: row.avatar || '' };
        ws.user = user;
        clients.set(ws, user);

        // 4) 告诉其他人：临时昵称走了，「我」回来了
        broadcast({ t: 'identity', user: publicUser(user), prev: publicUser(oldUser) }, ws);

        // 5) 回执 + 最新一页历史
        const rows2 = S.latest.all(PAGE_SIZE);
        const total2 = S.countAll.get().c;
        send(ws, {
          t: 'accountAck',
          ok: true,
          msg: '登录成功',
          username: acc.display_name,
          token,
          user: publicUser(user),
          prev: publicUser(oldUser),
          history: rows2.reverse().map(toMessage),
          hasMore: total2 > rows2.length,
        });
        break;
      }

      /* ---------- 退出登录（作废本机会话） ---------- */
      case 'accountLogout': {
        if (ws.sessionHash) {
          S.deleteSession.run(ws.sessionHash);
          ws.sessionHash = '';
        }
        send(ws, { t: 'accountAck', ok: true, msg: '已退出登录', loggedOut: true });
        break;
      }

      /* ---------- 修改账号密码 ---------- */
      case 'accountChangePw': {
        const now = Date.now();
        const acc = S.findAccountByUser.get(user.id);
        if (!acc) {
          send(ws, { t: 'accountAck', ok: false, msg: '还没有注册账号' });
          break;
        }
        const oldPw = String(data.oldPw ?? '');
        const newPw = String(data.newPw ?? '');
        if (!verifyPassword(oldPw, acc.pass_hash, acc.pass_salt)) {
          send(ws, { t: 'accountAck', ok: false, msg: '原密码不对' });
          break;
        }
        const bad = checkPassword(newPw);
        if (bad) { send(ws, { t: 'accountAck', ok: false, msg: bad }); break; }

        const { salt, hash } = hashPassword(newPw);
        S.updateAccountPw.run(hash, salt, acc.id);
        // 改完密码 → 这个账号的所有会话作废，逼其它设备重新登入
        S.deleteAccountSessions.run(acc.id);
        const token = createSession(acc.id, ws.clientId, now);
        send(ws, {
          t: 'accountAck',
          ok: true,
          msg: '密码已修改，其它设备需要重新登录',
          username: acc.display_name,
          token,
          user: publicUser(user),
        });
        break;
      }
    }
  });

  ws.on('close', (code, reason) => {
    if (process.env.WS_DEBUG) {
      console.log(`[ws-close] cid=${ws.clientId || '-'} user=${user.name} code=${code} reason=${String(reason || '')} replaced=${!!ws.replaced} alive=${ws.isAlive}`);
    }
    clients.delete(ws);
    if (ws.clientId && cidClients.get(ws.clientId) === ws) cidClients.delete(ws.clientId);
    // 被同浏览器新连接顶替的旧连接不算"离开"，否则成员列表会闪一下
    // 注意：离线不释放昵称 —— 用户行还在，昵称继续被占用，
    // 这样历史消息里就不会出现两个同名的人。
    if (!ws.replaced) {
      // 同一个账号在别的设备上还开着 → 不算离开（手机关了电脑还在线）
      let stillHere = false;
      for (const u of clients.values()) {
        if (u.id === user.id) { stillHere = true; break; }
      }
      if (!stillHere) {
        broadcast({ t: 'leave', user: publicUser(user) });
      }
    }
  });

  ws.on('error', () => { /* close 会负责清理 */ });
});

/** 心跳保活：清掉半开连接 */
const heartbeat = setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
  // 在线用户的用户行定期刷新 last_seen。
  // 否则「一直在线但久不发言」的人会被清理任务当成僵尸行删掉，
  // 他的昵称占用权就跟着没了 —— 那样又会出现历史撞名。
  const ts = Date.now();
  for (const u of clients.values()) {
    try { S.touchUser.run(ts, u.id); } catch { /* ignore */ }
  }
}, 30000);

const cleaner = setInterval(cleanupOldData, CLEANUP_INTERVAL_MS);

// 会话清理：过期会话删掉，限流桶清空
const sessionCleaner = setInterval(() => {
  const now = Date.now();
  const removed = S.deleteExpiredSessions.run(now).changes;
  cleanupIpBuckets();
  if (removed) console.log(`[cleanup] 清理过期会话 ${removed} 个`);
}, 60 * 60 * 1000);

migrateUniqueNames();   // 昵称全局唯一（在线 + 历史一起算）
migrateColors();
cleanupOldData();

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(cleaner);
  clearInterval(sessionCleaner);
});

server.listen(PORT, HOST, () => {
  console.log(`聊天室已启动 → http://localhost:${PORT}`);
  console.log(`数据文件: ${path.join(DATA_DIR, 'chat.db')}`);
  console.log(`消息保留 ${RETENTION_MS / 86400000} 天,撤回时限 ${RECALL_WINDOW_MS / 60000} 分钟`);
  if (ROOM_KEY) {
    // ⚠️ 不要把口令原文打进日志：journal 会被日志轮转、备份、导出。
    //    要拿真值用 `cat data/room.key` 或 `bash deploy/print-link.sh`。
    console.log(`房间口令: 已设置（${ROOM_KEY.length} 位）— 用 deploy/print-link.sh 生成可分享链接`);
    if (ROOM_KEY_SPARE) console.log(`备用口令: 已设置（${ROOM_KEY_SPARE.length} 位，主口令失效时仍可进）`);
  } else {
    console.log('房间口令: 未设置（公开房间，谁都能进）');
  }
});

// 备用端口：本地开发方便；部署环境用 ALT_PORT=0 关掉
if (ALT_PORT > 0) {
  const altServer = http.createServer(serveStatic);
  altServer.on('upgrade', handleUpgrade);
  altServer.on('error', (err) => {
    console.warn(`[warn] 备用端口 ${ALT_PORT} 启动失败（${err.code}），忽略`);
  });
  altServer.listen(ALT_PORT, HOST, () => {
    console.log(`备用端口 → http://localhost:${ALT_PORT}/chat`);
  });
}
