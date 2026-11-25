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

const S = {
  // 新用户：纯 INSERT。名字的唯一性由 idx_users_name 唯一索引在存储层兜底
  insertUser: db.prepare(`
    INSERT INTO users (id, name, color, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?)
  `),
  renameUser: db.prepare('UPDATE users SET name = ?, color = ?, last_seen = ? WHERE id = ?'),
  getUser: db.prepare('SELECT id, name, color FROM users WHERE id = ?'),
  findByClient: db.prepare('SELECT id, name, color FROM users WHERE client_id = ?'),
  setClient: db.prepare('UPDATE users SET client_id = ?, last_seen = ? WHERE id = ?'),
  // 昵称占用查询：排除自己后，还有没有别人占着这个名字（在线 + 历史一起算）
  takenByName: db.prepare('SELECT COUNT(*) AS c FROM users WHERE name = ? AND id <> ?'),
  // 所有已被占用的昵称（自动分配昵称时避开）
  listUsers: db.prepare('SELECT id, name, color FROM users'),
  // 在线成员的心跳（防止久不发言的在线用户被清理掉）
  touchUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  insertMsg: db.prepare(
    'INSERT INTO messages (id, sender_id, text, kind, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getMsg: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.kind, m.reply_to_id, m.created_at, u.name, u.color
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `),
  recallMsg: db.prepare("UPDATE messages SET text = '', kind = 'recalled' WHERE id = ?"),
  latest: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.kind, m.reply_to_id, m.created_at, u.name, u.color
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    ORDER BY m.created_at DESC LIMIT ?
  `),
  olderThan: db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.kind, m.reply_to_id, m.created_at, u.name, u.color
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.created_at < ?
    ORDER BY m.created_at DESC LIMIT ?
  `),
  countAll: db.prepare('SELECT COUNT(*) AS c FROM messages'),
  deleteOlder: db.prepare('DELETE FROM messages WHERE created_at < ?'),
  deleteStaleUsers: db.prepare(`
    DELETE FROM users
    WHERE id NOT IN (SELECT DISTINCT sender_id FROM messages)
      AND last_seen < ?
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
  return { id: u.id, name: u.name, color: u.color };
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
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ key: ROOM_KEY }));
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

  /* ---------- 身份解析：优先复用该浏览器上次的身份 ---------- */
  let clientId = '';
  try {
    clientId = String(new URL(req.url, 'http://localhost').searchParams.get('cid') || '').slice(0, 64);
  } catch { clientId = ''; }

  const known = clientId ? S.findByClient.get(clientId) : null;

  let user;
  if (known) {
    // 同一浏览器刷新/重连 → 沿用原来的 id、昵称、颜色
    user = { id: known.id, name: known.name, color: known.color };
    user.name = uniqueName(user.name, user.id);   // 期间被别人占用过则自动改名
    S.setClient.run(clientId, now, user.id);
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
    if (clientId) S.setClient.run(clientId, now, user.id);
  }

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
  send(ws, {
    t: 'init',
    self: publicUser(user),
    users: [...clients.values()].map(publicUser),
    history: rows.reverse().map(toMessage),
    hasMore: total > rows.length,
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

      /* ---------- 改名 ---------- */
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
      broadcast({ t: 'leave', user: publicUser(user) });
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
migrateUniqueNames();   // 昵称全局唯一（在线 + 历史一起算）
migrateColors();
cleanupOldData();

wss.on('close', () => { clearInterval(heartbeat); clearInterval(cleaner); });

server.listen(PORT, HOST, () => {
  console.log(`聊天室已启动 → http://localhost:${PORT}`);
  console.log(`数据文件: ${path.join(DATA_DIR, 'chat.db')}`);
  console.log(`消息保留 ${RETENTION_MS / 86400000} 天,撤回时限 ${RECALL_WINDOW_MS / 60000} 分钟`);
  if (ROOM_KEY) {
    console.log(`房间口令: ${ROOM_KEY}   （加到链接后面就能进来：…/chat#key=${ROOM_KEY}）`);
    if (ROOM_KEY_SPARE) console.log(`备用口令: ${ROOM_KEY_SPARE}   （主口令那一版失效时的备选）`);
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
