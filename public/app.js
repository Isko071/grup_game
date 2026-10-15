'use strict';
(() => {
  // при (пере)подключении сразу отдаём серверу код комнаты и токен, чтобы он привязал сокет к игроку
  let suppressAuth = false; // эту вкладку «вытеснили» другим устройством: сама в комнату не возвращается
  const socket = io({
    auth: (cb) => {
      if (suppressAuth) return cb({});
      let sv = null;
      try { sv = JSON.parse(localStorage.getItem('session')); } catch (e) { /* ignore */ }
      cb(sv && sv.code && sv.token ? { code: sv.code, token: sv.token } : {});
    },
  });
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  let S = null; // последнее состояние комнаты
  let session = null; // {code, token}
  let chatOpen = false;
  let unread = 0;
  let lastChatLen = 0;
  const seenCards = new Set();
  let prevTopId = null;
  let homeError = '';

  // ---------- звук ----------
  let soundOn = store.get('sound') !== '0';
  let actx = null;
  function beep(freq, dur = 0.12, type = 'sine', vol = 0.08, delay = 0) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(); const g = actx.createGain();
      o.type = type; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime + delay;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* ignore */ }
  }
  const SOUNDS = {
    play: () => { beep(520, 0.08, 'triangle'); beep(660, 0.1, 'triangle', 0.08, 0.06); },
    draw: () => beep(300, 0.12, 'sine'),
    uno: () => { beep(880, 0.1, 'square', 0.05); beep(1175, 0.18, 'square', 0.05, 0.1); },
    penalty: () => beep(180, 0.3, 'sawtooth', 0.06),
    win: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.2, 'triangle', 0.09, i * 0.12)),
    start: () => [392, 523].forEach((f, i) => beep(f, 0.15, 'triangle', 0.08, i * 0.1)),
    turn: () => beep(700, 0.07, 'sine', 0.05),
    msg: () => beep(900, 0.05, 'sine', 0.04),
  };
  const play = (n) => { if (SOUNDS[n]) SOUNDS[n](); };
  function updateSoundBtn() { $('#soundBtn').textContent = soundOn ? '🔊' : '🔇'; }
  $('#soundBtn').onclick = () => { soundOn = !soundOn; store.set('sound', soundOn ? '1' : '0'); updateSoundBtn(); play('turn'); };
  updateSoundBtn();

  // ---------- тема ----------
  $('#themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
  };

  // ---------- утилиты ----------
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
  }
  // Возврат в комнату по токену (после обрыва связи); «Уже в комнате» тоже считается успехом
  function rejoin() {
    const sv = session || loadSession();
    if (suppressAuth || !sv || !store.get('name')) return Promise.resolve({ ok: false });
    return new Promise((res) => socket.emit('room:join', { name: store.get('name'), code: sv.code, token: sv.token }, (r) => {
      if (r && r.ok) { session = { code: r.code, token: r.token }; res({ ok: true }); } else res({ ok: !!(r && r.error === 'Уже в комнате'), error: r && r.error });
    }));
  }
  const ROOM_GONE = 'Комната закрыта (сервер перезапускался). Создайте новую';

  function emit(ev, payload, retry = true) {
    return new Promise((res) => socket.emit(ev, payload || {}, async (r) => {
      // сокет ещё не привязан к игроку (только что переподключились): возвращаемся и повторяем действие один раз
      if (r && r.error === 'Вы не в комнате' && retry && (session || loadSession())) {
        const rj = await rejoin();
        if (rj.ok) return res(await emit(ev, payload, false));
        if (rj.error === 'Комната не найдена') { goHome(ROOM_GONE); return res({ error: rj.error }); }
      }
      if (r && r.error && !dTimer) toast(r.error); // пока интерфейс догоняет очередь, ошибки от «устаревших» нажатий не показываем
      res(r || {});
    }));
  }
  const roomLink = (code) => `${location.origin}/room/${code}`;
  const nameOf = (id) => (S.players.find((p) => p.id === id) || {}).name || '?';

  // ---------- вход / выход ----------
  function urlCode() {
    const m = location.pathname.match(/^\/room\/([A-Za-z0-9]{4})/);
    return m ? m[1].toUpperCase() : '';
  }

  async function enter(kind, code) {
    suppressAuth = false;
    const name = ($('#nameIn') ? $('#nameIn').value : store.get('name') || '').trim();
    if (!name) { homeError = 'Введите ник'; return renderHome(); }
    store.set('name', name);
    homeError = '';
    let r;
    if (kind === 'create') r = await emit('room:create', { name });
    else {
      const sv = loadSession();
      r = await emit('room:join', { name, code, token: sv && sv.code === code ? sv.token : null });
    }
    if (r.ok) {
      session = { code: r.code, token: r.token };
      store.set('session', JSON.stringify(session));
      history.replaceState(null, '', '/room/' + r.code);
    } else { homeError = r.error || 'Не удалось войти'; renderHome(); }
  }

  function loadSession() { try { return JSON.parse(store.get('session')); } catch (e) { return null; } }

  // Возврат на главную: после выхода, исключения или закрытия комнаты. Очищаем очередь дурака и окна,
  // чтобы запоздавшие состояния не «вернули» на экран старую комнату
  function goHome(msg, keepStorage) {
    flushDurak();
    seenEndN = 0;
    lastRenderKey = null;
    document.querySelectorAll('.modal').forEach((m) => m.remove());
    session = null; S = null;
    if (!keepStorage) store.del('session');
    history.replaceState(null, '', '/');
    chatOpen = false; document.body.classList.remove('chatopen');
    $('#chat').hidden = true; $('#chatFab').hidden = true; $('#roomBadge').hidden = true;
    renderHome();
    if (msg) toast(msg);
  }

  function leave() {
    emit('room:leave');
    goHome();
  }

  socket.on('connect', () => {
    $('#netbar').hidden = true;
    // сервер привязывает сокет по токену сам; если комната потеряна (сервер перезапускался), возвращаемся на главную
    const sv = session || loadSession();
    const code = urlCode() || (sv && sv.code);
    if (!suppressAuth && sv && code && sv.code === code && store.get('name')) {
      rejoin().then((rj) => {
        if (rj.ok) return;
        if (S && rj.error === 'Комната не найдена') goHome(ROOM_GONE);
        else if (!S) { store.del('session'); renderHome(); }
      });
    }
  });
  socket.on('disconnect', (reason) => {
    $('#netbar').hidden = false;
    if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 300); // сервер сам закрыл соединение — подключаемся заново
  });
  socket.on('kicked', (p) => {
    // вход с другого устройства: общую сессию в браузере не трогаем, но эта вкладка сама больше не возвращается
    if (p.other) { suppressAuth = true; goHome(p.reason, true); } else goHome(p.reason || 'Вас убрали из комнаты');
  });

  // В дураке между изменениями на столе держим паузу в секунду: иначе ходы (особенно ботов) мелькают слишком резко
  const DURAK_GAP = 1100;
  let dQueue = [];
  let dTimer = null;
  let dLastAt = 0;
  let seenEndN = 0;
  function durakStep(game) { // «стол за миг до бито»: чтобы последняя карта успела показаться
    const e = game.lastEnd;
    return {
      ...game, table: e.table, counts: e.counts, hand: e.hand, deckLeft: e.deckLeft, discard: e.discard,
      attacker: e.attacker, defender: e.defender, taking: e.took, over: false, loser: null, bubbles: {},
      canAttack: [], canDefend: {}, canTransfer: [], canTake: false, canPass: false,
    };
  }
  function pumpDurak() {
    if (dTimer || !dQueue.length) return;
    const run = () => {
      dTimer = null;
      const st = dQueue.shift();
      if (!st) return;
      dLastAt = Date.now();
      applyState(st);
      if (dQueue.length) dTimer = setTimeout(run, DURAK_GAP);
    };
    const wait = Math.max(0, dLastAt + DURAK_GAP - Date.now());
    if (wait === 0) run(); else dTimer = setTimeout(run, wait);
  }
  function flushDurak() { clearTimeout(dTimer); dTimer = null; dQueue = []; }

  socket.on('state', (st) => {
    if (!session && (suppressAuth || !loadSession())) return; // мы уже вышли из комнаты
    const inDurak = st.gameId === 'durak' && st.phase !== 'lobby' && st.game;
    if (!inDurak || !S || S.gameId !== 'durak' || S.phase === 'lobby') {
      flushDurak();
      seenEndN = inDurak && st.game.lastEnd ? st.game.lastEnd.n : 0;
      return applyState(st);
    }
    const entries = [];
    if (st.game.lastEnd && st.game.lastEnd.n > seenEndN) {
      seenEndN = st.game.lastEnd.n;
      entries.push({ ...st, game: durakStep(st.game), sound: null });
    }
    entries.push(st);
    dQueue.push(...entries);
    if (dQueue.length > 6) dQueue = dQueue.slice(-4); // если накопилось, пропускаем промежуточные
    pumpDurak();
  });

  function applyState(st) {
    const first = !S;
    const prev = S;
    S = st;
    if (st.sound) play(st.sound);
    if (prev && st.game && prev.game && st.game.turn === st.me && prev.game.turn !== st.me) play('turn');
    // чат
    if (st.chat.length > lastChatLen && !first && !chatOpen) { unread += st.chat.length - lastChatLen; play('msg'); }
    lastChatLen = st.chat.length;
    $('#roomBadge').hidden = false; $('#roomBadge').textContent = st.code;
    $('#chatFab').hidden = chatOpen;
    $('#chatDot').hidden = unread === 0;
    const key = JSON.stringify([st.phase, st.gameId, st.host, st.players, st.rules, st.game, st.me]);
    if (first || key !== lastRenderKey || !app.firstElementChild) { lastRenderKey = key; render(); }
    renderChat();
  }
  let lastRenderKey = null;

  socket.on('reaction', (r) => {
    const el = document.createElement('div');
    el.className = 'floater';
    el.style.left = 10 + Math.random() * 75 + '%';
    el.innerHTML = `${esc(r.emoji)}<small>${esc(r.name)}</small>`;
    $('#floaters').appendChild(el);
    setTimeout(() => el.remove(), 2500);
  });

  // ---------- чат ----------
  let chatKey = '';
  function renderChat(force) {
    if (!S) return;
    const log = $('#chatLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const last = S.chat[S.chat.length - 1];
    const key = `${S.chat.length}:${last ? last.t : ''}:${S.chatChannel}`;
    if (key === chatKey && !force) return;
    chatKey = key;
    log.innerHTML = S.chat.map((m) => m.from
      ? `<div class="${m.ch === 'mafia' ? 'mchat' : ''}">${m.ch === 'mafia' ? '🔪 ' : ''}<b>${esc(m.from)}:</b> ${esc(m.text)}</div>`
      : `<div class="sys">${esc(m.text)}</div>`).join('');
    const ci = $('#chatInput');
    ci.disabled = !S.chatChannel;
    ci.placeholder = !S.chatChannel ? 'Сейчас писать нельзя' : S.chatChannel === 'mafia' ? '🔪 Тайный чат мафии…' : 'Сообщение…';
    if (atBottom || force) log.scrollTop = log.scrollHeight;
    const rb = $('#reactBar');
    if (!rb.dataset.ready) {
      rb.innerHTML = S.reactions.map((e) => `<button data-e="${e}">${e}</button>`).join('');
      rb.dataset.ready = '1';
    }
  }
  $('#reactBar').onclick = (e) => { const b = e.target.closest('button'); if (b) emit('chat:react', { emoji: b.dataset.e }); };
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const i = $('#chatInput'); const text = i.value.trim();
    if (text) emit('chat:send', { text });
    i.value = '';
  };
  function setChat(open) {
    chatOpen = open; $('#chat').hidden = !open;
    document.body.classList.toggle('chatopen', open);
    $('#chatFab').hidden = open || !S;
    if (open) {
      unread = 0; $('#chatDot').hidden = true; renderChat(true);
      // на телефоне клавиатура сама не выезжает: только по нажатию на поле ввода
      if (matchMedia('(hover: hover)').matches) setTimeout(() => $('#chatInput').focus(), 50);
    }
  }

  // Клавиатура на телефоне уменьшает видимую область, а не окно: чат подгоняем под неё,
  // иначе поле ввода уезжает под клавиатуру, а страница «съезжает»
  const vv = window.visualViewport;
  function syncViewport() {
    if (!vv) return;
    const r = document.documentElement.style;
    r.setProperty('--vvh', `${vv.height}px`);
    r.setProperty('--vvt', `${vv.offsetTop}px`);
    if (chatOpen) {
      if (window.scrollY) window.scrollTo(0, 0);
      const log = $('#chatLog'); log.scrollTop = log.scrollHeight;
    }
  }
  if (vv) { vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); syncViewport(); }
  $('#chatFab').onclick = () => setChat(true);
  $('#chatClose').onclick = () => setChat(false);
  $('#roomBadge').onclick = () => {
    if (!S) return;
    const link = roomLink(S.code);
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Ссылка скопирована'), () => toast(link));
  };
  $('#brand').onclick = (e) => { if (S) { e.preventDefault(); } };

  // ---------- рендер ----------
  function render() {
    document.body.classList.toggle('ingame', !!S && S.phase !== 'lobby');
    document.body.classList.toggle('inroom', !!S);
    $('#exitBtn').hidden = !S;
    if (!S) return renderHome();
    if (S.phase === 'lobby') { seenCards.clear(); prevTopId = null; dSel = null; mSel = null; return renderLobby(); }
    renderGame();
  }

  function renderHome() {
    document.body.classList.remove('ingame', 'inroom');
    $('#exitBtn').hidden = true;
    const code = urlCode();
    app.innerHTML = `
      <div class="hero card-box">
        <h1>♠ Карточный круг</h1>
        <p>Уно, дурак и мафия с друзьями. Без регистрации — ник и код комнаты.</p>
        <div class="field"><label for="nameIn">Ваш ник</label>
          <input id="nameIn" maxlength="16" placeholder="Как вас зовут?" value="${esc(store.get('name') || '')}" autocomplete="nickname"></div>
        ${code ? `<button class="btn" id="joinUrl">Войти в комнату ${esc(code)}</button>
                  <button class="btn ghost" id="mk">Создать свою комнату</button>`
               : `<button class="btn" id="mk">Создать комнату</button>
                  <div class="field"><label for="codeIn">Или войти по коду</label>
                  <div class="row"><input id="codeIn" class="code-in" maxlength="4" placeholder="ABCD" style="flex:2;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px">
                  <button class="btn ghost" id="go">Войти</button></div></div>`}
        <div class="err" id="err">${esc(homeError)}</div>
      </div>`;
    const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    bind('#mk', () => enter('create'));
    bind('#go', () => enter('join', ($('#codeIn').value || '').toUpperCase().trim()));
    bind('#joinUrl', () => enter('join', code));
    const ci = $('#codeIn');
    if (ci) ci.onkeydown = (e) => { if (e.key === 'Enter') $('#go').click(); };
    $('#nameIn').onkeydown = (e) => { if (e.key === 'Enter') (($('#joinUrl') || $('#mk'))).click(); };
  }

  function renderLobby() {
    const amHost = S.host === S.me;
    const game = S.games.find((g) => g.id === S.gameId);
    const link = roomLink(S.code);
    app.innerHTML = `
      <div class="lobby">
        <section class="card-box">
          <h2>Игроки (${S.players.length}/${game.maxPlayers})</h2>
          <ul class="plist">${S.players.map((p) => `
            <li class="${p.connected ? '' : 'off'}">
              <span>${p.bot ? '🤖' : '👤'}</span>
              <span class="nm">${esc(p.name)}${p.id === S.me ? ' (вы)' : ''}</span>
              ${p.id === S.host ? '<span class="tag">создатель</span>' : ''}
              ${!p.connected ? '<span class="tag">нет связи</span>' : ''}
              ${amHost && p.id !== S.me ? `<button class="btn ghost small" data-kick="${p.id}" title="Убрать">✕</button>` : ''}
            </li>`).join('')}</ul>
          ${amHost && game.supportsBots ? `<button class="btn ghost small" id="addBot" style="margin-top:10px">🤖 Добавить бота</button>` : ''}
          <div class="share"><input readonly value="${esc(link)}" id="linkIn"><button class="btn small" id="copy">Копировать</button></div>
        </section>
        <section class="card-box">
          <h2>Игра</h2>
          <div class="gamepick">
            ${S.games.map((g) => `<button class="${g.id === S.gameId ? 'on' : ''}" data-game="${g.id}" ${amHost ? '' : 'disabled'}>${esc(g.title)}</button>`).join('')}
            ${S.soon.map((g) => `<button disabled title="Скоро">${esc(g.title)} · скоро</button>`).join('')}
          </div>
          <div>${(game.rulesSchema || []).map((r) => r.type === 'select' ? `
            <div class="rule"><span>${esc(r.label)}</span>
              <select class="sel" data-sel="${r.key}" ${amHost ? '' : 'disabled'}>${r.choices
    ? r.choices.map((c) => `<option value="${esc(c.value)}" ${String(S.rules[r.key]) === String(c.value) ? 'selected' : ''}>${esc(c.label)}</option>`).join('')
    : r.options.map((o) => `<option value="${o}" ${Number(S.rules[r.key]) === o ? 'selected' : ''}>${o === 0 ? esc(r.zero) : o + ' ' + esc(r.unit)}</option>`).join('')}</select>
            </div>` : `
            <div class="rule"><span>${esc(r.label)}</span>
              <button class="switch ${S.rules[r.key] ? 'on' : ''}" data-rule="${r.key}" ${amHost ? '' : 'disabled'} aria-pressed="${!!S.rules[r.key]}"></button>
            </div>`).join('')}</div>
          ${S.preview ? `<p class="lpreview ${S.preview.ok ? '' : 'bad'}">${esc(S.preview.text)}</p>` : ''}
          <div style="margin-top:14px">${amHost
            ? `<button class="btn" id="start" style="width:100%" ${S.players.length < game.minPlayers ? 'disabled' : ''}>Начать игру</button>
               ${S.players.length < game.minPlayers ? `<p class="tag" style="margin-top:8px;display:inline-block">Нужно минимум ${game.minPlayers} игрока — позовите друзей или добавьте бота</p>` : ''}`
            : '<p style="color:var(--muted);margin:0">Ждём, пока создатель начнёт игру…</p>'}</div>
          <button class="btn ghost small" id="leave" style="margin-top:14px">Выйти из комнаты</button>
        </section>
      </div>`;
    const on = (sel, fn) => app.querySelectorAll(sel).forEach((el) => (el.onclick = () => fn(el)));
    on('[data-kick]', (el) => emit('room:kick', { id: el.dataset.kick }));
    on('[data-game]', (el) => emit('room:settings', { gameId: el.dataset.game }));
    on('[data-rule]', (el) => emit('room:settings', { rules: { [el.dataset.rule]: !S.rules[el.dataset.rule] } }));
    app.querySelectorAll('[data-sel]').forEach((el) => (el.onchange = () => emit('room:settings', { rules: { [el.dataset.sel]: el.value } })));
    const ab = $('#addBot'); if (ab) ab.onclick = () => emit('room:addBot');
    const st = $('#start'); if (st) st.onclick = () => emit('room:start');
    $('#leave').onclick = askLeave;
    $('#copy').onclick = () => (navigator.clipboard ? navigator.clipboard.writeText(link).then(() => toast('Ссылка скопирована')) : ($('#linkIn').select(), toast('Скопируйте ссылку вручную')));
  }

  // ---------- карты ----------
  const SYM = { skip: '⊘', rev: '⇄', '+2': '+2', wild: '', '+4': '+4' };
  const cardHtml = (c, cls = '', attrs = '') => {
    const v = c.value in SYM ? SYM[c.value] : c.value;
    return `<div class="card ${c.color} ${c.value === '+4' ? 'four' : ''} ${cls}" ${attrs}><span class="corner tl">${v}</span><span class="v">${v}</span><span class="corner br">${v}</span></div>`;
  };
  const backHtml = (cls = '') => `<div class="card back ${cls}"><span class="v">UNO</span></div>`;
  const COLOR_CSS = { r: 'var(--c-r)', y: 'var(--c-y)', g: 'var(--c-g)', b: 'var(--c-b)' };
  const COLOR_RU = { r: 'красный', y: 'жёлтый', g: 'зелёный', b: 'синий' };

  function renderGame() {
    const fn = { uno: renderUno, durak: renderDurak, mafia: renderMafia }[S.gameId];
    if (fn) return fn();
    app.innerHTML = '<div class="card-box">Эта игра пока недоступна</div>';
  }

  // ---------- дурак ----------
  const SUIT = { h: '♥', d: '♦', c: '♣', s: '♠' };
  const SUIT_RU = { h: 'черви', d: 'бубны', c: 'трефы', s: 'пики' };
  const RANK = { 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };
  const rk = (r) => RANK[r] || r;
  const pcardHtml = (c, cls = '', attrs = '') => {
    const red = c.suit === 'h' || c.suit === 'd';
    const label = `<span>${rk(c.rank)}</span><small>${SUIT[c.suit]}</small>`;
    return `<div class="pcard ${red ? 'red' : ''} ${cls}" ${attrs}><span class="rk">${label}</span><span class="big">${SUIT[c.suit]}</span><span class="rk br">${label}</span></div>`;
  };
  let dSel = null; // выбранная карта защитника

  const avatarColor = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 50% 42%)`; };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ---------- дурак: постоянное дерево DOM и плавные перелёты ----------
  // Элементы не пересоздаются при каждом ходе: карта — один и тот же узел, пока она на экране, и просто
  // переезжает (рука → стол → бито/рука взявшего). Поэтому нет мерцания и «перезапуска» анимаций.
  const D = { cards: new Map(), seats: new Map(), pairs: new Map(), prev: null, deckKey: '', discKey: '' };
  // темп и кривая — как в раздаче карт в projeckt_one: спокойно, с мягким замедлением; карты вылетают по очереди
  const FLY_MS = 750;
  const FLY_EASE = 'cubic-bezier(.22,.8,.3,1)';
  const STAGGER_MS = 160;

  // Призрак карты, летящий из одного места в другое (для карт, которых уже нет на экране)
  function flyGhost(html, from, to, delay = 0, w) {
    const g = document.createElement('div');
    g.className = 'flyghost';
    g.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px;--w:${w || from.width}px`;
    g.innerHTML = html;
    document.body.appendChild(g);
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    const end = `translate(${dx}px,${dy}px) scale(${to.width / from.width})`;
    const dur = FLY_MS + 150;
    const card = g.firstElementChild;
    if (card && card.classList.contains('pcard') && !card.classList.contains('back')) {
      const cv = document.createElement('i');
      cv.className = 'cover';
      card.appendChild(cv);
      cv.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1, offset: 0.6 }, { opacity: 1, offset: 1 }], { duration: dur, delay, easing: 'linear', fill: 'both' });
    }
    const a = g.animate([{ transform: 'none', opacity: 1 }, { transform: end, opacity: 1, offset: 0.85 }, { transform: end, opacity: 0 }],
      { duration: dur, delay, easing: FLY_EASE, fill: 'both' });
    a.onfinish = () => g.remove();
  }

  // прямоугольник карты шириной w с центром в центре r (для призраков, вылетающих из колоды или аватара)
  const cardAt = (r, w) => ({ left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - (w * 1.4) / 2, width: w, height: w * 1.4 });
  // Снимок карты для плавного перелёта: где её центр на экране, как она сейчас повёрнута/масштабирована
  // (включая идущую анимацию) и какого она размера без трансформаций
  function cardSnap(el) {
    const r = el.getBoundingClientRect();
    const t = getComputedStyle(el).transform;
    const m = new DOMMatrixReadOnly(t && t !== 'none' ? t : undefined);
    return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: el.offsetWidth || r.width, m };
  }
  // Начальный кадр перелёта: карта выглядит ровно так, как выглядела до хода (место, наклон, размер),
  // а дальше браузер плавно ведёт её к новому месту и наклону. Работает при transform-origin в центре карты.
  function flipStart(old, now) {
    const s = old.w / now.w;
    const tx = old.cx - (now.cx - now.m.e);
    const ty = old.cy - (now.cy - now.m.f);
    return `matrix(${old.m.a * s},${old.m.b * s},${old.m.c * s},${old.m.d * s},${tx},${ty})`;
  }
  const sameSnap = (a, b) => Math.abs(a.cx - b.cx) < 1 && Math.abs(a.cy - b.cy) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  // откуда «вылетает» новая карта: смещение от центра источника до места карты без её собственной трансформации
  const enterFrom = (src, now) => `translate(${src.left + src.width / 2 - (now.cx - now.m.e)}px,${src.top + src.height / 2 - (now.cy - now.m.f)}px) scale(.5) rotate(-16deg)`;
  const dRect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const elFromHtml = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  function syncOrder(container, els) {
    const keep = new Set(els);
    [...container.children].forEach((ch) => { if (!keep.has(ch)) ch.remove(); });
    els.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null); });
  }
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

  function buildDurak() {
    app.innerHTML = `
      <div class="table durak">
        <div class="opps" id="dOpps"></div>
        <div class="dtop">
          <div class="dside"><div class="deckbox" id="deckbox"></div><span class="dlabel" id="dTrumpLbl"></span></div>
          <div class="dside"><div class="discardbox" id="discardbox"></div><span class="dlabel" id="dDiscLbl"></span></div>
        </div>
        <div class="dtable" id="dtable"></div>
        <div class="status" id="dStatus"></div>
        <div class="dhandwrap" id="dHandWrap"><div class="dhand" id="dHand"></div></div>
        <div class="mebar"><div id="dMeSeat"></div><div class="actions" id="dActions"></div></div>
      </div>`;
    D.cards.clear(); D.seats.clear(); D.pairs.clear(); D.prev = null; D.deckKey = ''; D.discKey = '';
    $('#dHand').onclick = (e) => { const el = e.target.closest('.pcard'); if (el) onDurakHand(Number(el.dataset.id)); };
    $('#dtable').onclick = (e) => { const pe = e.target.closest('.pair'); if (pe && pe.querySelectorAll('.pcard').length === 1) onDurakTarget(Number(pe.dataset.att)); };
    $('#dActions').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const act = (a) => emit('game:action', a);
      if (b.id === 'dTake') act({ type: 'take' });
      else if (b.id === 'dPass') act({ type: 'pass' });
      else if (b.id === 'dTransfer') { const id = dSel; dSel = null; act({ type: 'transfer', cardId: id }); }
      else if (b.id === 'again') emit('room:lobby');
    };
  }

  // Подсказок нет: нажатие на карту — это попытка хода, а подходит ли она, говорит сервер
  function onDurakHand(id) {
    const g = S.game;
    if (g.defender === S.me && !g.taking) {
      const open = g.table.filter((p) => !p.d).length;
      if (!open) return;
      // одна неотбитая карта и нет перевода — отбиваем сразу, иначе выбираем карту, а потом нажимаем на карту на столе
      if (open === 1 && !S.rules.transfer) { const idx = g.table.findIndex((p) => !p.d); dSel = null; return emit('game:action', { type: 'defend', attackId: idx, cardId: id }); }
      dSel = dSel === id ? null : id;
      renderDurak();
    } else emit('game:action', { type: 'attack', cardId: id });
  }
  function onDurakTarget(att) { const id = dSel; dSel = null; emit('game:action', { type: 'defend', attackId: att, cardId: id }); }

  function syncSeat(id, g, isMe) {
    let el = D.seats.get(id);
    if (!el) {
      el = elFromHtml(`<div class="seat ${isMe ? 'me' : ''}" data-seat="${id}"><div class="bubble"></div><div class="avatar"><span class="ini"></span><span class="rolebadge"></span></div><div class="sname"></div>${isMe ? '' : '<div class="fan"><span class="fanc"></span><span class="fcount"></span></div>'}</div>`);
      D.seats.set(id, el);
    }
    const nm = nameOf(id);
    const out = g.out.includes(id);
    const badge = out ? '🏁' : id === g.defender ? '🛡' : id === g.attacker ? '⚔' : '';
    const active = !g.over && !out && (g.defender === id ? g.table.some((p) => !p.d) && !g.taking : g.attacker === id && g.table.length === 0);
    const av = el.querySelector('.avatar');
    av.style.background = avatarColor(nm);
    setText(el.querySelector('.ini'), nm.slice(0, 1).toUpperCase());
    const rb = el.querySelector('.rolebadge');
    setText(rb, badge); rb.style.display = badge ? '' : 'none';
    setText(el.querySelector('.sname'), nm + (isMe ? ' (вы)' : ''));
    el.classList.toggle('active', active);
    el.classList.toggle('out', out);
    const bub = el.querySelector('.bubble');
    const say = g.bubbles[id] || '';
    if (say) setText(bub, say);
    bub.classList.toggle('show', !!say);
    if (!isMe) {
      const fanc = el.querySelector('.fanc');
      const want = Math.min(g.counts[id], 9);
      while (fanc.children.length < want) fanc.appendChild(elFromHtml('<div class="pcard back sm new"></div>'));
      while (fanc.children.length > want) fanc.lastElementChild.remove();
      setText(el.querySelector('.fcount'), String(g.counts[id]));
    }
    return el;
  }

  function renderDurak() {
    const g = S.game;
    const me = S.me;
    const amHost = S.host === me;
    const isDef = g.defender === me;
    if (!app.querySelector('.table.durak')) buildDurak();
    const first = !D.prev;
    if (dSel !== null && !g.hand.some((c) => c.id === dSel)) dSel = null;
    if (!isDef || g.taking) dSel = null;
    // «мой ход» по роли, без намёка на то, есть ли чем ходить
    const iAct = !g.over && (g.canTake || g.canPass || (g.table.length === 0 && g.attacker === me));
    const myIdx = g.order.indexOf(me);
    const others = g.order.map((_, i) => g.order[(myIdx + i + 1) % g.order.length]).filter((id) => id !== me);

    // 1. измеряем всё «до» (вместе с идущими анимациями) и останавливаем их, чтобы замеры «после» были чистыми
    const before = new Map();
    const beforeHtml = new Map();
    D.cards.forEach((el, cid) => {
      before.set(cid, cardSnap(el));
      if (el.closest('.pair')) beforeHtml.set(cid, el.cloneNode(true).outerHTML.replace(/ data-cid="\d+"| data-id="\d+"/g, ''));
      el.getAnimations().forEach((a) => a.cancel());
    });
    const seatBefore = new Map();
    D.seats.forEach((el, id) => seatBefore.set(id, dRect(el.querySelector('.avatar'))));
    const deckBefore = dRect($('#deckbox'));
    const discBefore = dRect($('#discardbox'));

    // 2. обновляем DOM на месте
    const getCard = (c) => {
      let el = D.cards.get(c.id);
      if (!el) {
        el = pcardEl(c);
        D.cards.set(c.id, el);
      }
      return el;
    };
    syncOrder($('#dOpps'), others.map((id) => syncSeat(id, g, false)));
    const meSeat = syncSeat(me, g, true);
    if (meSeat.parentNode !== $('#dMeSeat')) $('#dMeSeat').appendChild(meSeat);

    const deckKey = g.deckLeft > 0 ? `full:${g.trump.id}` : `empty:${g.trumpSuit}`;
    if (D.deckKey !== deckKey) {
      D.deckKey = deckKey;
      $('#deckbox').innerHTML = g.deckLeft > 0
        ? `${pcardHtml(g.trump, 'trumpc sm')}<div class="pcard back sm stack s3"></div><div class="pcard back sm stack s2"></div><div class="pcard back sm stack s1"></div><div class="cnt"></div>`
        : `<div class="pcard sm trumpc empty"><span class="big" style="opacity:1">${SUIT[g.trumpSuit]}</span></div>`;
    }
    const cnt = $('#deckbox .cnt'); if (cnt) setText(cnt, String(g.deckLeft));
    setText($('#dTrumpLbl'), `козырь ${SUIT[g.trumpSuit]}`);
    const discKey = g.discard > 0 ? 'pile' : 'empty';
    if (D.discKey !== discKey) {
      D.discKey = discKey;
      $('#discardbox').innerHTML = g.discard > 0 ? '<div class="pcard back sm"></div><div class="pcard back sm d2"></div>' : '<div class="pcard sm ghostslot"></div>';
    }
    setText($('#dDiscLbl'), `бито: ${g.discard}`);

    // стол: пары карт
    const pairEls = g.table.map((p, i) => {
      let pe = D.pairs.get(p.a.id);
      if (!pe) { pe = document.createElement('div'); pe.className = 'pair'; D.pairs.set(p.a.id, pe); }
      pe.dataset.att = i;
      const a = getCard(p.a);
      a.className = `pcard ${a.dataset.red} ${p.a.suit === g.trumpSuit ? 'trump' : ''}`;
      if (a.parentNode !== pe) pe.prepend(a);
      if (p.d) {
        const d = getCard(p.d);
        d.className = `pcard ${d.dataset.red} d ${p.d.suit === g.trumpSuit ? 'trump' : ''}`;
        if (d.parentNode !== pe) pe.appendChild(d);
      }
      return pe;
    });
    const live = new Set(g.table.flatMap((p) => (p.d ? [p.a.id, p.d.id] : [p.a.id])));
    for (const id of [...D.pairs.keys()]) if (!g.table.some((p) => p.a.id === id)) D.pairs.delete(id);
    syncOrder($('#dtable'), pairEls);

    // рука: отсортирована (козыри в конце), карты, ушедшие на стол, переехали в пары выше
    // козыри всегда слева; дальше все карты по убыванию старшинства (одинаковые достоинства рядом: К К В В 7 6),
    // внутри одного достоинства — по порядку мастей
    const suitOrder = ['s', 'h', 'c', 'd'];
    const trumpFirst = (c) => (c.suit === g.trumpSuit ? 0 : 1);
    const hand = [...g.hand].sort((x, y) => trumpFirst(x) - trumpFirst(y) || y.rank - x.rank || suitOrder.indexOf(x.suit) - suitOrder.indexOf(y.suit));
    // простая подсказка: карты, которыми сейчас можно сходить, чуть приподняты (без подсветки)
    const canUse = new Set(isDef && !g.taking ? [...Object.keys(g.canDefend).map(Number), ...g.canTransfer] : g.canAttack);
    const handEls = hand.map((c) => {
      const el = getCard(c);
      live.add(c.id);
      const t = c.suit === g.trumpSuit ? 'trump' : '';
      el.className = `pcard ${el.dataset.red} ${dSel === c.id ? 'sel' : (canUse.has(c.id) ? 'up' : '')} ${t}`;
      return el;
    });
    const handBox = $('#dHand');
    syncOrder(handBox, handEls);
    for (const [cid, el] of [...D.cards]) if (!live.has(cid)) { D.cards.delete(cid); el.remove(); }
    // перекрытие карт в руке подгоняем под ширину экрана
    if (handEls.length) {
      const cw = handEls[0].offsetWidth || 66;
      const avail = $('#dHandWrap').clientWidth - 16;
      const n = handEls.length;
      handBox.style.setProperty('--ov', `${n > 1 ? Math.min(cw - 18, Math.max(10, (n * cw - avail) / (n - 1))) : 0}px`);
    }

    let status;
    if (g.over) status = g.loser ? `🤡 Дурак — ${nameOf(g.loser)}` : '🤝 Ничья';
    else if (g.out.includes(me)) status = 'Вы вышли из игры 🎉';
    else if (isDef) status = g.taking ? 'Вы берёте' : 'Вы отбиваетесь';
    else if (g.attacker === me) status = 'Вы ходите';
    else status = `Ходит ${nameOf(g.attacker)}, защищается ${nameOf(g.defender)}`;
    const st = $('#dStatus'); setText(st, status); st.classList.toggle('mine', iAct);
    $('#dHandWrap').classList.toggle('active', iAct);
    $('#dActions').innerHTML = `
      ${dSel !== null && S.rules.transfer && isDef && !g.taking && g.table.length > 0 && g.table.every((p) => !p.d) ? '<button class="btn" id="dTransfer">↪ Перевести</button>' : ''}
      ${g.canTake ? '<button class="btn danger" id="dTake">Беру</button>' : ''}
      ${g.canPass ? `<button class="btn ghost" id="dPass">${me === g.attacker && !g.taking ? 'Бито' : 'Пас'}</button>` : ''}
      ${g.over && amHost ? '<button class="btn" id="again">В лобби</button>' : ''}
      ${g.over && !amHost ? '<span class="waitmsg">Ждём создателя…</span>' : ''}`;

    // 3. замеры «после» и плавные перелёты
    const after = new Map();
    D.cards.forEach((el, cid) => after.set(cid, cardSnap(el)));
    const seatAfter = new Map();
    D.seats.forEach((el, id) => seatAfter.set(id, dRect(el.querySelector('.avatar'))));
    const deckAfter = dRect($('#deckbox'));
    const discAfter = dRect($('#discardbox'));
    if (!REDUCED) flightsDurak({ g, first, before, beforeHtml, after, seatBefore, seatAfter, deckBefore: first ? deckAfter : deckBefore, discAfter, live });
    D.prev = { counts: { ...g.counts }, discard: g.discard, defender: g.defender, tableCids: [...g.table.flatMap((p) => (p.d ? [p.a.id, p.d.id] : [p.a.id]))] };
  }

  function pcardEl(c) {
    const el = elFromHtml(pcardHtml(c, '', `data-cid="${c.id}" data-id="${c.id}"`));
    el.dataset.red = c.suit === 'h' || c.suit === 'd' ? 'red' : '';
    return el;
  }

  function flightsDurak({ g, first, before, beforeHtml, after, seatBefore, seatAfter, deckBefore, discAfter }) {
    const prev = D.prev;
    const seatFrom = (id) => seatBefore.get(id) || seatAfter.get(id) || deckBefore;
    const played = [];
    if (prev) for (const id of g.order) { if (id === S.me) continue; for (let k = (prev.counts[id] || 0) - g.counts[id]; k > 0; k--) played.push(id); }
    let deal = 0;
    D.cards.forEach((el, cid) => {
      const to = after.get(cid);
      const old = before.get(cid);
      let from = null; let delay = 0;
      if (old) {
        if (sameSnap(old, to)) return;
        from = old;
      } else if (first) { from = deckBefore; delay = deal++ * STAGGER_MS; }
      else if (el.parentNode && el.parentNode.id === 'dHand') from = deckBefore;
      else from = seatFrom(played.shift() || g.attacker);
      if (!from) return;
      el.style.zIndex = 60;
      const done = () => { el.style.zIndex = ''; };
      let a;
      if (old) {
        // карта уже была на экране: плавно переезжает на новое место
        a = el.animate([{ transform: flipStart(old, to), offset: 0 }],
          { duration: FLY_MS, delay, easing: FLY_EASE, fill: 'backwards' });
      } else {
        // новая карта вылетает рубашкой вверх (из колоды или от соперника) и к концу полёта «открывается»
        a = el.animate([
          { opacity: 0, transform: enterFrom(from, to), offset: 0 },
          { opacity: 1, offset: 0.15 },
        ], { duration: FLY_MS, delay, easing: FLY_EASE, fill: 'backwards' });
        const cv = document.createElement('i');
        cv.className = 'cover';
        el.appendChild(cv);
        cv.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 0.8 }, { opacity: 0, offset: 1 }], { duration: FLY_MS, delay, easing: 'linear', fill: 'both' }).onfinish = () => cv.remove();
      }
      a.onfinish = a.oncancel = done;
    });
    if (!prev) return;
    // конец раунда: карты со стола ушли в «бито» или к тому, кто взял
    const gone = prev.tableCids.filter((cid) => !D.cards.has(cid) && beforeHtml.has(cid));
    if (gone.length) {
      const bito = g.discard > prev.discard;
      const target = bito ? discAfter : (prev.defender !== S.me ? seatAfter.get(prev.defender) : null);
      if (target) gone.forEach((cid, i) => flyGhost(beforeHtml.get(cid), before.get(cid), target, i * STAGGER_MS));
    }
    // добор из колоды соперниками
    g.order.forEach((id) => {
      if (id === S.me) return;
      let inc = g.counts[id] - (prev.counts[id] || 0);
      if (!g.table.length && prev.tableCids.length && !(g.discard > prev.discard) && prev.defender === id) inc -= prev.tableCids.length;
      for (let k = 0; k < Math.min(inc, 6); k++) flyGhost('<div class="pcard back"></div>', cardAt(deckBefore, 34), cardAt(seatAfter.get(id) || deckBefore, 34), 400 + k * STAGGER_MS);
    });
  }

  // ---------- мафия ----------
  let mSel = null; // выбранная ночью цель (для необратимых действий)
  const TEAM_NAME = { town: 'Мирные жители', mafia: 'Мафия', maniac: 'Маньяк' };
  const NIGHT_HINT = {
    kill: 'Выберите жертву (мафия выбирает вместе)',
    heal: 'Кого лечить этой ночью?',
    check: 'Кого проверить этой ночью?',
    maniac: 'Кого убить этой ночью?',
  };

  function renderMafia() {
    const g = S.game;
    const me = S.me;
    const live = g.mode === 'live';
    const night = g.phase === 'night';
    const imAlive = !!g.alive[me];
    const voteCount = {};
    Object.values(g.votes || {}).forEach((t) => { if (t) voteCount[t] = (voteCount[t] || 0) + 1; });
    const nt = g.night;
    const targets = nt && !nt.done || (nt && nt.kind === 'kill') ? nt.targets : [];
    const dayVote = !night && !g.over && imAlive && !live;
    const myVote = (g.votes || {})[me];
    if (!night || !nt || nt.done) mSel = null;

    const banner = g.over
      ? { icon: '🏁', title: { town: 'Победа мирных жителей!', mafia: 'Победа мафии!', maniac: 'Победил маньяк!' }[g.winner] || 'Игра окончена', sub: 'Роли раскрыты' }
      : night ? { icon: '🌙', title: `Ночь ${g.round}`, sub: live ? 'Город спит' : 'Город засыпает…' }
        : { icon: '☀️', title: `День ${g.round}`, sub: live ? 'Обсуждайте' : 'Обсуждайте и голосуйте' };

    let panel = '';
    if (g.isMod) {
      panel = `<div class="mp-text">Вы — ведущий. Отмечайте выбывших и переключайте фазы.</div>
        <div class="actions">
          <button class="btn ghost" data-phase="${night ? 'day' : 'night'}">${night ? '☀️ Наступил день' : '🌙 Наступила ночь'}</button>
          <button class="btn danger" id="mEnd">Завершить игру</button>
        </div>`;
    } else if (g.over) {
      panel = `<div class="actions">${S.host === me ? '<button class="btn" id="again">В лобби</button>' : '<span class="waitmsg">Ждём создателя…</span>'}</div>`;
    } else if (live) {
      panel = `<div class="mp-text">${imAlive ? 'Играйте вживую. Ведущий отмечает выбывших.' : 'Вы выбыли. Наблюдайте молча 🤫'}</div>`;
    } else if (!imAlive) {
      panel = '<div class="mp-text">Вы выбыли из игры. Наблюдайте молча 🤫</div>';
    } else if (night) {
      if (!nt) panel = '<div class="mp-text">Вы спите… 😴</div>';
      else if (nt.done && nt.kind !== 'kill') panel = '<div class="mp-text">Выбор сделан. Ждём остальных…</div>';
      else {
        panel = `<div class="mp-text">${NIGHT_HINT[nt.kind]}</div>`;
        if (nt.kind !== 'kill') panel += `<div class="actions"><button class="btn" id="mConfirm" ${mSel ? '' : 'disabled'}>Подтвердить выбор</button></div>`;
        else if (nt.done) panel += '<div class="mp-text sm">Вы можете изменить голос, пока ночь не закончилась</div>';
      }
    } else {
      const alive = g.order.filter((id) => g.alive[id]);
      const voted = alive.filter((id) => id in (g.votes || {})).length;
      panel = `<div class="mp-text">Нажмите на игрока, чтобы проголосовать. Проголосовали: ${voted} из ${alive.length}</div>
        ${myVote ? '<div class="actions"><button class="btn ghost small" id="mUnvote">Отменить голос</button></div>' : ''}`;
    }
    const hostBtns = g.canEndNight ? '<button class="btn ghost" id="mEndNight">Закончить ночь</button>'
      : g.canEndDay ? '<button class="btn" id="mEndDay">Подвести итоги голосования</button>' : '';

    const card = (id) => {
      const nm = nameOf(id);
      const alive = !!g.alive[id];
      const mine = id === me;
      const inTeam = g.team.includes(id);
      const chk = (g.checks || []).find((c) => c.id === id);
      const clickable = !g.over && alive && !g.isMod && ((night && nt && targets.includes(id)) || (dayVote && id !== me));
      const sel = (night && mSel === id) || (night && nt && nt.choice === id) || (!night && myVote === id);
      const voters = Object.entries(g.votes || {}).filter(([, t]) => t === id).map(([v]) => nameOf(v));
      const mv = g.mafiaVotes ? Object.entries(g.mafiaVotes).filter(([, t]) => t === id).length : 0;
      const role = g.roles ? g.roleTitles[g.roles[id]] : '';
      return `<div class="pcell ${alive ? '' : 'dead'} ${clickable ? 'click' : ''} ${sel ? 'sel' : ''} ${mine ? 'me' : ''}" data-pid="${id}">
        <span class="seatno">${g.order.indexOf(id) + 1}</span>
        <div class="avatar" style="background:${avatarColor(nm)}">${esc(nm.slice(0, 1).toUpperCase())}${!alive ? '<span class="rolebadge">✝</span>' : inTeam ? '<span class="rolebadge">🔪</span>' : ''}${mv ? `<span class="votebadge">🔪${mv}</span>` : ''}${voteCount[id] ? `<span class="votebadge">${voteCount[id]}</span>` : ''}</div>
        <div class="sname">${esc(nm)}${mine ? ' (вы)' : ''}</div>
        ${role ? `<div class="prole ${alive ? '' : 'was'}">${alive ? '' : 'был: '}${esc(role)}</div>` : ''}
        ${chk ? `<div class="prole ${chk.mafia ? 'bad' : 'good'}">${chk.mafia ? '🔪 мафия' : '✅ не мафия'}</div>` : ''}
        ${voters.length ? `<div class="pvoters">за: ${esc(voters.join(', '))}</div>` : ''}
        ${g.isMod && !g.over ? `<button class="btn ghost small" data-toggle="${id}">${alive ? 'Выбыл' : 'Вернуть'}</button>` : ''}
      </div>`;
    };

    const ri = g.roleInfo;
    app.innerHTML = `
      <div class="table mafia ${night ? 'night' : 'day'} ${g.over ? 'over' : ''}">
        <div class="mbanner"><span class="micon">${banner.icon}</span><div><b>${esc(banner.title)}</b><small>${esc(banner.sub)}</small></div></div>
        ${ri ? `<div class="rolecard"><b>Ваша роль: ${esc(ri.title)}</b><span>${esc(ri.text)}</span>${g.team.length > 1 ? `<span class="tm">Ваша команда: ${esc(g.team.filter((x) => x !== me).map(nameOf).join(', '))}</span>` : ''}</div>` : ''}
        <div class="mgrid">${(g.isMod ? g.order : g.order).map(card).join('')}</div>
        <div class="mpanel">${panel}${hostBtns ? `<div class="actions">${hostBtns}</div>` : ''}</div>
        <div class="mlog">${g.log.slice(-5).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
      </div>`;

    const act = (a) => emit('game:action', a);
    app.querySelectorAll('.pcell.click').forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.pid;
        if (night) {
          if (nt.kind === 'kill') act({ type: 'night', target: id });
          else { mSel = id; renderMafia(); }
        } else act({ type: 'vote', target: id });
      };
    });
    app.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => act({ type: 'toggleAlive', id: b.dataset.toggle })));
    app.querySelectorAll('[data-phase]').forEach((b) => (b.onclick = () => act({ type: 'setPhase', phase: b.dataset.phase })));
    const bind = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    bind('#mConfirm', () => { const t = mSel; mSel = null; act({ type: 'night', target: t }); });
    bind('#mUnvote', () => act({ type: 'vote', target: null }));
    bind('#mEndNight', () => act({ type: 'endNight' }));
    bind('#mEndDay', () => act({ type: 'endDay' }));
    bind('#mEnd', async () => { if (await confirmBox({ title: 'Завершить игру?', text: 'Игра закончится, все роли раскроются.', ok: 'Завершить', cancel: 'Продолжить' })) act({ type: 'endGame' }); });
    bind('#again', () => emit('room:lobby'));
  }

  // ---------- УНО: постоянное дерево DOM и плавные перелёты (как в дураке) ----------
  // Стол строится один раз; карты, аватары, фон с лучами не пересоздаются на каждом ходе,
  // поэтому ничего не «прыгает»: карта из руки сама переезжает в сброс, лучи крутятся без рывков.
  const U = { cards: new Map(), seats: new Map(), prev: null, bannerKey: null, resultKey: null, actionsKey: null, dir: 1 };
  const MEDAL = ['🥇', '🥈', '🥉'];

  function seatPos(i, k) {
    const t = (i + 1) / (k + 1);
    const phi = Math.PI * (1 - t);
    const deg = (phi * 180) / Math.PI;
    return { x: 50 + 41 * Math.cos(phi), y: 31 - 18 * Math.sin(phi), rot: (90 - deg) * 0.8 };
  }

  function playUnoCard(id) {
    const card = S.game.hand.find((c) => c.id === id);
    if (!card) return;
    if (card.color === 'w') pickColor((color) => emit('game:action', { type: 'play', cardId: id, color }));
    else emit('game:action', { type: 'play', cardId: id });
  }

  function buildUno() {
    app.innerHTML = `
      <div class="table uno">
        <div class="rays"></div>
        <div class="orbit"><span></span></div>
        <div id="uSeats"></div>
        <div class="ucenter">
          <div class="upile" id="drawPile"><div class="card back" style="--w:62px"><span class="v">UNO</span></div><b class="pcnt"></b></div>
          <div class="udisc" id="discard"></div>
          <div class="upend" id="uPend" hidden></div>
        </div>
        <div id="uBanner"></div>
        <div class="ustatus" id="uStatus"><span class="txt"></span><span id="uTimerTxt"></span></div>
        <div class="ustrip">
          <div id="uMe"></div>
          <div class="uactions" id="uActions"></div>
          <button class="unobtn" id="uUno" aria-label="УНО"><span>UNO!</span></button>
        </div>
        <div class="uhand" id="uHand"></div>
        <div id="uResult"></div>
      </div>`;
    U.cards.clear(); U.seats.clear(); U.prev = null; U.bannerKey = null; U.resultKey = null; U.actionsKey = null; U.dir = 1;
    $('#uHand').onclick = (e) => { const el = e.target.closest('.card'); if (el && el.classList.contains('ok')) playUnoCard(Number(el.dataset.id)); };
    $('#drawPile').onclick = () => {
      const g = S.game;
      if (g.turn === S.me && !g.over && !g.out[S.me] && g.drawn === null) emit('game:action', { type: 'draw' });
    };
    $('#uUno').onclick = () => emit('game:action', { type: 'uno' });
    $('#uBanner').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'uPass') emit('game:action', { type: 'pass' });
      else if (b.id === 'uPlay' && S.game.drawn !== null) playUnoCard(S.game.drawn);
    };
    $('#uActions').onclick = async (e) => {
      if (!e.target.closest('#uFinish')) return;
      if (await confirmBox({ title: 'Закончить игру?', text: 'Партия завершится сейчас, места распределятся по текущему положению.', ok: 'Закончить', cancel: 'Продолжить' })) emit('game:action', { type: 'finish' });
    };
    $('#uResult').onclick = (e) => { if (e.target.closest('#again')) emit('room:lobby'); };
  }

  function unoCardEl(c) {
    const el = elFromHtml(cardHtml(c, '', `data-cid="${c.id}" data-id="${c.id}"`));
    el.dataset.base = `card ${c.color}${c.value === '+4' ? ' four' : ''}`;
    return el;
  }

  function unoPlace(g, id) {
    if (g.out[id] === 'left') return '🚪';
    const p = g.places ? g.places.indexOf(id) : g.finished.indexOf(id);
    if (p < 0 || !(g.out[id] === 'finished' || g.places)) return '';
    return MEDAL[p] || String(p + 1);
  }

  function syncUnoAvatar(av, g, id) {
    const nm = nameOf(id);
    av.style.background = avatarColor(nm);
    setText(av.querySelector('.ini'), nm.slice(0, 1).toUpperCase());
    const cnt = av.querySelector('.ucount');
    setText(cnt, String(g.counts[id]));
    cnt.classList.toggle('uno', !!g.called[id] && g.counts[id] === 1);
    const pl = av.querySelector('.uplace');
    const mark = unoPlace(g, id);
    setText(pl, mark);
    pl.hidden = !mark;
    pl.classList.toggle('num', /^\d+$/.test(mark));
    av.classList.toggle('ring', g.turn === id && !g.over && !g.out[id]);
  }

  function syncUnoSeat(id, i, k, g, dense) {
    let el = U.seats.get(id);
    if (!el) {
      el = elFromHtml(`<div class="useat" data-seat="${id}"><div class="uname"></div><div class="uav"><span class="ini"></span><b class="ucount"></b><span class="uplace"></span></div><div class="ufan"></div></div>`);
      U.seats.set(id, el);
    }
    const p = seatPos(i, k);
    el.style.left = `${p.x}%`;
    el.style.top = `${p.y}%`;
    el.classList.toggle('turn', g.turn === id && !g.over && !g.out[id]);
    el.classList.toggle('out', !!g.out[id]);
    el.classList.toggle('dense', dense);
    setText(el.querySelector('.uname'), nameOf(id));
    syncUnoAvatar(el.querySelector('.uav'), g, id);
    const fan = el.querySelector('.ufan');
    fan.style.transform = `rotate(${p.rot}deg)`;
    const m = dense ? 0 : Math.min(g.counts[id], 9);
    while (fan.children.length < m) fan.appendChild(elFromHtml('<i class="card back mini new"></i>'));
    while (fan.children.length > m) fan.lastElementChild.remove();
    [...fan.children].forEach((c, j) => { c.style.transform = `rotate(${(j - (m - 1) / 2) * 7}deg)`; });
    return el;
  }

  function renderUno() {
    const g = S.game;
    const me = S.me;
    const amHost = S.host === me;
    const myOut = g.out[me];
    const myTurn = g.turn === me && !g.over && !myOut;
    if (!app.querySelector('.table.uno')) buildUno();
    const first = !U.prev;
    if (!myTurn) document.querySelectorAll('.modal.cubes').forEach((m) => m.remove()); // ход ушёл — выбор цвета уже не нужен
    const myIdx = g.order.indexOf(me);
    const others = g.order.map((_, i) => g.order[(myIdx + i + 1) % g.order.length]).filter((id) => id !== me);
    const dense = others.length > 5;

    // 1. «до»: позиции карт (вместе с идущими анимациями), затем останавливаем анимации
    const before = new Map();
    U.cards.forEach((el, cid) => { before.set(cid, cardSnap(el)); el.getAnimations().forEach((a) => a.cancel()); });
    const seatBefore = new Map();
    U.seats.forEach((el, id) => seatBefore.set(id, dRect(el.querySelector('.uav'))));
    const pileBefore = dRect($('#drawPile .card'));

    // 2. обновляем DOM на месте
    const table = app.querySelector('.table.uno');
    if (U.dir !== g.dir) {
      U.dir = g.dir;
      table.querySelector('.orbit').getAnimations().forEach((a) => a.updatePlaybackRate(g.dir)); // плавный разворот кольца
    }
    setText(table.querySelector('.orbit span'), g.dir === 1 ? '↻' : '↺');
    syncOrder($('#uSeats'), others.map((id, i) => syncUnoSeat(id, i, others.length, g, dense)));

    let meBox = U.seats.get(me);
    if (!meBox) {
      meBox = elFromHtml(`<div class="mebox" data-seat="${me}"><div class="uav"><span class="ini"></span><b class="ucount"></b><span class="uplace"></span></div><div class="uname"></div></div>`);
      U.seats.set(me, meBox);
      $('#uMe').appendChild(meBox);
    }
    meBox.classList.toggle('turn', myTurn);
    meBox.classList.toggle('out', !!myOut);
    setText(meBox.querySelector('.uname'), nameOf(me));
    syncUnoAvatar(meBox.querySelector('.uav'), g, me);

    $('#drawPile').classList.toggle('can', myTurn && g.drawn === null);
    setText($('#drawPile .pcnt'), String(g.drawLeft));
    const getCard = (c) => { let el = U.cards.get(c.id); if (!el) { el = unoCardEl(c); U.cards.set(c.id, el); } return el; };

    // сброс: несколько последних карт, верхняя крупнее
    const disc = $('#discard');
    disc.className = `udisc c-${g.color}`;
    const live = new Set();
    const discEls = g.recent.map((c, i) => {
      const el = getCard(c);
      live.add(c.id);
      const top = i === g.recent.length - 1;
      el.className = `${el.dataset.base} ${top ? 'top' : 'deco'}`;
      el.style.cssText = top
        ? `--w:76px;z-index:${i + 1};transform:rotate(-6deg)`
        : `--w:64px;z-index:${i + 1};transform:translateX(${((c.id * 13) % 24) - 12}px) rotate(${((c.id * 37) % 50) - 25}deg)`;
      return el;
    });
    syncOrder(disc, discEls);
    const pend = $('#uPend');
    if (g.pending) { if (pend.textContent !== `+${g.pending}`) { pend.textContent = `+${g.pending}`; pend.hidden = false; pend.animate([{ transform: 'scale(.6)', opacity: 0, offset: 0 }], { duration: 300, easing: FLY_EASE }); } } else pend.hidden = true;

    // рука: веер, помещающийся в ширину экрана
    const n = g.hand.length;
    const cw = innerWidth < 420 ? 62 : 72;
    const step = Math.min(3.2, 22 / Math.max(n, 1));
    const edge = cw * 1.5 * 1.3 * Math.sin((((n - 1) / 2) * step * Math.PI) / 180) + cw * 0.12;
    const avail = Math.min(app.clientWidth || innerWidth, 620) - 16 - 2 * edge;
    const ov = n > 1 ? Math.min(cw - 18, Math.max(10, (n * cw - avail) / (n - 1))) : 0;
    // рука по цветам: красные, жёлтые, зелёные, синие, потом дикие; внутри цвета — числа по порядку, затем действия
    const colorOrder = ['r', 'y', 'g', 'b', 'w'];
    const valueOrder = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'rev', '+2', 'wild', '+4'];
    const hand = [...g.hand].sort((x, y) => colorOrder.indexOf(x.color) - colorOrder.indexOf(y.color) || valueOrder.indexOf(x.value) - valueOrder.indexOf(y.value));
    const handEls = hand.map((c, i) => {
      const el = getCard(c);
      live.add(c.id);
      const off = i - (n - 1) / 2;
      const ok = g.playable.includes(c.id);
      el.className = `${el.dataset.base} ${ok ? 'ok' : (myTurn ? 'no' : '')}`;
      el.style.cssText = `--w:${cw}px;--rot:${(off * step).toFixed(1)}deg;--ty:${(off * off * 0.9).toFixed(1)}px;margin-left:${i ? -ov : 0}px`;
      return el;
    });
    syncOrder($('#uHand'), handEls);
    $('#uHand').classList.toggle('out', !!myOut);
    for (const [cid, el] of [...U.cards]) if (!live.has(cid)) { U.cards.delete(cid); el.remove(); }

    // статус, плашки, кнопки — пересобираются только при изменении
    let status;
    if (g.over) status = 'Партия окончена';
    else if (myOut === 'finished') status = `Вы выиграли! Место ${g.finished.indexOf(me) + 1}. Смотрите дальше`;
    else if (myTurn && g.drawn !== null) status = 'Сходить или оставить?';
    else if (myTurn && g.pending) status = `Положите плюс или возьмите ${g.pending}`;
    else if (myTurn) status = 'Ваш ход';
    else status = `Ходит ${nameOf(g.turn)}`;
    setText($('#uStatus .txt'), status);
    $('#uStatus').classList.toggle('mine', myTurn);
    const bannerKey = myTurn && g.drawn !== null ? `d${g.drawn}` : '';
    if (bannerKey !== U.bannerKey) {
      U.bannerKey = bannerKey;
      $('#uBanner').innerHTML = bannerKey ? `<div class="cbanner"><span>Выпала подходящая карта</span>
        <button class="btn red" id="uPlay">Сходить</button><button class="btn blue" id="uPass">Оставить</button></div>` : '';
    }
    const actionsKey = g.canFinish ? 'finish' : '';
    if (actionsKey !== U.actionsKey) {
      U.actionsKey = actionsKey;
      $('#uActions').innerHTML = actionsKey ? '<button class="btn ghost small" id="uFinish">Закончить игру</button>' : '';
    }
    $('#uUno').hidden = !g.unoAlert; // появляется, только когда у кого-то осталась одна карта
    const resultKey = g.over ? JSON.stringify([g.places, amHost]) : '';
    if (resultKey !== U.resultKey) {
      U.resultKey = resultKey;
      $('#uResult').innerHTML = g.over ? `
        <div class="uresult"><h3>🏁 Итоги</h3>
          <ol>${(g.places || []).map((id, i) => `<li class="${id === me ? 'me' : ''}"><span>${MEDAL[i] || (i + 1) + '.'}</span> ${esc(nameOf(id))}${g.out[id] === 'left' ? ' <small>(вышел)</small>' : g.out[id] === 'finished' ? '' : ` <small>(карт: ${g.counts[id]})</small>`}</li>`).join('')}</ol>
          ${amHost ? '<button class="btn" id="again">В лобби</button>' : '<span class="waitmsg">Ждём создателя…</span>'}
        </div>` : '';
    }

    // 3. «после» и перелёты
    const after = new Map();
    U.cards.forEach((el, cid) => after.set(cid, cardSnap(el)));
    const seatAfter = new Map();
    U.seats.forEach((el, id) => seatAfter.set(id, dRect(el.querySelector('.uav'))));
    const pileAfter = dRect($('#drawPile .card'));
    if (!REDUCED) flightsUno({ g, first, before, after, seatBefore, seatAfter, pile: first ? pileAfter : pileBefore });
    U.prev = { counts: { ...g.counts }, turn: g.turn };
    startUnoTimer();
  }

  function flightsUno({ g, first, before, after, seatBefore, seatAfter, pile }) {
    const prev = U.prev;
    const seatFrom = (id) => seatBefore.get(id) || seatAfter.get(id) || pile;
    const played = [];
    if (prev) for (const id of g.order) { if (id === S.me) continue; for (let k = (prev.counts[id] || 0) - g.counts[id]; k > 0; k--) played.push(id); }
    let deal = 0;
    U.cards.forEach((el, cid) => {
      const to = after.get(cid);
      const old = before.get(cid);
      let from = null; let delay = 0;
      if (old) {
        if (sameSnap(old, to)) return;
        from = old;
      } else if (first) { from = pile; delay = (el.closest('#uHand') ? deal++ : 0) * STAGGER_MS; }
      else if (el.closest('#uHand')) { from = pile; delay = deal++ * STAGGER_MS; }
      else from = seatFrom(played.shift() || (prev && prev.turn));
      if (!from) return;
      const z0 = el.style.zIndex; // в сбросе у карт свой порядок наложения — вернём его после полёта
      el.style.zIndex = 60;
      const done = () => { el.style.zIndex = z0; };
      let a;
      if (old) {
        a = el.animate([{ transform: flipStart(old, to), offset: 0 }], { duration: FLY_MS, delay, easing: FLY_EASE, fill: 'backwards' });
      } else {
        // новая карта вылетает рубашкой вверх и к концу полёта открывается (приём из projeckt_one)
        a = el.animate([
          { opacity: 0, transform: enterFrom(from, to), offset: 0 },
          { opacity: 1, offset: 0.15 },
        ], { duration: FLY_MS, delay, easing: FLY_EASE, fill: 'backwards' });
        const cv = document.createElement('i');
        cv.className = 'ucover';
        el.appendChild(cv);
        cv.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 0.8 }, { opacity: 0, offset: 1 }], { duration: FLY_MS, delay, easing: 'linear', fill: 'both' }).onfinish = () => cv.remove();
      }
      a.onfinish = a.oncancel = done;
    });
    if (!prev) return;
    // соперники берут карты из колоды
    g.order.forEach((id) => {
      if (id === S.me) return;
      const inc = g.counts[id] - (prev.counts[id] || 0);
      for (let k = 0; k < Math.min(inc, 6); k++) flyGhost('<div class="card back"></div>', cardAt(pile, 30), cardAt(seatAfter.get(id) || pile, 30), k * STAGGER_MS);
    });
  }

  // кольцо-таймер вокруг аватара того, чей ход, и секунды в статусе
  let uTimerRaf = null;
  function startUnoTimer() {
    cancelAnimationFrame(uTimerRaf);
    const txt0 = $('#uTimerTxt'); if (txt0) txt0.textContent = ''; // секунды показываем только во время своего хода
    if (S.timeLeft == null || !S.game || S.game.over) return;
    const av = app.querySelector('.useat.turn .uav') || app.querySelector('.mebox.turn .uav');
    if (!av) return;
    const t0 = performance.now(); const left = S.timeLeft; const total = S.timerTotal || left || 1;
    const mine = S.game.turn === S.me;
    const tick = () => {
      const rem = Math.max(0, left - (performance.now() - t0));
      av.style.setProperty('--p', (rem / total) * 100);
      av.classList.toggle('low', rem < 6000);
      const txt = $('#uTimerTxt'); if (txt) txt.textContent = mine ? ` · ${Math.ceil(rem / 1000)} с` : '';
      if (rem > 0 && app.contains(av)) uTimerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  // выбор цвета «кубиками» вокруг стола
  function pickColor(cb) {
    const m = document.createElement('div');
    m.className = 'modal cubes';
    m.innerHTML = `<div class="cubebox"><b>Выберите цвет</b>
      ${[['g', 'top'], ['b', 'left'], ['y', 'right'], ['r', 'bottom']].map(([c, pos]) => `<button class="cube ${pos}" style="--cc:${COLOR_CSS[c]}" data-c="${c}" aria-label="${COLOR_RU[c]}"></button>`).join('')}</div>`;
    m.onclick = (e) => {
      const b = e.target.closest('button');
      if (b) { cb(b.dataset.c); m.remove(); } else if (e.target === m) m.remove();
    };
    document.body.appendChild(m);
  }

  // окно подтверждения (выход, завершение игры)
  function confirmBox({ title, text, ok = 'Выйти', cancel = 'Остаться' }) {
    return new Promise((res) => {
      const m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = `<div class="box confirm"><b>${esc(title)}</b><p>${esc(text)}</p>
        <div class="row"><button class="btn ghost" data-r="0">${esc(cancel)}</button><button class="btn danger" data-r="1">${esc(ok)}</button></div></div>`;
      m.onclick = (e) => {
        const b = e.target.closest('button');
        if (b) { m.remove(); res(b.dataset.r === '1'); } else if (e.target === m) { m.remove(); res(false); }
      };
      document.body.appendChild(m);
    });
  }

  async function askLeave() {
    if (!S) return;
    let title = 'Выйти из комнаты?'; let text = 'Вы покинете комнату. Вернуться можно по ссылке или коду.';
    if (S.phase === 'playing') {
      title = 'Выйти из игры?';
      text = S.gameId === 'uno' ? 'Ваши карты вернутся в колоду. Вернуться в эту партию будет нельзя.'
        : S.gameId === 'mafia' ? (S.game && S.game.isMod ? 'Вы ведущий: игра закончится для всех.' : 'Вы выйдете из игры, ваша роль откроется остальным. Вернуться в эту партию будет нельзя.')
          : 'Вместо вас продолжит играть бот. Вернуться в эту партию будет нельзя.';
    }
    if (await confirmBox({ title, text })) leave();
  }
  $('#exitBtn').onclick = askLeave;

  // поворот телефона / смена размера окна: веер карт и раскладку пересчитываем сразу, а не на следующем ходе
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (S && S.phase !== 'lobby' && S.game && (S.gameId === 'uno' || S.gameId === 'durak')) renderGame(); }, 200);
  });

  // старт
  renderHome();
})();
