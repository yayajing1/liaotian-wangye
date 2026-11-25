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
    avatarConfirm: $('avatarConfirm'), avatarPreview: $('avatarPreview'),
    avatarPreviewName: $('avatarPreviewName'), avatarErr: $('avatarErr'),
    avatarConfirmOk: $('avatarConfirmOk'), avatarConfirmCancel: $('avatarConfirmCancel'),
  };

  const RECALL_WINDOW = 2 * 60 * 1000;    // 撤回时限
  const GROUP_WINDOW = 5 * 60 * 1000;     // 连续消息合并的间隔
  const TYPING_TTL = 3200;                // 输入中提示的存活时间
  const BASE_TITLE = '聊天网页';

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
    triedFallback: false, // 链接口令失败后是否已试过回退
    takeover: false,   // 被别的连接顶替了，等用户点「重新进入」
    colors: [],        // 可选头像色（服务端下发，客户端只照着渲染）
    pickedColor: '',   // 在调色板里选中、但还没确认的颜色
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
   */
  async function fetchLocalKey() {
    try {
      const res = await fetch('/api/room-key', { cache: 'no-store' });
      if (!res.ok) return '';
      const data = await res.json();
      const key = normalizeKey((data && data.key) || '');
      return key;
    } catch {
      return '';
    }
  }

  function setRoomKey(key) {
    try {
      if (key) localStorage.setItem(KEY_STORE, key);
      else localStorage.removeItem(KEY_STORE);
    } catch { /* ignore */ }
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
   */
  function paintAvatar(node, color, text) {
    node.style.background = color;
    node.style.color = avatarTextColor(color);
    if (text !== undefined) node.textContent = text;
    // 文字长度写进 data-len，CSS 据此缩小字号，避免两字撑破圆形
    node.setAttribute('data-len', String((node.textContent || '').length));
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
    const key = encodeURIComponent(state.key || getRoomKey());
    const ws = new WebSocket(`${proto}//${location.host}/ws?cid=${cid}&key=${key}`);
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
        renderMe();
        renderUsers();
        renderMessages({ stickBottom: true });
        el.moreWrap.hidden = !state.hasMore;
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
        // 换了头像颜色 —— 成员列表、消息里的头像都要跟着变
        state.users.set(data.user.id, data.user);
        if (state.self && data.user.id === state.self.id) state.self = data.user;
        for (const m of state.messages) {
          if (m.from.id === data.user.id) m.from.color = data.user.color;
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
        el.moreWrap.hidden = !state.hasMore;
        renderMessages();
        break;
      }
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderMe() {
    if (!state.self) return;
    el.meName.textContent = state.self.name;
    paintAvatar(el.meAvatar, state.self.color, avatarText(state.self.name));
  }

  function renderUsers() {
    const list = [...state.users.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    el.userCount.textContent = String(list.length);

    const frag = document.createDocumentFragment();
    for (const u of list) {
      const li = document.createElement('li');

      const av = document.createElement('div');
      av.className = 'avatar';
      // 侧栏头像只有 22px，放两个字会挤，只用单字（字号由 CSS 统一控制）
      paintAvatar(av, u.color, (u.name || '?').slice(0, 1));
      av.style.width = '22px';
      av.style.height = '22px';

      const nm = document.createElement('span');
      nm.className = 'u-name';
      nm.textContent = u.name;

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
    paintAvatar(avatar, m.from.color, avatarText(m.from.name));

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
    for (const m of state.messages) {
      const cont = prev && prev.kind !== 'system' && m.kind !== 'system'
        && prev.from.id === m.from.id && m.ts - prev.ts < GROUP_WINDOW;
      frag.appendChild(messageEl(m, cont));
      prev = m;
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
  function openAvatarPicker() {
    if (!state.self) return;
    state.pickedColor = state.self.color;
    el.avatarErr.hidden = true;
    renderColorGrid();
    el.avatarModal.hidden = false;
  }

  function closeAvatarPicker() {
    el.avatarModal.hidden = true;
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
      if (color === state.pickedColor) dot.classList.add('sel');
      dot.addEventListener('click', () => {
        state.pickedColor = color;
        for (const n of el.colorGrid.children) n.classList.remove('sel');
        dot.classList.add('sel');
        // 选了颜色 → 先问一句「是否确定修改」，不直接改
        askAvatarConfirm(color);
      });
      el.colorGrid.appendChild(dot);
    }
  }

  /** 确认框：是否确定修改 */
  function askAvatarConfirm(color) {
    if (!state.self) return;
    paintAvatar(el.avatarPreview, color, avatarText(state.self.name));
    el.avatarPreviewName.textContent = state.self.name;
    el.avatarErr.hidden = true;
    el.avatarConfirm.hidden = false;
  }

  function closeAvatarConfirm() {
    el.avatarConfirm.hidden = true;
  }

  /** 真的改 */
  function confirmAvatarChange() {
    const color = state.pickedColor;
    if (!color) { closeAvatarConfirm(); return; }
    if (!wsSend({ t: 'avatar', color })) {
      el.avatarErr.hidden = false;
      el.avatarErr.textContent = '还没连上服务器，稍后再试。';
      return;
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

  /* ---------------- 换头像 ---------------- */

  el.meAvatar.addEventListener('click', openAvatarPicker);
  el.avatarCancel.addEventListener('click', closeAvatarPicker);
  el.avatarConfirmOk.addEventListener('click', confirmAvatarChange);
  el.avatarConfirmCancel.addEventListener('click', closeAvatarConfirm);

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

  /* ---------------- 启动 ---------------- */

  buildEmojiPanel();
  updateTitle();

  // 先把口令准备好再连：
  //   链接里带了   → 直接用（朋友点分享链接就是这条路）
  //   本机访问     → 问服务端要（只有本机直连才给）
  //   都没有       → 先空着连，被拒了再弹框问
  (async () => {
    const { urlKey, savedKey } = readKeys();
    state.savedKey = savedKey;
    state.key = urlKey || savedKey;

    if (!state.key) {
      // 本机直连的话，服务端会给口令
      const local = await fetchLocalKey();
      if (local) {
        state.key = local;
        state.savedKey = local;
      }
    }

    if (!state.key) {
      // 没有口令就别先连一次被拒了 —— 直接弹窗，省一次往返
      setConn('需要房间口令', false);
      askRoomKey('请输入房间口令后进入。');
      return;
    }
    connect();
  })();

  // 暴露给测试脚本使用
  window.ChatApp = { state, handle, renderMessages, pushSystem, setReplyTo };
})();
