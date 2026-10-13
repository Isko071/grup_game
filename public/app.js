'use strict';
(() => {
  // при (пере)подключении сразу отдаём серверу код комнаты и токен, чтобы он привязал сокет к игроку
  const socket = io({
    auth: (cb) => {
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
    if (!sv || !store.get('name')) return Promise.resolve(false);
    return new Promise((res) => socket.emit('room:join', { name: store.get('name'), code: sv.code, token: sv.token }, (r) => {
      if (r && r.ok) { session = { code: r.code, token: r.token }; res(true); } else res(!!(r && r.error === 'Уже в комнате'));
    }));
  }

  function emit(ev, payload, retry = true) {
    return new Promise((res) => socket.emit(ev, payload || {}, async (r) => {
      // сокет ещё не привязан к игроку (только что переподключились): возвращаемся и повторяем действие один раз
      if (r && r.error === 'Вы не в комнате' && retry && (session || loadSession())) {
        if (await rejoin()) return res(await emit(ev, payload, false));
      }
      if (r && r.error) toast(r.error);
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

  function leave() {
    emit('room:leave');
    session = null; S = null; store.del('session');
    history.replaceState(null, '', '/');
    $('#chat').hidden = true; $('#chatFab').hidden = true; $('#roomBadge').hidden = true;
    renderHome();
  }

  socket.on('connect', () => {
    $('#netbar').hidden = true;
    // сервер привязывает сокет по токену сам; если комната потеряна (сервер перезапускался), возвращаемся на главную
    const sv = session || loadSession();
    const code = urlCode() || (sv && sv.code);
    if (sv && code && sv.code === code && store.get('name')) {
      rejoin().then((ok) => { if (!ok && !S) { store.del('session'); renderHome(); } });
    }
  });
  socket.on('disconnect', () => { $('#netbar').hidden = false; });
  socket.on('kicked', (p) => { toast(p.reason || 'Вас убрали из комнаты'); session = null; S = null; store.del('session'); history.replaceState(null, '', '/'); $('#chat').hidden = true; $('#chatFab').hidden = true; renderHome(); });

  // В дураке между изменениями на столе держим паузу в секунду: иначе ходы (особенно ботов) мелькают слишком резко
  const DURAK_GAP = 1000;
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
    render();
    renderChat();
  }

  socket.on('reaction', (r) => {
    const el = document.createElement('div');
    el.className = 'floater';
    el.style.left = 10 + Math.random() * 75 + '%';
    el.innerHTML = `${esc(r.emoji)}<small>${esc(r.name)}</small>`;
    $('#floaters').appendChild(el);
    setTimeout(() => el.remove(), 2500);
  });

  // ---------- чат ----------
  function renderChat() {
    if (!S) return;
    const log = $('#chatLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = S.chat.map((m) => m.from
      ? `<div class="${m.ch === 'mafia' ? 'mchat' : ''}">${m.ch === 'mafia' ? '🔪 ' : ''}<b>${esc(m.from)}:</b> ${esc(m.text)}</div>`
      : `<div class="sys">${esc(m.text)}</div>`).join('');
    const ci = $('#chatInput');
    ci.disabled = !S.chatChannel;
    ci.placeholder = !S.chatChannel ? 'Сейчас писать нельзя' : S.chatChannel === 'mafia' ? '🔪 Тайный чат мафии…' : 'Сообщение…';
    if (atBottom || chatOpen) log.scrollTop = log.scrollHeight;
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
      unread = 0; $('#chatDot').hidden = true; renderChat();
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
    if (S.phase === 'lobby') { seenCards.clear(); prevTopId = null; dLayout = null; dSel = null; mSel = null; uLayout = null; return renderLobby(); }
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
  let dLayout = null; // раскладка прошлого рендера — для анимации полёта карт

  // Призрак карты, летящий из одного места в другое
  function flyGhost(html, from, to, delay = 0, w) {
    const g = document.createElement('div');
    g.className = 'flyghost';
    g.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px;--w:${w || from.width}px`;
    g.innerHTML = html;
    document.body.appendChild(g);
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    const sc = to.width / from.width;
    const a = g.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(${sc})`, opacity: 0.2 }],
      { duration: 750, delay, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' });
    a.onfinish = () => g.remove();
  }

  function animateDurak(prev, now, g) {
    if (REDUCED) return;
    const seatRect = (id) => now.seats.get(id) || now.deck;
    // кто потерял карты (сыграл) — по разнице счётчиков
    const played = [];
    if (prev) for (const id of g.order) { if (id === S.me) continue; for (let k = (prev.counts[id] || 0) - g.counts[id]; k > 0; k--) played.push(id); }
    let deal = 0;
    app.querySelectorAll('[data-cid]').forEach((el) => {
      const cid = el.dataset.cid;
      const nr = now.cards.get(cid);
      const old = prev && prev.cards.get(cid);
      let from = null; let delay = 0;
      if (old) {
        if (Math.abs(old.left - nr.left) < 2 && Math.abs(old.top - nr.top) < 2) return;
        from = old;
      } else if (!prev) { from = now.deck; delay = deal++ * 70; } // раздача
      else if (el.closest('.dhand')) from = now.deck; // взял из колоды
      else from = seatRect(played.shift() || g.attacker); // карту выложил соперник
      if (!from) return;
      const dx = (from.left + from.width / 2) - (nr.left + nr.width / 2);
      const dy = (from.top + from.height / 2) - (nr.top + nr.height / 2);
      el.animate([{ transform: `translate(${dx}px,${dy}px) scale(${from.width / nr.width})`, opacity: 0.85 }],
        { duration: 650, delay, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    });
    if (!prev) return;
    // конец раунда: стол опустел
    if (prev.table.length && !g.table.length) {
      const bito = g.discard > prev.discard;
      const target = bito ? now.discard : (prev.defender !== S.me ? seatRect(prev.defender) : null);
      if (target) prev.table.forEach((t, i) => flyGhost(t.html, t.rect, target, i * 110));
    }
    // добор из колоды соперниками
    g.order.forEach((id) => {
      if (id === S.me) return;
      let inc = g.counts[id] - (prev.counts[id] || 0);
      if (!g.table.length && prev.table.length && !(g.discard > prev.discard) && prev.defender === id) inc -= prev.table.length;
      for (let k = 0; k < Math.min(inc, 6); k++) flyGhost('<div class="pcard back"></div>', now.deck, seatRect(id), 400 + k * 110, 34);
    });
  }

  function renderDurak() {
    const g = S.game;
    const amHost = S.host === S.me;
    const me = S.me;
    const isDef = g.defender === me;
    const myIdx = g.order.indexOf(me);
    const others = g.order.map((_, i) => g.order[(myIdx + i + 1) % g.order.length]).filter((id) => id !== me);
    if (dSel !== null && !g.hand.some((c) => c.id === dSel)) dSel = null;
    if (!isDef || g.taking) dSel = null;
    const targets = dSel !== null && g.canDefend[dSel] ? g.canDefend[dSel] : [];
    const handEl = app.querySelector('.dhand');
    const scroll = handEl ? handEl.scrollLeft : 0;
    const iAct = !g.over && (g.canTake || g.canPass || g.canAttack.length > 0 || Object.keys(g.canDefend).length > 0);

    let status;
    if (g.over) status = g.loser ? `🤡 Дурак — ${esc(nameOf(g.loser))}` : '🤝 Ничья';
    else if (g.out.includes(me)) status = 'Вы вышли из игры 🎉';
    else if (isDef) status = g.taking ? 'Вы берёте. Ждём, пока подкинут' : (g.canTake ? 'Отбейтесь или возьмите карты' : 'Ждём ход');
    else if (g.table.length === 0 && g.attacker === me) status = 'Ваш ход — сходите любой картой';
    else if (g.canPass || g.canAttack.length) status = g.taking ? 'Можно подкинуть' : 'Можно подкинуть или нажать «Бито»';
    else status = `Ходит ${esc(nameOf(g.attacker))}, защищается ${esc(nameOf(g.defender))}`;

    const cls = (c) => {
      const t = c.suit === g.trumpSuit ? 'trump' : '';
      if (isDef && !g.taking) return `${g.canDefend[c.id] || g.canTransfer.includes(c.id) ? 'ok' : 'no'} ${dSel === c.id ? 'sel' : ''} ${t}`;
      return `${g.canAttack.includes(c.id) ? 'ok' : 'no'} ${t}`;
    };
    const seat = (id) => {
      const n = g.counts[id];
      const out = g.out.includes(id);
      const badge = out ? '🏁' : id === g.defender ? '🛡' : id === g.attacker ? '⚔' : '';
      const fan = Array.from({ length: Math.min(n, 9) }, () => '<div class="pcard back sm"></div>').join('');
      const nm = nameOf(id);
      const active = !g.over && !out && (g.defender === id ? g.table.some((p) => !p.d) && !g.taking : g.attacker === id && g.table.length === 0);
      return `<div class="seat ${active ? 'active' : ''} ${out ? 'out' : ''}" data-seat="${id}">
        ${g.bubbles[id] ? `<div class="bubble">${esc(g.bubbles[id])}</div>` : ''}
        <div class="avatar" style="background:${avatarColor(nm)}">${esc(nm.slice(0, 1).toUpperCase())}${badge ? `<span class="rolebadge">${badge}</span>` : ''}</div>
        <div class="sname">${esc(nm)}</div>
        <div class="fan">${fan}<span class="fcount">${n}</span></div>
      </div>`;
    };

    app.innerHTML = `
      <div class="table durak">
        <div class="opps">${others.map(seat).join('')}</div>
        <div class="center dcenter">
          <div class="dside">
            <div class="deckbox" id="deckbox">
              ${g.deckLeft > 0
    ? `${pcardHtml(g.trump, 'trumpc sm')}<div class="pcard back sm stack s3"></div><div class="pcard back sm stack s2"></div><div class="pcard back sm stack s1"></div><div class="cnt">${g.deckLeft}</div>`
    : `<div class="pcard sm trumpc empty"><span class="big" style="opacity:1">${SUIT[g.trumpSuit]}</span></div>`}
            </div>
            <span class="dlabel">козырь ${SUIT[g.trumpSuit]}</span>
          </div>
          <div class="dtable" id="dtable">${g.table.map((p, i) => `
            <div class="pair ${targets.includes(i) ? 'target' : ''}" data-att="${i}">
              ${pcardHtml(p.a, p.a.suit === g.trumpSuit ? 'trump' : '', `data-cid="${p.a.id}" data-tbl="1"`)}
              ${p.d ? pcardHtml(p.d, 'd ' + (p.d.suit === g.trumpSuit ? 'trump' : ''), `data-cid="${p.d.id}" data-tbl="1"`) : ''}
            </div>`).join('') || '<span class="empty-table">Стол пуст</span>'}</div>
          <div class="dside">
            <div class="discardbox" id="discardbox">${g.discard > 0 ? '<div class="pcard back sm"></div><div class="pcard back sm d2"></div>' : '<div class="pcard sm ghostslot"></div>'}</div>
            <span class="dlabel">бито: ${g.discard}</span>
          </div>
        </div>
        <div class="status ${iAct ? 'mine' : ''}">${status}</div>
        <div class="dhandwrap ${iAct ? 'active' : ''}"><div class="dhand">${g.hand.map((c) => pcardHtml(c, cls(c), `data-id="${c.id}" data-cid="${c.id}"`)).join('')}</div></div>
        <div class="mebar">
          <div class="seat me ${iAct ? 'active' : ''}" data-seat="${me}">
            ${g.bubbles[me] ? `<div class="bubble">${esc(g.bubbles[me])}</div>` : ''}
            <div class="avatar" style="background:${avatarColor(nameOf(me))}">${esc(nameOf(me).slice(0, 1).toUpperCase())}${me === g.defender ? '<span class="rolebadge">🛡</span>' : me === g.attacker ? '<span class="rolebadge">⚔</span>' : ''}</div>
            <div class="sname">${esc(nameOf(me))}</div>
          </div>
          <div class="actions">
            ${dSel !== null && g.canTransfer.includes(dSel) ? '<button class="btn" id="dTransfer">↪ Перевести</button>' : ''}
            ${g.canTake ? '<button class="btn danger" id="dTake">Беру</button>' : ''}
            ${g.canPass ? `<button class="btn ghost" id="dPass">${g.taking ? 'Хватит' : 'Бито'}</button>` : ''}
            ${g.over && amHost ? '<button class="btn" id="again">В лобби</button>' : ''}
            ${g.over && !amHost ? '<span class="waitmsg">Ждём создателя…</span>' : ''}
          </div>
        </div>
      </div>`;

    const nh = app.querySelector('.dhand'); if (nh) nh.scrollLeft = scroll;

    // раскладка после отрисовки — до запуска анимаций (во время анимации размеры «плывут»)
    const R = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
    const now = { cards: new Map(), seats: new Map(), deck: R($('#deckbox')), discard: R($('#discardbox')) };
    app.querySelectorAll('[data-cid]').forEach((el) => now.cards.set(el.dataset.cid, R(el)));
    app.querySelectorAll('[data-seat]').forEach((el) => now.seats.set(el.dataset.seat, R(el.querySelector('.avatar'))));
    animateDurak(dLayout, now, g);
    dLayout = {
      cards: now.cards,
      counts: { ...g.counts },
      discard: g.discard,
      defender: g.defender,
      table: g.table.length ? [...app.querySelectorAll('[data-tbl]')].map((el) => ({ html: el.outerHTML.replace(/ data-cid="\d+"| data-tbl="1"/g, ''), rect: now.cards.get(el.dataset.cid) })) : [],
    };

    const act = (a) => emit('game:action', a);
    app.querySelectorAll('.dhand .pcard.ok').forEach((el) => {
      el.onclick = () => {
        const id = Number(el.dataset.id);
        if (isDef && !g.taking) {
          const t = g.canDefend[id] || [];
          const canTr = g.canTransfer.includes(id);
          if (t.length === 1 && !canTr) { dSel = null; return act({ type: 'defend', attackId: t[0], cardId: id }); }
          dSel = dSel === id ? null : id; renderDurak();
        } else act({ type: 'attack', cardId: id });
      };
    });
    app.querySelectorAll('.pair.target').forEach((el) => {
      el.onclick = () => { const id = dSel; dSel = null; act({ type: 'defend', attackId: Number(el.dataset.att), cardId: id }); };
    });
    const bind = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    bind('#dTake', () => act({ type: 'take' }));
    bind('#dPass', () => act({ type: 'pass' }));
    bind('#dTransfer', () => { const id = dSel; dSel = null; act({ type: 'transfer', cardId: id }); });
    bind('#again', () => emit('room:lobby'));
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

  // ---------- УНО (стиль мобильной версии) ----------
  let uLayout = null; // раскладка прошлого рендера — для анимации полёта карт
  const MEDAL = ['🥇', '🥈', '🥉'];

  function seatPos(i, k) {
    const t = (i + 1) / (k + 1);
    const phi = Math.PI * (1 - t);
    const deg = (phi * 180) / Math.PI;
    return { x: 50 + 41 * Math.cos(phi), y: 31 - 18 * Math.sin(phi), rot: (90 - deg) * 0.8 };
  }

  function renderUno() {
    const g = S.game;
    const me = S.me;
    const amHost = S.host === me;
    const myOut = g.out[me];
    const myTurn = g.turn === me && !g.over && !myOut;
    const myIdx = g.order.indexOf(me);
    const others = g.order.map((_, i) => g.order[(myIdx + i + 1) % g.order.length]).filter((id) => id !== me);
    const dense = others.length > 5;
    const place = (id) => { const p = g.places ? g.places.indexOf(id) : g.finished.indexOf(id); return p >= 0 && (g.out[id] === 'finished' || g.places) ? p : -1; };
    const placeBadge = (id) => { const p = place(id); return p >= 0 && g.out[id] !== 'left' ? (MEDAL[p] ? `<span class="uplace">${MEDAL[p]}</span>` : `<span class="uplace num">${p + 1}</span>`) : (g.out[id] === 'left' ? '<span class="uplace">🚪</span>' : ''); };

    let status;
    if (g.over) status = 'Партия окончена';
    else if (myOut === 'finished') status = `Вы выиграли! Место ${g.finished.indexOf(me) + 1}. Смотрите дальше`;
    else if (myTurn && g.drawn !== null) status = 'Сходить или оставить?';
    else if (myTurn && g.pending) status = `Положите плюс или возьмите ${g.pending}`;
    else if (myTurn) status = 'Ваш ход';
    else status = `Ходит ${nameOf(g.turn)}`;

    const seat = (id, i) => {
      const n = g.counts[id];
      const p = seatPos(i, others.length);
      const nm = nameOf(id);
      const turn = g.turn === id && !g.over && !g.out[id];
      const m = Math.min(n, 9);
      const fan = dense ? '' : Array.from({ length: m }, (_, j) => `<i class="card back mini" style="transform:rotate(${(j - (m - 1) / 2) * 7}deg)"></i>`).join('');
      return `<div class="useat ${turn ? 'turn' : ''} ${g.out[id] ? 'out' : ''} ${dense ? 'dense' : ''}" style="left:${p.x}%;top:${p.y}%" data-seat="${id}">
        <div class="uname">${esc(nm)}</div>
        <div class="uav ${turn ? 'ring' : ''}" style="background:${avatarColor(nm)}">${esc(nm.slice(0, 1).toUpperCase())}<b class="ucount ${g.called[id] && n === 1 ? 'uno' : ''}">${n}</b>${placeBadge(id)}</div>
        <div class="ufan" style="transform:rotate(${p.rot}deg)">${fan}</div>
      </div>`;
    };

    // рука: веер карт, помещающийся в ширину экрана
    const n = g.hand.length;
    const cw = innerWidth < 420 ? 62 : 72;
    const step = Math.min(3.2, 22 / Math.max(n, 1));
    const edge = cw * 1.5 * 1.3 * Math.sin((((n - 1) / 2) * step * Math.PI) / 180) + cw * 0.12; // на сколько веер выступает по краям
    const avail = Math.min(app.clientWidth || innerWidth, 620) - 16 - 2 * edge;
    const ov = n > 1 ? Math.min(cw - 18, Math.max(10, (n * cw - avail) / (n - 1))) : 0;
    const handHtml = g.hand.map((c, i) => {
      const off = i - (n - 1) / 2;
      const ok = g.playable.includes(c.id);
      return cardHtml(c, `${ok ? 'ok' : (myTurn ? 'no' : '')}`, `data-id="${c.id}" data-cid="${c.id}" style="--w:${cw}px;--rot:${(off * step).toFixed(1)}deg;--ty:${(off * off * 0.9).toFixed(1)}px;margin-left:${i ? -ov : 0}px"`);
    }).join('');

    const recent = g.recent.slice(0, -1).map((c) => `<div class="udeco" style="--r:${((c.id * 37) % 50) - 25}deg;--dx:${((c.id * 13) % 24) - 12}px">${cardHtml(c, '', 'style="--w:64px"')}</div>`).join('');
    const myName = nameOf(me);
    const resultHtml = g.over ? `
      <div class="uresult"><h3>🏁 Итоги</h3>
        <ol>${(g.places || []).map((id, i) => `<li class="${id === me ? 'me' : ''}"><span>${MEDAL[i] || (i + 1) + '.'}</span> ${esc(nameOf(id))}${g.out[id] === 'left' ? ' <small>(вышел)</small>' : g.out[id] === 'finished' ? '' : ` <small>(карт: ${g.counts[id]})</small>`}</li>`).join('')}</ol>
        ${amHost ? '<button class="btn" id="again">В лобби</button>' : '<span class="waitmsg">Ждём создателя…</span>'}
      </div>` : '';

    app.innerHTML = `
      <div class="table uno ${g.dir === 1 ? 'cw' : 'ccw'}">
        <div class="rays"></div>
        <div class="orbit"><span>${g.dir === 1 ? '↻' : '↺'}</span></div>
        ${others.map(seat).join('')}
        <div class="ucenter">
          <div class="upile ${myTurn && g.drawn === null ? 'can' : ''}" id="drawPile">
            <div class="card back" style="--w:62px"></div><b class="pcnt">${g.drawLeft}</b>
          </div>
          <div class="udisc c-${g.color}" id="discard">${recent}<div class="utop">${cardHtml(g.top, 'top', `data-cid="${g.top.id}" style="--w:76px"`)}</div></div>
          ${g.pending ? `<div class="upend">+${g.pending}</div>` : ''}
        </div>
        ${myTurn && g.drawn !== null ? `<div class="cbanner"><span>Выпала подходящая карта</span>
          <button class="btn red" id="uPlay">Сходить</button><button class="btn blue" id="uPass">Оставить</button></div>` : ''}
        <div class="ustatus ${myTurn ? 'mine' : ''}">${esc(status)}<span id="uTimerTxt"></span></div>
        <div class="ustrip">
          <div class="mebox ${myTurn ? 'turn' : ''} ${myOut ? 'out' : ''}" data-seat="${me}">
            <div class="uav ${myTurn ? 'ring' : ''}" style="background:${avatarColor(myName)}">${esc(myName.slice(0, 1).toUpperCase())}<b class="ucount">${n}</b>${placeBadge(me)}</div>
            <div class="uname">${esc(myName)}</div>
          </div>
          <div class="uactions">
            ${g.canFinish ? '<button class="btn ghost small" id="uFinish">Закончить игру</button>' : ''}
          </div>
          ${!g.over && !myOut ? '<button class="unobtn" id="uUno" aria-label="УНО"><span>UNO!</span></button>' : '<span></span>'}
        </div>
        <div class="uhand ${myOut ? 'out' : ''}">${handHtml}</div>
        ${resultHtml}
      </div>`;

    // раскладка после отрисовки — до запуска анимаций
    const R = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
    const now = { cards: new Map(), seats: new Map(), pile: R($('#drawPile .card')), disc: R($('#discard')) };
    app.querySelectorAll('[data-cid]').forEach((el) => now.cards.set(el.dataset.cid, R(el)));
    app.querySelectorAll('[data-seat] .uav').forEach((el) => now.seats.set(el.parentElement.dataset.seat, R(el)));
    animateUno(uLayout, now, g);
    uLayout = { cards: now.cards, counts: { ...g.counts }, turn: g.turn };
    startUnoTimer();

    const act = (a) => emit('game:action', a);
    app.querySelectorAll('.uhand .card.ok').forEach((el) => {
      el.onclick = () => {
        const id = Number(el.dataset.id);
        const card = g.hand.find((c) => c.id === id);
        if (card.color === 'w') pickColor((color) => act({ type: 'play', cardId: id, color }));
        else act({ type: 'play', cardId: id });
      };
    });
    const bind = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    bind('#drawPile', () => { if (myTurn && g.drawn === null) act({ type: 'draw' }); });
    bind('#uUno', () => act({ type: 'uno' }));
    bind('#uPass', () => act({ type: 'pass' }));
    bind('#uPlay', () => {
      const card = g.hand.find((c) => c.id === g.drawn);
      if (!card) return;
      if (card.color === 'w') pickColor((color) => act({ type: 'play', cardId: card.id, color }));
      else act({ type: 'play', cardId: card.id });
    });
    bind('#uFinish', async () => { if (await confirmBox({ title: 'Закончить игру?', text: 'Партия завершится сейчас, места распределятся по текущему положению.', ok: 'Закончить', cancel: 'Продолжить' })) act({ type: 'finish' }); });
    bind('#again', () => emit('room:lobby'));
  }

  // Полёт карт: из руки на стол, от соперника в центр, из колоды в руку/к сопернику
  function animateUno(prev, now, g) {
    if (REDUCED) return;
    const seatRect = (id) => now.seats.get(id) || now.pile;
    const played = [];
    if (prev) for (const id of g.order) { if (id === S.me) continue; for (let k = (prev.counts[id] || 0) - g.counts[id]; k > 0; k--) played.push(id); }
    let deal = 0;
    app.querySelectorAll('[data-cid]').forEach((el) => {
      const nr = now.cards.get(el.dataset.cid);
      const old = prev && prev.cards.get(el.dataset.cid);
      let from = null; let delay = 0;
      if (old) { if (Math.abs(old.left - nr.left) < 2 && Math.abs(old.top - nr.top) < 2) return; from = old; }
      else if (!prev) { from = now.pile; delay = deal++ * 60; }
      else if (el.closest('.uhand')) from = now.pile;
      else from = seatRect(played.shift() || (prev && g.order[(g.order.indexOf(g.turn) + g.order.length - g.dir) % g.order.length]));
      if (!from) return;
      const dx = (from.left + from.width / 2) - (nr.left + nr.width / 2);
      const dy = (from.top + from.height / 2) - (nr.top + nr.height / 2);
      el.animate([{ transform: `translate(${dx}px,${dy}px) scale(${from.width / nr.width})`, opacity: 0.85 }],
        { duration: 420, delay, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    });
    if (!prev) return;
    g.order.forEach((id) => {
      if (id === S.me) return;
      const inc = g.counts[id] - (prev.counts[id] || 0);
      for (let k = 0; k < Math.min(inc, 6); k++) flyGhost('<div class="card back"></div>', now.pile, seatRect(id), 150 + k * 70, 30);
    });
  }

  // кольцо-таймер вокруг аватара того, чей ход, и секунды в статусе
  let uTimerRaf = null;
  function startUnoTimer() {
    cancelAnimationFrame(uTimerRaf);
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

  // старт
  renderHome();
})();
