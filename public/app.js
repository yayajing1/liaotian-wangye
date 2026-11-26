/* ================================================================
   多人网页聊天室 —— 客户端
   核心渲染规则：自己的消息靠右（蓝气泡），别人的靠左（灰气泡）
   ================================================================ */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    conn: $('conn'), connText: $('connText'),
    meAvatar: $('meAvatar'), meName: $('meName'), nickBtn: $('nickBtn'),
    userList: $('userList'), userCount: $('userCount'),
    messages: $('messages'), moreWrap: $('moreWrap'), moreBtn: $('moreBtn'),
    typing: $('typing'),
    quoteBar: $('quoteBar'), quoteLabel: $('quoteLabel'), quoteText: $('quoteText'),
    quoteClose: $('quoteClose'),
    input: $('input'), sendBtn: $('sendBtn'), emojiBtn: $('emojiBtn'), emojiPanel: $('emojiPanel'),
    keyModal: $('keyModal'), keyModalDesc: $('keyModalDesc'), keyInput: $('keyInput'),
    keyLen: $('keyLen'), keyPaste: $('keyPaste'), keyErr: $('keyErr'),
    keyOk: $('keyOk'), keyCancel: $('keyCancel'),
    avatarModal: $('avatarModal'), colorGrid: $('colorGrid'), avatarCancel: $('avatarCancel'),
    avatarFile: $('avatarFile'), avatarUploadPreview: $('avatarUploadPreview'),
    avatarConfirm: $('avatarConfirm'), avatarPreview: $('avatarPreview'),
    avatarPreviewName: $('avatarPreviewName'), avatarErr: $('avatarErr'),
    avatarConfirmOk: $('avatarConfirmOk'), avatarConfirmCancel: $('avatarConfirmCancel'),
    // 登录设置
    settingsBtn: $('settingsBtn'), loginBtn: $('loginBtn'),
    settingsModal: $('settingsModal'), settingsErr: $('settingsErr'),
    pwViewSet: $('pwViewSet'), pwViewSet2: $('pwViewSet2'),
    pwViewChange: $('pwViewChange'), pwViewDel: $('pwViewDel'),
    pwSet1: $('pwSet1'), pwSet2: $('pwSet2'),
    pwOld: $('pwOld'), pwChg1: $('pwChg1'), pwChg2: $('pwChg2'), pwDel: $('pwDel'),
    pwActionsSet: $('pwActionsSet'), pwActionsSet2: $('pwActionsSet2'),
    pwActionsChange: $('pwActionsChange'), pwActionsDel: $('pwActionsDel'),
    settingsCancel: $('settingsCancel'), settingsCancel2: $('settingsCancel2'),
    pwSave: $('pwSave'), pwChangeBtn: $('pwChangeBtn'), pwRemoveBtn: $('pwRemoveBtn'),
    pwChangeBack: $('pwChangeBack'), pwChangeOk: $('pwChangeOk'),
    pwDelBack: $('pwDelBack'), pwDelOk: $('pwDelOk'),
    // 登录身份
    loginModal: $('loginModal'), loginName: $('loginName'), loginPw: $('loginPw'),
    loginErr: $('loginErr'), loginOk: $('loginOk'), loginCancel: $('loginCancel'),
    // 账号（注册 / 登入）
    accountBtn: $('accountBtn'), accountBtnTxt: $('accountBtnTxt'),
    accountModal: $('accountModal'), accountDesc: $('accountDesc'),
    // 第 1 步：选「登入 / 注册」
    accStepPick: $('accStepPick'), accStepLogin: $('accStepLogin'), accStepReg: $('accStepReg'),
    accPickLogin: $('accPickLogin'), accPickReg: $('accPickReg'),
    accBackLogin: $('accBackLogin'), accBackReg: $('accBackReg'),
    accLoginName: $('accLoginName'), accLoginPw: $('accLoginPw'), accLoginErr: $('accLoginErr'),
    accLoginBtn: $('accLoginBtn'),
    accRegName: $('accRegName'), accRegPw: $('accRegPw'), accRegPw2: $('accRegPw2'),
    accRegErr: $('accRegErr'), accRegBtn: $('accRegBtn'),
    accState: $('accState'), accStateName: $('accStateName'), accLogoutBtn: $('accLogoutBtn'),
    accCloseBtn: $('accCloseBtn'),
    // 清除本机聊天记录
    clearHistBtn: $('clearHistBtn'), clearModal: $('clearModal'),
    clearModalDesc: $('clearModalDesc'), clearErr: $('clearErr'),
    clearOk: $('clearOk'), clearCancel: $('clearCancel'),
  };

  const RECALL_WINDOW = 2 * 60 * 1000;    // 撤回时限
  const GROUP_WINDOW = 5 * 60 * 1000;     // 连续消息合并的间隔
  const TYPING_TTL = 3200;                // 输入中提示的存活时间
  const BASE_TITLE = '聊天网页';
  const AVATAR_SIZE = 128;                // 图片头像边长（与服务端一致）

  const EMOJIS = [
    '😀','😄','😁','😊','🙂','😉','😍','🥰',
    '😎','🤔','🤗','😏','😢','😭','😤','😡',
    '👍','👎','👏','🙌','🙏','💪','✌️','🤝',
    '🎉','🔥','✨','💯','❤️','💔','⭐','🌈',
    '🍎','🍉','🍔','🍕','☕','🍺','🎂','🍰',
  ];

  // 兜底色池：正常情况下服务端会在 init 里下发 state.colors，
  // 这里只是万一服务端是旧版本时，弹窗里还有个能用的列表。
  const FALLBACK_COLORS = [
    '#d4eddc', '#a8dcb9', '#7acd95', '#4abf71',
    '#f8d3dc', '#ef9fb3', '#e86888', '#e52e5c',
    '#fdf6dd', '#f7e39a', '#f0cf5c', '#e5b52a',
    '#e0d7f4', '#baa6e7', '#9374dc', '#6d41d2',
    '#ffffff', '#ebebeb', '#d4d4d4', '#b8b8b8',
    '#9a9a9a', '#6e6e6e', '#464646', '#262626',
  ];

  const state = {
    self: null,
    users: new Map(),      // id -> { id, name, color }
    messages: [],          // 按时间升序
    byId: new Map(),       // id -> message
    replyTo: null,
    hasMore: false,
    loadingMore: false,
    unread: 0,
    typing: new Map(),     // id -> { name, ts }
    ws: null,
    retry: 0,
    lastTypingSent: 0,
    key: '',           // 房间口令（当前正在用的）
    savedKey: '',      // 本机上次验证通过、记住的口令
    keyResolved: false, // 是否已经确定「这个房间要不要口令」（公开房间也算确定）
    triedFallback: false, // 链接口令失败后是否已试过回退
    takeover: false,   // 被别的连接顶替了，等用户点「重新进入」
    colors: [],        // 可选头像色（服务端下发，客户端只照着渲染）
    pickedColor: '',   // 在调色板里选中、但还没确认的颜色
    pickedImage: '',       // 选中的图片（dataURL），还没确认
    pickedImageData: '',   // 选中的图片（dataURL），待上传
    loginSet: false,   // 我有没有设置个人登录密码
    hasLogin: false,   // 房间里有没有人设置过个人登录密码
    registered: false, // 我有没有注册账号
    username: '',      // 我的账号名
    hasAnyAccount: false, // 房间里有没有人注册了账号
    accStep: 'pick',   // 账号弹窗当前停在哪一步：pick（选登入/注册）→ login / reg（填密码）
    accAutoOpened: false, // 本次打开是否已经自动弹过账号选择（只弹一次）
    clearedAt: 0,     // 本机已清除记录的时间戳：比它早的消息不再显示（0 = 没清过）
  };

  /* ---------------- 工具 ---------------- */

  /**
   * 客户端持久身份（client_id）
   * 存在 localStorage 里 → 刷新页面 / 关掉重开仍是同一个人，
   * 自己发的历史消息不会被误判成"别人发的"而跑到左边。
   */
  const CID_KEY = 'chat_client_id';

  function getClientId() {
    let cid = '';
    try { cid = localStorage.getItem(CID_KEY) || ''; } catch { cid = ''; }
    if (!cid) {
      // 注意：局域网 IP 访问不是安全上下文，crypto.randomUUID 可能不可用
      cid = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(CID_KEY, cid); } catch { /* ignore */ }
    }
    return cid;
  }

  /* ---------------- 账号会话 token ---------------- */

  const TOKEN_STORE = 'chat_account_token';

  /**
   * 读会话 token
   *
   * 登入成功后服务端会发一个 token，存 localStorage。
   * 之后每次连接都带上它 → 服务端直接认回身份，不用再输密码。
   *
   * 存 localStorage 而不是 sessionStorage：换标签页、关掉重开都还在。
   * 风险是「共用电脑」能拿到 —— 但这台是私人服务器，房间口令本身也是
   * 靠链接传的，威胁模型一样，可接受。
   */
  function getToken() {
    try { return localStorage.getItem(TOKEN_STORE) || ''; } catch { return ''; }
  }

  function setToken(tok) {
    try {
      if (tok) localStorage.setItem(TOKEN_STORE, tok);
      else localStorage.removeItem(TOKEN_STORE);
    } catch { /* ignore */ }
  }

  /* ---------------- 房间口令 ---------------- */

  const KEY_STORE = 'chat_room_key';

  /**
   * 口令归一化 —— 必须和服务端 server.js 里的 normalizeKey 一致。
   * 全角转半角、去掉所有空白、忽略大小写。
   * 手机输入法很容易在"看起来对"的口令里塞进一个全角空格或者把首字母大写，
   * 不归一化就会变成"口令不正确"。
   */
  function normalizeKey(raw) {
    return String(raw === undefined || raw === null ? '' : raw)
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  /**
   * 读口令 —— 分成两份，互不覆盖。
   *
   *   urlKey   链接里带的（?key=xxx 或 #key=xxx）
   *   savedKey 本机上次**验证通过**、记住的
   *
   * 之前只有一个变量：先读链接，读不到才读 localStorage，
   * 而且读到链接里那份就立刻写进 localStorage。
   * 结果链接里那份只要错一位（人工誊写时看错 l/1、0/O），
   * 就会把本机本来正确的那份也一起顶掉，用户只能干瞪眼。
   */
  function readKeys() {
    let urlKey = '';
    try {
      urlKey = new URLSearchParams(location.search).get('key') || '';
      if (!urlKey && location.hash) {
        urlKey = new URLSearchParams(location.hash.replace(/^#/, '')).get('key') || '';
      }
    } catch { urlKey = ''; }

    let savedKey = '';
    try { savedKey = localStorage.getItem(KEY_STORE) || ''; } catch { savedKey = ''; }

    return { urlKey: normalizeKey(urlKey), savedKey: normalizeKey(savedKey) };
  }

  /**
   * 向服务端要口令（本机才有）。
   *
   * 服务端只对本机直连的请求返回这个接口 ——
   * 走公网隧道过来的人拿不到，必须用带口令的链接。
   *
   * ⚠️ 返回值是三态，别混了：
   *   - `null`  = **不知道**这个房间要不要口令（403 / 网络错误）
   *   - `''`    = **知道**，而且这个房间是公开的（服务端没设口令）
   *   - 非空串  = **知道**，就是这个口令
   *
   * 以前这里一律返回 `''`，结果公开房间（服务端 ROOM_KEY=''）也被当成
   * 「不知道口令」→ 前端卡在口令弹窗里，公开房间谁都进不去。
   */
  async function fetchLocalKey() {
    try {
      const res = await fetch('/api/room-key', { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      const key = normalizeKey((data && data.key) || '');
      return key;
    } catch {
      return null;
    }
  }

  function setRoomKey(key) {
    try {
      if (key) localStorage.setItem(KEY_STORE, key);
      else localStorage.removeItem(KEY_STORE);
    } catch { /* ignore */ }
  }

  /* ---------------- 清除本机聊天记录 ---------------- */

  const CLEAR_STORE = 'chat_cleared_at';

  /**
   * 读「本机已清除到哪个时间点」。
   *
   * 记的是**时间戳**，不是消息 id —— 消息 id 是服务端发的，
   * 万一以后有人翻服务端数据库补消息，时间戳这种「切一刀」的方式更省事。
   *
   * 按房间口令分开存：换了一个房间不该继承上一个房间的清除状态。
   */
  function loadClearedAt() {
    try {
      const raw = localStorage.getItem(CLEAR_STORE);
      if (!raw) return 0;
      const obj = JSON.parse(raw);
      const room = (state.savedKey || state.key || '');
      if (obj && obj.room === room) return Number(obj.at) || 0;
      return 0;
    } catch { return 0; }
  }

  function saveClearedAt(at) {
    try {
      const room = (state.savedKey || state.key || '');
      localStorage.setItem(CLEAR_STORE, JSON.stringify({ room, at }));
    } catch { /* ignore */ }
  }

  /**
   * 本机该显示的消息 —— 被「清除」切掉的一律不显示。
   *
   * 服务器上的消息**不动**：别人的聊天记录、你换设备登入看到的，
   * 都还是原来的那些。这里只是"我这台设备不看它们"。
   */
  function visibleMessages() {
    if (!state.clearedAt) return state.messages;
    return state.messages.filter((m) => (m.ts || 0) > state.clearedAt);
  }

  /**
   * 「加载更早的消息」按钮的显隐。
   *
   * 本机清除过记录的话就不显示了 —— 那些消息本来就是看不见的，
   * 让用户点一个按了没反应的按钮更糟。
   */
  function syncMoreWrap() {
    el.moreWrap.hidden = !(state.hasMore && !state.clearedAt);
  }

  /** 打开「清除聊天记录」的确认框 */
  function openClearHistory() {
    el.clearErr.hidden = true;
    el.clearErr.textContent = '';
    el.clearModalDesc.textContent = state.clearedAt
      ? '你已经清除过一次了。再清除一次，这台设备上更早的记录也不会显示。'
      : '清除这台设备上看到的聊天记录。清除后刷新页面也不会再显示这些旧消息，其他人那边不受影响 —— 消息本身还在服务器上。';
    el.clearModal.hidden = false;
    el.clearOk.focus();
  }

  function closeClearHistory() {
    el.clearModal.hidden = true;
  }

  /**
   * 真的清除 —— 只动本机。
   *
   * 做法：记一个"切点"时间戳，之后比它早的消息都不渲染。
   * 这样刷新页面、从服务端重新拉历史，都不会再冒出来。
   */
  function clearMyHistory() {
    // 切点：比这早的消息，本机都不显示了
    state.clearedAt = Date.now();
    saveClearedAt(state.clearedAt);
    state.messages = [];
    state.hasMore = false;
    el.clearModal.hidden = true;
    renderMessages({ stickBottom: true });
    syncMoreWrap();
  }

  /**
   * 把链接里的口令就地改成"能用的那一个"。
   *
   * 场景：链接里那份口令被看错了一位，用户手动输对了。
   * 这时地址栏里还挂着错的那份 —— 一刷新就又被拒一次。
   * 就地改掉，刷新、重发链接都不用再折腾。
   * 链接里本来就没有口令的话不动它（别擅自往地址栏里塞口令）。
   */
  function syncKeyInUrl(key) {
    try {
      const u = new URL(location.href);
      const inQuery = u.searchParams.has('key');
      const inHash = /(^|[#&])key=/.test(u.hash || '');
      if (inQuery) u.searchParams.set('key', key);
      else if (inHash) u.hash = u.hash.replace(/key=[^&]*/, 'key=' + key);
      else return;
      history.replaceState(null, '', u.toString());
    } catch { /* ignore */ }
  }

  /**
   * 头像文字：昵称的首字缩写
   *
   * 只取 1 个字时，不同的人很容易撞（"小满"和"小雨"都是"小"），
   * 光靠底色也难分。所以 2 字昵称全显，更长昵称取首尾两字。
   */
  function avatarText(name) {
    const s = String(name || '?').trim();
    if (!s) return '?';
    if (s.length === 1) return s;
    if (s.length === 2) return s;
    return s.slice(0, 1) + s.slice(-1);
  }

  /**
   * 头像底色 → 文字色
   * 色池是浅绿/浅粉/浅黄/浅紫/白/黑：前 5 个底色偏亮，要用深色字才看得清；
   * 黑色底则用白字。按相对亮度（YIQ）判断。
   */
  function avatarTextColor(hex) {
    const c = String(hex || '').replace('#', '');
    if (c.length !== 6) return '#ffffff';
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 145 ? '#2f3336' : '#ffffff';
  }

  /**
   * 统一设置头像外观：底色 + 自适应文字色
   * @param {HTMLElement} node 头像元素
   * @param {string} color 底色
   * @param {string} [text] 头像文字（传入时同步更新文字与字号标记）
   * @param {string} [avatar] 图片头像文件名（服务端给的 token.png）
   *
   * 有图片头像时用图片铺满圆形，没有才退回「底色 + 昵称首字」。
   *
   * 用真实的 <img> 而不是 background-image：
   * background-image 加载失败时是「静默失败」—— 头像变成一个空白圆，
   * 用户完全不知道为什么。而 <img> 有 onerror，可以退回字母头像，
   * 至少还能认出是谁。
   */
  function paintAvatar(node, color, text, avatar) {
    const hasImg = !!avatar;
    node.setAttribute('data-img', hasImg ? '1' : '0');

    // 先把上一次的图片清掉
    const old = node.querySelector('img');
    if (old) old.remove();

    if (hasImg) {
      node.style.background = 'transparent';
      node.textContent = '';
      node.setAttribute('data-len', '0');
      const img = document.createElement('img');
      img.src = avatarUrl(avatar);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      // 加载失败（文件没了 / 口令轮换了 / 网络断了）→ 退回字母头像
      img.onerror = () => {
        img.remove();
        if (node.getAttribute('data-img') !== '1') return;
        node.setAttribute('data-img', '0');
        node.style.background = color;
        node.style.color = avatarTextColor(color);
        node.textContent = text !== undefined ? text : '';
        node.setAttribute('data-len', String((node.textContent || '').length));
      };
      node.appendChild(img);
    } else {
      // 用 background 简写 —— 会把 background-image 一并清掉，
      // 从图片头像切回字母头像时不会残留图层。
      node.style.background = color;
      node.style.color = avatarTextColor(color);
      if (text !== undefined) node.textContent = text;
      // 文字长度写进 data-len，CSS 据此缩小字号，避免两字撑破圆形
      node.setAttribute('data-len', String((node.textContent || '').length));
    }
  }

  /**
   * 图片头像的完整地址。
   *
   * 头像文件受房间口令保护（服务端 /avatar/<token>?k=<口令>），
   * 所以这里要把当前口令带上 —— <img> 没法带自定义 header，只能走查询参数。
   */
  function avatarUrl(filename) {
    if (!filename) return '';
    return `/avatar/${encodeURIComponent(filename)}?k=${encodeURIComponent(state.key || '')}`;
  }

  function isSelf(msg) {
    return state.self && msg.from.id === state.self.id;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function wsSend(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function setConn(text, ok) {
    el.connText.textContent = text;
    el.conn.classList.toggle('on', !!ok);
    el.conn.classList.toggle('off', ok === false);
  }

  function updateTitle() {
    document.title = state.unread > 0 ? `(${state.unread}) ${BASE_TITLE}` : BASE_TITLE;
  }

  /* ---------------- WebSocket ---------------- */

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cid = encodeURIComponent(getClientId());
    // ⚠️ 口令必须写回 state.key ——
    // 头像图片的 URL 也要带口令（/avatar/<token>?k=xxx），
    // 如果 state.key 是空的，头像会全部 403 变成空白圆。
    //
    // ⚠️ 这里调的是 readKeys()，不是 getRoomKey() ——
    // getRoomKey 这个函数根本不存在，一调就 ReferenceError，
    // 整个 connect() 崩掉。公开房间（没口令）正好会走到这行，
    // 所以以前「没口令的房间谁都进不去」，真 bug，别再写错了。
    if (!state.key) {
      const { urlKey, savedKey } = readKeys();
      state.key = urlKey || savedKey || '';
    }
    const key = encodeURIComponent(state.key || '');
    // 会话 token：登入过就带上 → 服务端直接认回身份（名字/头像/历史全回来）
    const tok = encodeURIComponent(getToken() || '');
    const ws = new WebSocket(`${proto}//${location.host}/ws?cid=${cid}&key=${key}&st=${tok}`);
    state.ws = ws;

    ws.onopen = () => {
      state.retry = 0;
      setConn('已连接', true);
    };

    ws.onmessage = (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch { return; }
      handle(data);
    };

    ws.onclose = (evt) => {
      // 口令不对：先别急着重连
      if (evt.code === 4001) {
        // 链接里那份口令可能是誊写时看错了一位。
        // 如果本机还存着一把验证通过的口令，先拿它自动重试一次，
        // 免得用户明明有正确口令却还要再输一遍。
        if (state.savedKey && state.savedKey !== state.key && !state.triedFallback) {
          state.triedFallback = true;
          state.key = state.savedKey;
          closeKeyModal();          // 别让弹窗杵在这儿挡着
          setConn('口令不对，正在用上次通过的口令重试…', false);
          connect();
          return;
        }
        setConn('房间口令不正确', false);
        askRoomKey(`口令不对。刚才试的是「${state.key || '（空）'}」，`
          + '请核对是不是有一位看错了 —— 可以点「粘贴」重新贴一次，'
          + '或直接从聊天记录里重新复制整条链接。');
        return;
      }
      // 被同一浏览器的另一个连接顶替（刷新 / 开了两个标签页）
      // —— 这不是故障，重连只会互相踢，所以不重连。
      // 但要让用户能主动「接管」：点一下连接状态就换新身份重新进。
      if (evt.code === 4002) {
        setConn('已在别处打开本房间 · 点这里重新进入', false);
        state.takeover = true;
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, state.retry++), 30000);
      setConn(`已断开，${Math.round(delay / 1000)} 秒后重连`, false);
      setTimeout(connect, delay);
    };

    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  /**
   * 口令不对时，问一句要口令。
   *
   * 这里原本用的是 window.prompt()，在微信内置浏览器里体验极差：
   *   1) 原生弹窗样式崩坏，输入框小到看不清自己打了几个字；
   *   2) 点「确定」后如果服务端再拒一次，又弹一个，用户根本不知道刚才输的啥；
   *   3) 手机上手指大，容易少打/多打一个字符 —— 而服务端是定长精确比对，
   *      少一个字符就直接被拒，用户会陷入「确认后反复弹」的循环。
   * 改成页面内弹窗：输入实时可见、显示字数、有「粘贴」按钮、错误提示留在原地。
   */
  function askRoomKey(reason) {
    if (el.keyModal.hidden) {
      el.keyModal.hidden = false;
      // 不要预填上次那个（多半是错的）—— 留着只会让人以为是正确的，
      // 直接清空、聚焦，让用户从聊天记录里重新复制/粘贴一遍。
      el.keyInput.value = '';
      updateKeyLen();
      setTimeout(() => { try { el.keyInput.focus(); } catch { /* ignore */ } }, 30);
    }
    if (reason) {
      el.keyErr.hidden = false;
      el.keyErr.textContent = reason;
    }
  }

  function closeKeyModal() {
    el.keyModal.hidden = true;
    el.keyErr.hidden = true;
  }

  function updateKeyLen() {
    const n = String(el.keyInput.value || '').trim().length;
    el.keyLen.textContent = `${n} 位`;
  }

  function submitRoomKey() {
    const key = normalizeKey(el.keyInput.value);
    if (!key) {
      el.keyErr.hidden = false;
      el.keyErr.textContent = '口令不能为空。';
      return;
    }
    state.triedFallback = false;
    state.key = key;
    closeKeyModal();
    connect();
  }

  function handle(data) {
    switch (data.t) {
      case 'error': {
        // 服务端拒绝了我们（目前只有「口令不对」这一种）
        setConn(data.msg || '出错了', false);
        if (data.code === 'bad_key') {
          askRoomKey('口令不对。请核对是不是有一位看错了 —— '
            + '可以点「粘贴」重新贴一次，或从聊天记录里重新复制整条链接。');
        }
        break;
      }

      case 'init': {
        // 进来了 → 这把口令确认是对的，这时才记下来。
        // （之前是把"链接里读到的"直接存，那份可能是错的，等于把好口令也弄丢了）
        setRoomKey(state.key);
        state.savedKey = state.key;
        // 链接里那份如果是错的，就地改成对的那份
        syncKeyInUrl(state.key);
        closeKeyModal();            // 进来了就把弹窗收掉
        state.self = data.self;
        state.users = new Map(data.users.map((u) => [u.id, u]));
        state.hasMore = !!data.hasMore;
        state.messages = data.history.slice();
        state.byId = new Map(state.messages.map((m) => [m.id, m]));
        // 头像可选颜色由服务端下发
        if (Array.isArray(data.colors) && data.colors.length) {
          state.colors = data.colors;
        } else if (!state.colors.length) {
          state.colors = FALLBACK_COLORS;
        }
        // 个人登录密码状态
        state.loginSet = !!data.loginSet;
        state.hasLogin = !!data.hasLogin;
        // 账号状态
        state.registered = !!data.registered;
        state.username = data.username || '';
        state.hasAnyAccount = !!data.hasAnyAccount;
        // 服务端说会话无效（token 过期 / 被踢）→ 把本机的 token 扔掉，
        // 免得一直带着一个废 token 重连
        if (data.sessionOk === false && getToken()) {
          setToken('');
        }
        renderMe();
        renderUsers();
        renderAccountBtn();
        renderMessages({ stickBottom: true });
        syncMoreWrap();

        // 用户一打开就要登入或注册 —— 没登录的时候自动把账号白框弹出来，
        // 停在「选登入 / 注册」这一步，等他点。
        // 已经带着 token 自动认回身份的（回访用户）不打断，让他直接进房间。
        if (!state.registered && !state.accAutoOpened) {
          state.accAutoOpened = true;
          setTimeout(() => {
            // 口令弹窗开着的时候别抢（那是更前置的问题）
            if (el.keyModal.hidden && el.accountModal.hidden) openAccount();
          }, 400);
        }
        break;
      }

      case 'join': {
        state.users.set(data.user.id, data.user);
        renderUsers();
        pushSystem(`${data.user.name} 加入了聊天室`);
        break;
      }

      case 'leave': {
        state.users.delete(data.user.id);
        renderUsers();
        pushSystem(`${data.user.name} 离开了聊天室`);
        break;
      }

      case 'msg': {
        const m = data.msg;
        state.messages.push(m);
        state.byId.set(m.id, m);
        renderMessages();
        if (document.hidden) { state.unread++; updateTitle(); }
        break;
      }

      case 'nick': {
        state.users.set(data.user.id, data.user);
        if (state.self && data.user.id === state.self.id) state.self = data.user;
        // 改昵称后，历史消息里的昵称也要跟着变
        for (const m of state.messages) {
          if (m.from.id === data.user.id) {
            m.from.name = data.user.name;
            m.from.color = data.user.color;
          }
        }
        renderMe();
        renderUsers();
        renderMessages();
        break;
      }

      case 'avatar': {
        // 换了头像（颜色或图片）—— 成员列表、消息里的头像都要跟着变
        state.users.set(data.user.id, data.user);
        if (state.self && data.user.id === state.self.id) state.self = data.user;
        for (const m of state.messages) {
          if (m.from.id === data.user.id) {
            m.from.color = data.user.color;
            m.from.avatar = data.user.avatar || '';
          }
        }
        renderMe();
        renderUsers();
        renderMessages();
        break;
      }

      case 'avatarAck': {
        // 服务端只把回执发给「改头像的那个人」
        if (!data.ok) {
          el.avatarErr.hidden = false;
          el.avatarErr.textContent = data.msg || '没改成，再试一次。';
          if (el.avatarConfirm.hidden) pushSystem(data.msg || '没改成，再试一次。');
          return;
        }
        // 成功：回执里带着最终的 user（含 avatar），先落本地状态
        // —— 服务端的广播随后也会到，两边一致。
        if (data.user) {
          state.self = data.user;
          state.users.set(data.user.id, data.user);
          renderMe();
          renderUsers();
        }
        break;
      }

      case 'recall': {
        const m = state.byId.get(data.id);
        if (m) { m.kind = 'recalled'; m.text = ''; }
        renderMessages();
        break;
      }

      case 'typing': {
        state.typing.set(data.user.id, { name: data.user.name, ts: Date.now() });
        renderTyping();
        setTimeout(renderTyping, TYPING_TTL);
        break;
      }

      case 'history': {
        const older = data.messages.filter((m) => !state.byId.has(m.id));
        older.forEach((m) => state.byId.set(m.id, m));
        state.messages = older.concat(state.messages);
        state.hasMore = !!data.hasMore;
        state.loadingMore = false;
        syncMoreWrap();
        renderMessages();
        break;
      }

      /* ---------------- 个人登录密码 ---------------- */

      case 'loginInfo': {
        state.loginSet = !!data.set;
        state.hasLogin = !!data.hasAny;
        // 面板开着的时候刷新一下视图（别人可能刚设好/刚移除）
        if (!el.settingsModal.hidden) showPwView(state.loginSet ? 'set2' : 'set');
        break;
      }

      case 'loginAck': {
        // 设置 / 修改 / 移除密码的回执，同时也可能是「登录身份」失败
        if (data.set !== undefined) state.loginSet = !!data.set;
        if (data.ok) state.hasLogin = true;
        el.loginOk.disabled = false;
        el.loginOk.textContent = '登录';
        if (!data.ok) {
          // 错误要显示在「当前开着」的那个面板里：
          // 登录身份失败 → 显示在登录框下面；
          // 设密码失败 → 显示在设置面板里。
          if (!el.loginModal.hidden) {
            el.loginErr.hidden = false;
            el.loginErr.textContent = data.msg || '登录没成功，再试一次。';
          } else {
            settingsError(data.msg || '操作没成功，再试一次。');
          }
          return;
        }
        // 成功：回到「已设置」视图，清掉输入框
        for (const n of [el.pwSet1, el.pwSet2, el.pwOld, el.pwChg1, el.pwChg2, el.pwDel]) {
          if (n) n.value = '';
        }
        showPwView(state.loginSet ? 'set2' : 'set');
        pushSystem(data.msg || '登录密码已更新');
        break;
      }

      case 'loginOk': {
        // 身份换回来了
        el.loginOk.disabled = false;
        el.loginOk.textContent = '登录';
        el.loginErr.hidden = true;
        closeLogin();
        if (data.unchanged) {
          pushSystem('已经是这个身份了');
          break;
        }
        state.self = data.user;
        state.users.set(data.user.id, data.user);
        if (data.prev) state.users.delete(data.prev.id);
        // 换回来的身份设过密码 → 面板里要显示「已设置」
        if (data.loginSet !== undefined) state.loginSet = !!data.loginSet;
        // 历史重新拿一遍 —— 换回来之后，那些旧消息里「我」发的要变成自己的
        if (Array.isArray(data.history)) {
          state.messages = data.history.slice();
          state.byId = new Map(state.messages.map((m) => [m.id, m]));
          state.hasMore = !!data.hasMore;
          syncMoreWrap();
        }
        renderMe();
        renderUsers();
        renderMessages({ stickBottom: true });
        pushSystem(`已登录回来：${data.user.name}`);
        break;
      }

      case 'identity': {
        // 别人换回了原来的身份（临时昵称走了，「我」回来了）
        if (data.prev) state.users.delete(data.prev.id);
        state.users.set(data.user.id, data.user);
        renderUsers();
        pushSystem(`${data.user.name} 登录回来了`);
        break;
      }

      /* ================= 账号（注册 / 登入） ================= */

      case 'accountInfo': {
        state.registered = !!data.registered;
        state.username = data.username || '';
        state.hasAnyAccount = !!data.hasAny;
        renderAccountBtn();
        break;
      }

      case 'accountAck': {
        // 注册 / 登入 / 退出登录 的回执
        el.accLoginBtn.disabled = false;
        el.accLoginBtn.textContent = '登入';
        el.accRegBtn.disabled = false;
        el.accRegBtn.textContent = '注册';

        if (!data.ok) {
          // 错误显示在「当前这一步」对应的框里
          // （之前是靠「登入框里有没有字」来猜，现在步骤是明确的，直接看 state.accStep）
          const msg = data.msg || '操作没成功，再试一次。';
          if (state.accStep === 'reg') {
            el.accRegErr.hidden = false;
            el.accRegErr.textContent = msg;
          } else {
            el.accLoginErr.hidden = false;
            el.accLoginErr.textContent = msg;
          }
          return;
        }

        // 成功
        el.accLoginErr.hidden = true;
        el.accRegErr.hidden = true;
        if (data.token) setToken(data.token);
        if (data.username) state.username = data.username;
        if (data.loggedOut) {
          state.registered = false;
          state.username = '';
          setToken('');
          closeAccount();
          renderAccountBtn();
          pushSystem('已退出登录');
          break;
        }
        state.registered = true;

        // 身份换了（从别的设备登入）→ 更新自己 + 历史
        if (data.user) {
          state.self = data.user;
          state.users.set(data.user.id, data.user);
          if (data.prev) state.users.delete(data.prev.id);
        }
        if (Array.isArray(data.history)) {
          state.messages = data.history.slice();
          state.byId = new Map(state.messages.map((m) => [m.id, m]));
          state.hasMore = !!data.hasMore;
          syncMoreWrap();
        }

        renderMe();
        renderUsers();
        renderMessages({ stickBottom: true });
        renderAccountBtn();
        closeAccount();
        pushSystem(data.msg || '登录成功');
        break;
      }
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderMe() {
    if (!state.self) return;
    el.meName.textContent = state.self.name;
    paintAvatar(el.meAvatar, state.self.color, avatarText(state.self.name), state.self.avatar);
  }

  function renderUsers() {
    const list = [...state.users.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    el.userCount.textContent = String(list.length);

    const frag = document.createDocumentFragment();
    for (const u of list) {
      const li = document.createElement('li');

      const av = document.createElement('div');
      av.className = 'avatar u-avatar';
      // 侧栏头像只有 22px，放两个字会挤，只用单字（字号由 CSS 统一控制）
      paintAvatar(av, u.color, (u.name || '?').slice(0, 1), u.avatar);

      const nm = document.createElement('span');
      nm.className = 'u-name';
      nm.textContent = u.name;
      // 手机上名字被截断时，长按能看全名
      nm.title = u.name;

      li.appendChild(av);
      li.appendChild(nm);

      if (state.self && u.id === state.self.id) {
        const tag = document.createElement('span');
        tag.className = 'u-me';
        tag.textContent = '我';
        li.appendChild(tag);
      }

      const dot = document.createElement('span');
      dot.className = 'u-online';
      li.appendChild(dot);

      frag.appendChild(li);
    }
    el.userList.replaceChildren(frag);
  }

  function pushSystem(text) {
    state.messages.push({
      id: 'sys-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      from: { id: 'system', name: '系统', color: '#8a929c' },
      text, kind: 'system', replyTo: null, ts: Date.now(),
    });
    renderMessages();
  }

  function messageEl(m, cont) {
    if (m.kind === 'system') {
      const div = document.createElement('div');
      div.className = 'sys';
      div.textContent = m.text;
      return div;
    }

    const mine = isSelf(m);
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (mine ? ' self' : '') + (cont ? ' cont' : '');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    paintAvatar(avatar, m.from.color, avatarText(m.from.name), m.from.avatar);

    const body = document.createElement('div');
    body.className = 'body';

    if (!cont) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = mine ? fmtTime(m.ts) : `${m.from.name} · ${fmtTime(m.ts)}`;
      body.appendChild(meta);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.kind === 'recalled') {
      bubble.classList.add('recalled');
      bubble.textContent = '消息已被撤回';
    } else {
      if (m.replyTo) {
        const src = state.byId.get(m.replyTo);
        const q = document.createElement('div');
        q.className = 'quote';
        if (!src || src.kind === 'recalled') {
          q.textContent = '该消息已被撤回';
        } else {
          const text = src.text.length > 60 ? src.text.slice(0, 60) + '…' : src.text;
          q.textContent = `${src.from.name}：${text}`;
        }
        bubble.appendChild(q);
      }
      bubble.appendChild(document.createTextNode(m.text));
    }
    body.appendChild(bubble);

    // 操作按钮：自己的消息才能撤回；引用任何消息都可以
    const acts = document.createElement('div');
    acts.className = 'acts';

    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'act-btn';
    quoteBtn.textContent = '引用';
    quoteBtn.addEventListener('click', () => setReplyTo(m));
    acts.appendChild(quoteBtn);

    if (mine && m.kind !== 'recalled' && Date.now() - m.ts < RECALL_WINDOW) {
      const recallBtn = document.createElement('button');
      recallBtn.type = 'button';
      recallBtn.className = 'act-btn';
      recallBtn.textContent = '撤回';
      recallBtn.addEventListener('click', () => wsSend({ t: 'recall', id: m.id }));
      acts.appendChild(recallBtn);
    }
    body.appendChild(acts);

    wrap.appendChild(avatar);
    wrap.appendChild(body);
    return wrap;
  }

  function renderMessages(opts) {
    const prevTop = el.messages.scrollTop;
    const prevH = el.messages.scrollHeight;
    const nearBottom = prevH - prevTop - el.messages.clientHeight < 80;

    const frag = document.createDocumentFragment();
    let prev = null;
    // 被本机「清除」切掉的消息不显示（服务器上的数据没动）
    const visible = visibleMessages();
    for (const m of visible) {
      const cont = prev && prev.kind !== 'system' && m.kind !== 'system'
        && prev.from.id === m.from.id && m.ts - prev.ts < GROUP_WINDOW;
      frag.appendChild(messageEl(m, cont));
      prev = m;
    }
    // 清空后不是一片空白，给个说明（刷新页面后这条也在）
    if (!visible.length && state.clearedAt) {
      frag.appendChild(messageEl({
        id: 'sys-cleared', from: { id: 'system', name: '系统', color: '#8a929c' },
        text: '本机聊天记录已清除', kind: 'system', replyTo: null, ts: state.clearedAt + 1,
      }, false));
    }
    el.messages.replaceChildren(frag);

    if (opts && opts.stickBottom) {
      el.messages.scrollTop = el.messages.scrollHeight;
    } else if (nearBottom) {
      el.messages.scrollTop = el.messages.scrollHeight;
    } else {
      el.messages.scrollTop = prevTop + (el.messages.scrollHeight - prevH);
    }
  }

  function renderTyping() {
    const now = Date.now();
    const names = [];
    for (const [id, t] of state.typing) {
      if (now - t.ts > TYPING_TTL) state.typing.delete(id);
      else if (!state.self || id !== state.self.id) names.push(t.name);
    }
    el.typing.textContent = names.length
      ? `${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''} 正在输入…`
      : '';
  }

  /* ---------------- 引用 / 撤回 ---------------- */

  function setReplyTo(m) {
    state.replyTo = m;
    el.quoteBar.hidden = false;
    el.quoteLabel.textContent = `引用 ${m.from.name}`;
    el.quoteText.textContent = m.text;
    el.input.focus();
  }

  function clearReplyTo() {
    state.replyTo = null;
    el.quoteBar.hidden = true;
    el.quoteText.textContent = '';
  }

  /* ---------------- 改名（原有逻辑，不动） ---------------- */

  function startRename() {
    if (!state.self) return;

    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = state.self.name;
    input.maxLength = 12;

    const holder = el.meName.parentNode;
    holder.replaceChild(input, el.meName);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim().slice(0, 12);
      holder.replaceChild(el.meName, input);
      if (name && name !== state.self.name) wsSend({ t: 'nick', name });
      else renderMe();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = ''; commit(); }
    });
    input.addEventListener('blur', commit);
  }

  /* ---------------- 换头像（新增功能） ---------------- */

  /** 打开调色板 */
  /** 上传区的缩略预览（显示已选图片） */
  function showUploadPreview(dataUrl) {
    const box = el.avatarUploadPreview;
    const old = box.querySelector('img');
    if (old) old.remove();
    if (!dataUrl) {
      box.style.backgroundImage = '';
      box.textContent = '＋';
      return;
    }
    box.style.backgroundImage = '';
    box.textContent = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    box.appendChild(img);
  }

  function openAvatarPicker() {
    if (!state.self) return;
    state.pickedColor = state.self.color;
    state.pickedImage = '';          // 还没选图
    state.pickedImageData = '';      // 选图后的 base64（发给服务端用）
    el.avatarErr.hidden = true;
    showUploadPreview('');
    renderColorGrid();
    el.avatarModal.hidden = false;
  }

  function closeAvatarPicker() {
    el.avatarModal.hidden = true;
    // 选过的图不要留在内存里，下次打开是干净的
    state.pickedImage = '';
    state.pickedImageData = '';
  }

  /** 渲染 24 色调色板 */
  function renderColorGrid() {
    if (!el.colorGrid) return;
    el.colorGrid.innerHTML = '';
    for (const color of state.colors) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'color-dot';
      dot.style.background = color;
      dot.title = color;
      dot.setAttribute('aria-label', '选择颜色 ' + color);
      // 底色深 → 对勾用黑色，否则白色对勾看不见
      if (avatarTextColor(color) === '#2f3336') dot.classList.add('dark');
      if (color === state.pickedColor && !state.pickedImage) dot.classList.add('sel');
        dot.addEventListener('click', () => {
          state.pickedColor = color;
          state.pickedImage = '';        // 选了颜色 → 不用图片
          state.pickedImageData = '';
          for (const n of el.colorGrid.children) n.classList.remove('sel');
          dot.classList.add('sel');
          showUploadPreview('');
          // 选了颜色 → 先问一句「是否确定修改」，不直接改
          askAvatarConfirm(color);
        });
      el.colorGrid.appendChild(dot);
    }
  }

  /**
   * 读用户选的文件 → 居中裁成正方形 → 缩到 128×128 的 PNG。
   *
   * 为什么客户端处理：
   *   - 手机相册里的照片动辄几 MB，发到服务器再裁太慢太费流量
   *   - 统一裁成方形，头像才是正圆
   *   - PNG 保留透明，缩到 128px 后一般只有几 KB
   */
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('没有选文件'));
      if (!/^image\//.test(file.type)) return reject(new Error('这不是图片文件'));

      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取失败，换一张试试'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('这张图打不开，换一张试试'));
        img.onload = () => {
          try {
            // 居中裁剪：取正方形区域
            const side = Math.min(img.width, img.height);
            const sx = (img.width - side) / 2;
            const sy = (img.height - side) / 2;

            const canvas = document.createElement('canvas');
            canvas.width = AVATAR_SIZE;
            canvas.height = AVATAR_SIZE;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

            // toDataURL('image/png') 保留透明
            resolve(canvas.toDataURL('image/png'));
          } catch (err) {
            reject(new Error('处理失败，换一张试试'));
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /** 确认框：是否确定修改（颜色或图片都行） */
  function askAvatarConfirm(color) {
    if (!state.self) return;
    if (state.pickedImage) {
      // 图片头像：还没上传，所以只能用 dataURL 直接预览
      el.avatarPreview.setAttribute('data-img', '1');
      el.avatarPreview.style.background = 'transparent';
      el.avatarPreview.textContent = '';
      el.avatarPreview.setAttribute('data-len', '0');
      const old = el.avatarPreview.querySelector('img');
      if (old) old.remove();
      const img = document.createElement('img');
      img.src = state.pickedImage;
      img.alt = '';
      el.avatarPreview.appendChild(img);
    } else {
      el.avatarPreview.setAttribute('data-img', '0');
      paintAvatar(el.avatarPreview, color, avatarText(state.self.name));
    }
    el.avatarPreviewName.textContent = state.self.name;
    el.avatarErr.hidden = true;
    el.avatarConfirm.hidden = false;
  }

  function closeAvatarConfirm() {
    el.avatarConfirm.hidden = true;
  }

  /** 真的改 */
  function confirmAvatarChange() {
    if (state.pickedImage && state.pickedImageData) {
      // 上传图片：dataURL 是 "data:image/png;base64,XXXX"，只发 base64 部分
      const b64 = state.pickedImageData.split(',')[1] || '';
      if (!wsSend({ t: 'avatarImage', data: b64 })) {
        el.avatarErr.hidden = false;
        el.avatarErr.textContent = '还没连上服务器，稍后再试。';
        return;
      }
    } else {
      const color = state.pickedColor;
      if (!color) { closeAvatarConfirm(); return; }
      if (!wsSend({ t: 'avatar', color })) {
        el.avatarErr.hidden = false;
        el.avatarErr.textContent = '还没连上服务器，稍后再试。';
        return;
      }
    }
    closeAvatarConfirm();
    closeAvatarPicker();
  }

  /* ---------------- 发送 ---------------- */

  function send() {
    const text = el.input.value;
    if (!text.trim()) return;

    const payload = { t: 'msg', text: text.slice(0, 1000) };
    if (state.replyTo) payload.replyTo = state.replyTo.id;

    if (!wsSend(payload)) {
      setConn('未连接，正在重试…', false);
      return;
    }
    el.input.value = '';
    autoGrow();
    clearReplyTo();
    el.input.focus();
  }

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }

  function loadMore() {
    if (!state.hasMore || state.loadingMore) return;
    // 本机已经清除过记录 —— 更早的消息就算加载出来也是看不见的，别白折腾
    if (state.clearedAt) { syncMoreWrap(); return; }
    // 取当前最老的一条「真实消息」作为游标（系统提示不参与定位）
    const real = state.messages.filter((m) => m.kind !== 'system');
    const ts = real.length ? real[0].ts : Date.now();
    state.loadingMore = true;
    el.moreBtn.textContent = '加载中…';
    wsSend({ t: 'loadMore', before: ts });
    setTimeout(() => {
      state.loadingMore = false;
      el.moreBtn.textContent = '加载更早的消息';
    }, 2000);
  }

  /* ---------------- 表情面板 ---------------- */

  function buildEmojiPanel() {
    const frag = document.createDocumentFragment();
    for (const ch of EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = ch;
      b.addEventListener('click', () => {
        const s = el.input.selectionStart ?? el.input.value.length;
        const e = el.input.selectionEnd ?? el.input.value.length;
        el.input.value = el.input.value.slice(0, s) + ch + el.input.value.slice(e);
        el.input.focus();
        el.input.selectionStart = el.input.selectionEnd = s + ch.length;
      });
      frag.appendChild(b);
    }
    el.emojiPanel.replaceChildren(frag);
  }

  /* ---------------- 登录设置（自己设密码） ---------------- */

  /**
   * 设置面板里的四个小视图：
   *   A pwViewSet    第一次设密码
   *   B pwViewSet2   已经设好了
   *   C pwViewChange 改密码
   *   D pwViewDel    移除密码
   * 用一个函数统一切换，免得四处各写一遍 hidden 的开关（容易漏）。
   */
  function showPwView(view) {
    el.pwViewSet.hidden = view !== 'set';
    el.pwViewSet2.hidden = view !== 'set2';
    el.pwViewChange.hidden = view !== 'change';
    el.pwViewDel.hidden = view !== 'del';
    el.pwActionsSet.hidden = view !== 'set';
    el.pwActionsSet2.hidden = view !== 'set2';
    el.pwActionsChange.hidden = view !== 'change';
    el.pwActionsDel.hidden = view !== 'del';
    el.settingsErr.hidden = true;
    el.settingsErr.textContent = '';
    const focusMap = { set: el.pwSet1, change: el.pwOld, del: el.pwDel };
    const f = focusMap[view];
    if (f) setTimeout(() => { try { f.focus(); } catch { /* ignore */ } }, 30);
  }

  function openSettings() {
    showPwView(state.loginSet ? 'set2' : 'set');
    el.settingsModal.hidden = false;
    // 问一下服务端最新状态，避免本地记的过期
    wsSend({ t: 'loginInfo' });
  }

  function closeSettings() {
    el.settingsModal.hidden = true;
    // 清掉密码输入框 —— 别把明文密码留在页面里
    for (const n of [el.pwSet1, el.pwSet2, el.pwOld, el.pwChg1, el.pwChg2, el.pwDel]) {
      if (n) n.value = '';
    }
  }

  function settingsError(msg) {
    el.settingsErr.hidden = false;
    el.settingsErr.textContent = msg || '操作没成功，再试一次。';
  }

  /** 保存第一次设置的密码 */
  function savePassword() {
    const a = el.pwSet1.value;
    const b = el.pwSet2.value;
    if (!a) { settingsError('请输入密码。'); return; }
    if (a.length < 4) { settingsError('密码至少 4 位。'); return; }
    if (a !== b) { settingsError('两次输入的密码不一样，再输一次。'); return; }
    wsSend({ t: 'loginSet', pw: a });
  }

  /** 保存新密码 */
  function changePassword() {
    const oldPw = el.pwOld.value;
    const a = el.pwChg1.value;
    const b = el.pwChg2.value;
    if (!oldPw) { settingsError('请输入原密码。'); return; }
    if (!a) { settingsError('请输入新密码。'); return; }
    if (a.length < 4) { settingsError('新密码至少 4 位。'); return; }
    if (a !== b) { settingsError('两次输入的密码不一样，再输一次。'); return; }
    wsSend({ t: 'loginChange', oldPw, newPw: a });
  }

  /** 移除密码 */
  function removePassword() {
    const pw = el.pwDel.value;
    if (!pw) { settingsError('请输入密码确认。'); return; }
    wsSend({ t: 'loginRemove', pw });
  }

  /* ---------------- 登录已有身份 ---------------- */

  function openLogin() {
    el.loginErr.hidden = true;
    el.loginName.value = state.self ? state.self.name : '';
    el.loginPw.value = '';
    el.loginModal.hidden = false;
    setTimeout(() => { try { el.loginPw.focus(); } catch { /* ignore */ } }, 30);
  }

  function closeLogin() {
    el.loginModal.hidden = true;
    el.loginPw.value = '';
  }

  function submitLogin() {
    const name = String(el.loginName.value || '').trim();
    const pw = String(el.loginPw.value || '');
    if (!name) {
      el.loginErr.hidden = false;
      el.loginErr.textContent = '请填写原来的昵称。';
      return;
    }
    if (!pw) {
      el.loginErr.hidden = false;
      el.loginErr.textContent = '请填写登录密码。';
      return;
    }
    el.loginErr.hidden = true;
    if (!wsSend({ t: 'loginClaim', name, pw })) {
      el.loginErr.hidden = false;
      el.loginErr.textContent = '还没连上服务器，稍等一下再试。';
      return;
    }
    el.loginOk.disabled = true;
    el.loginOk.textContent = '登录中…';
  }

  /* ---------------- 账号：注册 / 登入 ---------------- */

  /**
   * 账号弹窗分三步：
   *   pick  → 只有「登入」「注册」两个选择（进来第一眼看到的就是这个）
   *   login → 展开登入表单（账号 + 密码）
   *   reg   → 展开注册表单（账号 + 密码 + 再输一次）
   *
   * 表单是**选完才出现**的 —— 一上来不会同时摆两个密码框。
   */
  function showAccStep(step) {
    state.accStep = step;
    el.accStepPick.hidden = step !== 'pick';
    el.accStepLogin.hidden = step !== 'login';
    el.accStepReg.hidden = step !== 'reg';
    // 切步骤就把上一句的报错清掉，别把「密码错了」带到注册框里
    el.accLoginErr.hidden = true;
    el.accRegErr.hidden = true;
    // 焦点直接落到这一步的第一个输入框，手机上可以直接打字
    const focusEl = step === 'login' ? el.accLoginName
      : step === 'reg' ? el.accRegName : null;
    if (focusEl) {
      setTimeout(() => { try { focusEl.focus(); } catch { /* ignore */ } }, 60);
    }
  }

  /**
   * 打开账号白框
   *
   * 已经登录过 → 顶部显示「已登录」状态条；
   * 没登录 → 先停在「选登入 / 注册」这一步，等用户点了再展开表单。
   */
  function openAccount() {
    el.accLoginPw.value = '';
    el.accRegPw.value = '';
    el.accRegPw2.value = '';
    el.accLoginBtn.disabled = false;
    el.accLoginBtn.textContent = '登入';
    el.accRegBtn.disabled = false;
    el.accRegBtn.textContent = '注册';

    if (state.registered) {
      el.accState.hidden = false;
      el.accStateName.textContent = `已登录：${state.username || '（未知账号）'}`;
      el.accountDesc.textContent = '换个设备时，用这个账号就能把名字、头像和聊天记录找回来。';
    } else {
      el.accState.hidden = true;
      el.accountDesc.textContent = '登录后，这个名字、头像和聊天记录在任何设备上都能找回来。';
    }
    // 每次打开都从「选登入 / 注册」开始 —— 表单是选完才展开的
    showAccStep('pick');
    el.accountModal.hidden = false;
    // 问一下服务端最新状态（别人可能刚注册过）
    wsSend({ t: 'accountInfo' });
  }

  function closeAccount() {
    el.accountModal.hidden = true;
    // 清掉明文密码
    el.accLoginPw.value = '';
    el.accRegPw.value = '';
    el.accRegPw2.value = '';
  }

  /** 登入 */
  function submitAccountLogin() {
    state.accStep = 'login';
    const name = String(el.accLoginName.value || '').trim();
    const pw = String(el.accLoginPw.value || '');
    if (!name) {
      el.accLoginErr.hidden = false;
      el.accLoginErr.textContent = '请填写账号名。';
      return;
    }
    if (!pw) {
      el.accLoginErr.hidden = false;
      el.accLoginErr.textContent = '请填写密码。';
      return;
    }
    el.accLoginErr.hidden = true;
    if (!wsSend({ t: 'accountLogin', username: name, password: pw })) {
      el.accLoginErr.hidden = false;
      el.accLoginErr.textContent = '还没连上服务器，稍等一下再试。';
      return;
    }
    el.accLoginBtn.disabled = true;
    el.accLoginBtn.textContent = '登入中…';
  }

  /** 注册 */
  function submitAccountRegister() {
    state.accStep = 'reg';
    const name = String(el.accRegName.value || '').trim();
    const pw = String(el.accRegPw.value || '');
    const pw2 = String(el.accRegPw2.value || '');
    if (!name) {
      el.accRegErr.hidden = false;
      el.accRegErr.textContent = '请填写账号名。';
      return;
    }
    if (name.length < 3 || name.length > 20) {
      el.accRegErr.hidden = false;
      el.accRegErr.textContent = '账号名要 3-20 位。';
      return;
    }
    // 前端先拦一道，别把明显不合格的密码发到网络上
    // （服务端还会再验一遍，这里只是为了即时反馈）
    if (pw.length < 8) {
      el.accRegErr.hidden = false;
      el.accRegErr.textContent = '密码至少 8 位。';
      return;
    }
    if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
      el.accRegErr.hidden = false;
      el.accRegErr.textContent = '密码里要有字母，也要有数字。';
      return;
    }
    if (!pw) {
      el.accRegErr.hidden = false;
      el.accRegErr.textContent = '请填写密码。';
      return;
    }
    if (pw !== pw2) {
      el.accRegErr.hidden = false;
      el.accRegErr.textContent = '两次输入的密码不一样，再输一次。';
      return;
    }
    el.accRegErr.hidden = true;
    if (!wsSend({ t: 'accountRegister', username: name, password: pw, password2: pw2 })) {
      el.accRegErr.hidden = false;
      el.accRegErr.textContent = '还没连上服务器，稍等一下再试。';
      return;
    }
    el.accRegBtn.disabled = true;
    el.accRegBtn.textContent = '注册中…';
  }

  /** 退出登录 */
  function submitAccountLogout() {
    if (!wsSend({ t: 'accountLogout' })) {
      setToken('');       // 至少把本机的 token 清了
      state.registered = false;
      state.username = '';
      renderAccountBtn();
      closeAccount();
      return;
    }
  }

  /** 侧栏那个按钮的文案：登录前「注册账号」，登录后显示账号名 */
  function renderAccountBtn() {
    if (!el.accountBtnTxt) return;
    if (state.registered) {
      el.accountBtnTxt.textContent = state.username || '已登录';
      el.accountBtn.title = `已登录：${state.username || ''}（点击查看）`;
    } else {
      el.accountBtnTxt.textContent = state.hasAnyAccount ? '登录账号' : '注册账号';
      el.accountBtn.title = '注册 / 登录账号';
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  // 被别的连接顶替时，点连接状态可以「换新身份重新进入」
  el.conn.addEventListener('click', () => {
    if (!state.takeover) return;
    state.takeover = false;
    try { localStorage.removeItem(CID_KEY); } catch { /* ignore */ }
    setConn('正在重新进入…', false);
    connect();
  });

  el.sendBtn.addEventListener('click', send);

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  el.input.addEventListener('input', () => {
    autoGrow();
    const now = Date.now();
    if (now - state.lastTypingSent > 2000) {
      state.lastTypingSent = now;
      wsSend({ t: 'typing' });
    }
  });

  el.nickBtn.addEventListener('click', startRename);
  el.quoteClose.addEventListener('click', clearReplyTo);
  el.moreBtn.addEventListener('click', loadMore);

  /* ---------------- 清除本机聊天记录 ---------------- */

  el.clearHistBtn.addEventListener('click', openClearHistory);
  el.clearCancel.addEventListener('click', closeClearHistory);
  el.clearOk.addEventListener('click', clearMyHistory);
  el.clearModal.addEventListener('click', (e) => {
    // 点遮罩空白处 = 取消
    if (e.target === el.clearModal) closeClearHistory();
  });

  /* ---------------- 换头像 ---------------- */

  el.meAvatar.addEventListener('click', openAvatarPicker);
  el.avatarCancel.addEventListener('click', closeAvatarPicker);
  el.avatarConfirmOk.addEventListener('click', confirmAvatarChange);
  el.avatarConfirmCancel.addEventListener('click', closeAvatarConfirm);

  // 从相册选图
  el.avatarFile.addEventListener('change', async () => {
    const file = el.avatarFile.files && el.avatarFile.files[0];
    if (!file) return;
    try {
      const dataUrl = await readImageFile(file);
      state.pickedImage = dataUrl;
      state.pickedImageData = dataUrl;
      showUploadPreview(dataUrl);
      // 选了图 → 颜色就不作数了，取消调色板上的高亮
      for (const n of el.colorGrid.children) n.classList.remove('sel');
      // 一样要先问「是否确定修改」
      askAvatarConfirm(state.pickedColor);
    } catch (err) {
      el.avatarErr.hidden = false;
      el.avatarErr.textContent = err.message || '这张图用不了，换一张试试';
      showUploadPreview('');
    } finally {
      // 清掉 input 的值 —— 否则连续选同一张图不会触发 change 事件
      try { el.avatarFile.value = ''; } catch { /* ignore */ }
    }
  });

  /* ---------------- 登录设置 / 登录身份 ---------------- */

  el.settingsBtn.addEventListener('click', openSettings);
  el.loginBtn.addEventListener('click', openLogin);
  el.settingsCancel.addEventListener('click', closeSettings);
  el.settingsCancel2.addEventListener('click', closeSettings);
  el.pwSave.addEventListener('click', savePassword);
  el.pwChangeBtn.addEventListener('click', () => showPwView('change'));
  el.pwRemoveBtn.addEventListener('click', () => showPwView('del'));
  el.pwChangeBack.addEventListener('click', () => showPwView('set2'));
  el.pwDelBack.addEventListener('click', () => showPwView('set2'));
  el.pwChangeOk.addEventListener('click', changePassword);
  el.pwDelOk.addEventListener('click', removePassword);

  el.loginCancel.addEventListener('click', closeLogin);
  el.loginOk.addEventListener('click', submitLogin);
  el.loginPw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
  });
  el.loginName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.loginPw.focus(); }
  });

  /* ---------------- 账号：注册 / 登入 ---------------- */

  el.accountBtn.addEventListener('click', openAccount);
  el.accCloseBtn.addEventListener('click', closeAccount);
  el.accLoginBtn.addEventListener('click', submitAccountLogin);
  el.accRegBtn.addEventListener('click', submitAccountRegister);
  el.accLogoutBtn.addEventListener('click', submitAccountLogout);
  // 第 1 步：点了才展开对应表单
  el.accPickLogin.addEventListener('click', () => showAccStep('login'));
  el.accPickReg.addEventListener('click', () => showAccStep('reg'));
  // 不想填了 → 退回选择页
  el.accBackLogin.addEventListener('click', () => showAccStep('pick'));
  el.accBackReg.addEventListener('click', () => showAccStep('pick'));

  // 回车直接提交（手机上省一次点按）
  el.accLoginPw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAccountLogin(); }
  });
  el.accLoginName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.accLoginPw.focus(); }
  });
  el.accRegPw2.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAccountRegister(); }
  });
  el.accRegPw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.accRegPw2.focus(); }
  });

  /* ---------------- 口令弹窗 ---------------- */

  el.keyInput.addEventListener('input', updateKeyLen);

  el.keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitRoomKey(); }
  });

  el.keyOk.addEventListener('click', submitRoomKey);

  el.keyCancel.addEventListener('click', () => {
    closeKeyModal();
    setConn('未输入口令，无法进入房间', false);
  });

  // 「粘贴」按钮：手机上打字最容易少字符，一键粘贴最稳
  el.keyPaste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        el.keyInput.value = text.trim();
        updateKeyLen();
        el.keyErr.hidden = true;
      }
    } catch {
      // 剪贴板不可用（非 HTTPS / 用户拒绝），提示手动输入
      el.keyErr.hidden = false;
      el.keyErr.textContent = '无法读取剪贴板，请手动长按输入框粘贴。';
    }
  });

  // 点遮罩不关闭（必须明确选择），但 Esc 可以关
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.avatarConfirm.hidden) { closeAvatarConfirm(); return; }
    if (!el.avatarModal.hidden) { closeAvatarPicker(); return; }
    if (!el.accountModal.hidden) { closeAccount(); return; }
    if (!el.loginModal.hidden) { closeLogin(); return; }
    if (!el.settingsModal.hidden) { closeSettings(); return; }
    if (!el.keyModal.hidden) {
      closeKeyModal();
      setConn('未输入口令，无法进入房间', false);
    }
  });

  el.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.emojiPanel.hidden = !el.emojiPanel.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!el.emojiPanel.hidden && !el.emojiPanel.contains(e.target)) {
      el.emojiPanel.hidden = true;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.unread = 0;
      updateTitle();
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  });

  /* ---------------- 手机：跟着键盘/地址栏调整高度 ---------------- */

  /**
   * 把可视高度写进 --app-h，.app 用它当高度。
   *
   * 为什么要手动做：
   *   100dvh 在多数手机上是对的，但「键盘弹出来」的时候，
   *   可视高度会变而 dvh 不一定跟着变 —— 结果输入框被键盘挡住一半。
   *   visualViewport 报告的才是「现在真正能看到多少像素」。
   */
  function syncViewportHeight() {
    const vv = window.visualViewport;
    const h = vv && vv.height ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
  }
  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', () => {
    setTimeout(syncViewportHeight, 120);
  });

  /**
   * 手机上把输入框的提示文字换短。
   *
   * 「说点什么…（Enter 发送，Shift+Enter 换行）」这一整句在窄屏上会折成两行，
   * 把输入框撑高、还把真正的输入位置挤到下面去。手机上也没键盘，
   * 换行提示本来就没用。
   */
  function syncPlaceholder() {
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    el.input.placeholder = narrow
      ? '说点什么…'
      : '说点什么…（Enter 发送，Shift+Enter 换行）';
  }
  window.addEventListener('resize', syncPlaceholder);
  window.addEventListener('orientationchange', syncPlaceholder);

  /* ---------------- 启动 ---------------- */

  buildEmojiPanel();
  updateTitle();
  syncViewportHeight();
  syncPlaceholder();
  renderAccountBtn();

  // 先把口令准备好再连：
  //   链接里带了   → 直接用（朋友点分享链接就是这条路）
  //   本机访问     → 问服务端要（只有本机直连才给）
  //   都没有       → 先空着连，被拒了再弹框问
  (async () => {
    const { urlKey, savedKey } = readKeys();
    state.savedKey = savedKey;
    state.key = urlKey || savedKey;

    // 本机「清除记录」的状态 —— 按房间分开存，得等口令知道了再读
    state.clearedAt = loadClearedAt();

    if (!state.key) {
      // 本机直连的话，服务端会给口令
      const local = await fetchLocalKey();
      if (local !== null) {
        // local 可能是 ''（公开房间，服务端根本没设口令）——
        // 这也是「已经知道口令了」，照样直接连。
        state.key = local;
        state.savedKey = local;
        state.keyResolved = true;
      }
    }

    if (!state.key && !state.keyResolved) {
      // 既没有链接口令、又问不到 —— 只能让用户手输
      setConn('需要房间口令', false);
      askRoomKey('请输入房间口令后进入。');
      return;
    }
    connect();
  })();

  // 暴露给测试脚本使用
  window.ChatApp = {
    state, handle, renderMessages, pushSystem, setReplyTo,
    openSettings, closeSettings, showPwView, openLogin, closeLogin,
    openAccount, closeAccount, renderAccountBtn, submitAccountLogin, submitAccountRegister,
    showAccStep,
    openClearHistory, closeClearHistory, clearMyHistory, visibleMessages, syncMoreWrap,
    getToken, setToken,
  };
})();
