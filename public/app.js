'use strict';
(() => {
  const socket = io();
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
  function emit(ev, payload) {
    return new Promise((res) => socket.emit(ev, payload || {}, (r) => {
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
    // автоматический реконнект по токену
    const sv = session || loadSession();
    const code = urlCode() || (sv && sv.code);
    if (sv && code && sv.code === code && store.get('name')) {
      emit('room:join', { name: store.get('name'), code, token: sv.token }).then((r) => {
        if (r.ok) session = { code: r.code, token: r.token };
        else if (!S) { store.del('session'); renderHome(); }
      });
    }
  });
  socket.on('kicked', (p) => { toast(p.reason || 'Вас убрали из комнаты'); session = null; S = null; store.del('session'); history.replaceState(null, '', '/'); $('#chat').hidden = true; $('#chatFab').hidden = true; renderHome(); });

  socket.on('state', (st) => {
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
  });

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
      ? `<div><b>${esc(m.from)}:</b> ${esc(m.text)}</div>`
      : `<div class="sys">${esc(m.text)}</div>`).join('');
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
    $('#chatFab').hidden = open || !S;
    if (open) { unread = 0; $('#chatDot').hidden = true; renderChat(); setTimeout(() => $('#chatInput').focus(), 50); }
  }
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
    if (!S) return renderHome();
    if (S.phase === 'lobby') { seenCards.clear(); prevTopId = null; return renderLobby(); }
    renderGame();
  }

  function renderHome() {
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
              ${p.id === S.host ? '<span class="tag">хост</span>' : ''}
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
              <select class="sel" data-sel="${r.key}" ${amHost ? '' : 'disabled'}>${r.options.map((o) => `<option value="${o}" ${Number(S.rules[r.key]) === o ? 'selected' : ''}>${o === 0 ? esc(r.zero) : o + ' ' + esc(r.unit)}</option>`).join('')}</select>
            </div>` : `
            <div class="rule"><span>${esc(r.label)}</span>
              <button class="switch ${S.rules[r.key] ? 'on' : ''}" data-rule="${r.key}" ${amHost ? '' : 'disabled'} aria-pressed="${!!S.rules[r.key]}"></button>
            </div>`).join('')}</div>
          <div style="margin-top:14px">${amHost
            ? `<button class="btn" id="start" style="width:100%" ${S.players.length < game.minPlayers ? 'disabled' : ''}>Начать игру</button>
               ${S.players.length < game.minPlayers ? `<p class="tag" style="margin-top:8px;display:inline-block">Нужно минимум ${game.minPlayers} игрока — позовите друзей или добавьте бота</p>` : ''}`
            : '<p style="color:var(--muted);margin:0">Ждём, пока хост начнёт игру…</p>'}</div>
          <button class="btn ghost small" id="leave" style="margin-top:14px">Выйти из комнаты</button>
        </section>
      </div>`;
    const on = (sel, fn) => app.querySelectorAll(sel).forEach((el) => (el.onclick = () => fn(el)));
    on('[data-kick]', (el) => emit('room:kick', { id: el.dataset.kick }));
    on('[data-game]', (el) => emit('room:settings', { gameId: el.dataset.game }));
    on('[data-rule]', (el) => emit('room:settings', { rules: { [el.dataset.rule]: !S.rules[el.dataset.rule] } }));
    app.querySelectorAll('[data-sel]').forEach((el) => (el.onchange = () => emit('room:settings', { rules: { [el.dataset.sel]: Number(el.value) } })));
    const ab = $('#addBot'); if (ab) ab.onclick = () => emit('room:addBot');
    const st = $('#start'); if (st) st.onclick = () => emit('room:start');
    $('#leave').onclick = leave;
    $('#copy').onclick = () => (navigator.clipboard ? navigator.clipboard.writeText(link).then(() => toast('Ссылка скопирована')) : ($('#linkIn').select(), toast('Скопируйте ссылку вручную')));
  }

  // ---------- карты ----------
  const SYM = { skip: '⊘', rev: '⇄', '+2': '+2', wild: '', '+4': '+4' };
  const cardHtml = (c, cls = '', attrs = '') => {
    const v = SYM[c.value] || c.value;
    return `<div class="card ${c.color} ${c.value === '+4' ? 'four' : ''} ${cls}" ${attrs}><span class="corner tl">${v}</span><span class="v">${v}</span><span class="corner br">${v}</span></div>`;
  };
  const backHtml = (cls = '') => `<div class="card back ${cls}"><span class="v">UNO</span></div>`;
  const COLOR_CSS = { r: 'var(--c-r)', y: 'var(--c-y)', g: 'var(--c-g)', b: 'var(--c-b)' };
  const COLOR_RU = { r: 'красный', y: 'жёлтый', g: 'зелёный', b: 'синий' };

  function renderGame() {
    if (S.gameId === 'uno') return renderUno();
    app.innerHTML = '<div class="card-box">Эта игра пока недоступна</div>';
  }

  function renderUno() {
    const g = S.game;
    const amHost = S.host === S.me;
    const myTurn = g.turn === S.me && !g.winner;
    // порядок хода относительно меня
    const myIdx = g.order.indexOf(S.me);
    const ordered = g.order.map((_, i) => g.order[(myIdx + i + 1) % g.order.length]).filter((id) => id !== S.me);
    const handEl = app.querySelector('.hand');
    const scroll = handEl ? handEl.scrollLeft : 0;
    const newTop = prevTopId !== g.top.id;
    prevTopId = g.top.id;

    let status;
    if (g.winner) status = `🏆 ${esc(nameOf(g.winner))} выиграл!`;
    else if (myTurn) status = g.drawn !== null ? 'Сыграйте взятую карту или пасуйте' : (g.pending ? `Положите ${g.pendingType} или возьмите ${g.pending}` : 'Ваш ход');
    else status = `Ходит ${esc(nameOf(g.turn))}`;

    app.innerHTML = `
      <div class="table">
        <div class="opps">${ordered.map((id) => `
          <div class="opp ${g.turn === id && !g.winner ? 'turn' : ''}">
            ${g.called[id] && g.counts[id] === 1 ? '<span class="uno">УНО!</span>' : ''}
            <div class="n">${esc(nameOf(id))}</div>
            <div class="c">🂠 ${g.counts[id]}</div>
            ${g.catchable === id ? `<button class="catch" data-catch="1">Поймать!</button>` : ''}
          </div>`).join('')}</div>
        <div class="center">
          <div class="pile">
            <div class="draw-btn ${myTurn && g.drawn === null ? 'can' : ''}" id="drawPile">${backHtml()}</div>
            <span>колода · ${g.drawLeft}</span>
          </div>
          <div class="pile">
            ${cardHtml(g.top, newTop ? 'pop' : '')}
            <span>сброс</span>
          </div>
          <div class="pile">
            <div class="colorring" style="background:${COLOR_CSS[g.color]}" title="${COLOR_RU[g.color]}"></div>
            <span class="dirbadge">${g.dir === 1 ? '↻' : '↺'}</span>
            ${g.pending ? `<span class="pending">+${g.pending}</span>` : ''}
          </div>
        </div>
        ${S.timeLeft != null ? '<div class="timer" id="timer"><i></i></div><div class="timer-txt" id="timerTxt"></div>' : ''}
        <div class="status">${status}</div>
        <div class="log">${esc(g.log[g.log.length - 1] || '')}</div>
        <div class="hand">${g.hand.map((c) => {
          const ok = g.playable.includes(c.id);
          const fresh = !seenCards.has(c.id);
          seenCards.add(c.id);
          return cardHtml(c, `${ok ? 'ok' : (myTurn ? 'no' : '')} ${fresh ? 'deal' : ''}`, `data-id="${c.id}"`);
        }).join('')}</div>
        <div class="actions">
          ${g.hand.length <= 2 && !g.winner && !g.called[S.me] ? '<button class="btn" id="unoBtn">УНО!</button>' : ''}
          ${g.canPass ? '<button class="btn ghost" id="passBtn">Пас</button>' : ''}
          ${g.winner && amHost ? '<button class="btn" id="again">В лобби</button>' : ''}
          ${g.winner && !amHost ? '<span style="color:#fff">Ждём хоста…</span>' : ''}
        </div>
      </div>`;

    startTimer();
    const nh = app.querySelector('.hand'); if (nh) nh.scrollLeft = scroll;
    const act = (a) => emit('game:action', a);
    app.querySelectorAll('.hand .card.ok').forEach((el) => {
      el.onclick = () => {
        const id = Number(el.dataset.id);
        const card = g.hand.find((c) => c.id === id);
        if (card.color === 'w') pickColor((color) => act({ type: 'play', cardId: id, color }));
        else act({ type: 'play', cardId: id });
      };
    });
    $('#drawPile').onclick = () => { if (myTurn && g.drawn === null) act({ type: 'draw' }); };
    app.querySelectorAll('[data-catch]').forEach((b) => (b.onclick = () => act({ type: 'catch' })));
    const u = $('#unoBtn'); if (u) u.onclick = () => act({ type: 'uno' });
    const p = $('#passBtn'); if (p) p.onclick = () => act({ type: 'pass' });
    const a = $('#again'); if (a) a.onclick = () => emit('room:lobby');
  }

  // обратный отсчёт хода: S.timeLeft приходит с сервера в момент рассылки
  let timerRaf = null;
  function startTimer() {
    cancelAnimationFrame(timerRaf);
    const bar = $('#timer');
    if (!bar || S.timeLeft == null) return;
    const t0 = performance.now(); const left = S.timeLeft; const total = S.timerTotal || left || 1;
    const tick = () => {
      const rem = Math.max(0, left - (performance.now() - t0));
      bar.firstElementChild.style.transform = `scaleX(${rem / total})`;
      bar.classList.toggle('low', rem < 6000);
      const txt = $('#timerTxt'); if (txt) txt.textContent = S.game && S.game.turn === S.me ? `Ваш ход: ${Math.ceil(rem / 1000)} с` : '';
      if (rem > 0 && $('#timer') === bar) timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function pickColor(cb) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="box"><b>Выберите цвет</b><div class="colors">${['r', 'y', 'g', 'b'].map((c) => `<button style="background:${COLOR_CSS[c]}" data-c="${c}" aria-label="${COLOR_RU[c]}"></button>`).join('')}</div></div>`;
    m.onclick = (e) => {
      const b = e.target.closest('button');
      if (b) { cb(b.dataset.c); m.remove(); } else if (e.target === m) m.remove();
    };
    document.body.appendChild(m);
  }

  // старт
  renderHome();
})();
