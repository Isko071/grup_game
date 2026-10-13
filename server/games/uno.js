'use strict';
// Логика УНО. Состояние изменяется на месте; наружу игрокам отдаётся только view().

const COLORS = ['r', 'y', 'g', 'b'];

const meta = {
  id: 'uno',
  title: 'УНО',
  minPlayers: 2,
  maxPlayers: 10,
  supportsBots: true,
  defaultRules: { stackPlus2: false, stackPlus4: false },
  rulesSchema: [
    { key: 'stackPlus2', label: 'Накладывать +2 на +2', type: 'bool' },
    { key: 'stackPlus4', label: 'Стаканье +4 на +4', type: 'bool' },
  ],
};

function buildDeck() {
  const deck = [];
  let n = 0;
  const add = (color, value) => deck.push({ id: n++, color, value });
  for (const c of COLORS) {
    add(c, '0');
    for (let i = 1; i <= 9; i++) { add(c, String(i)); add(c, String(i)); }
    for (const v of ['skip', 'rev', '+2']) { add(c, v); add(c, v); }
  }
  for (let i = 0; i < 4; i++) { add('w', 'wild'); add('w', '+4'); }
  return deck;
}

function shuffle(arr, rnd = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function create(players, rules = {}, rnd = Math.random) {
  const r = { ...meta.defaultRules, ...rules };
  const draw = shuffle(buildDeck(), rnd);
  const st = {
    rules: r,
    order: players.map((p) => p.id),
    hands: {},
    draw,
    discard: [],
    color: null,
    dir: 1,
    turn: 0,
    pending: 0, // накопленные штрафные карты
    pendingType: null, // '+2' | '+4'
    drawn: null, // id карты, взятой в этот ход (можно сыграть или пропустить)
    called: {}, // id -> нажал «УНО»
    catchable: null, // id игрока, которого можно поймать
    winner: null,
    log: [],
    rnd,
  };
  for (const id of st.order) {
    st.hands[id] = [];
    st.called[id] = false;
  }
  for (let i = 0; i < 7; i++) for (const id of st.order) st.hands[id].push(st.draw.pop());
  // первая карта — не дикая
  let first = st.draw.pop();
  while (first.color === 'w') {
    st.draw.unshift(first);
    first = st.draw.pop();
  }
  st.discard.push(first);
  st.color = first.color;
  // эффект первой карты
  if (first.value === 'skip') st.turn = step(st, 1);
  else if (first.value === 'rev') {
    if (st.order.length === 2) st.turn = step(st, 1);
    else st.dir = -1;
  } else if (first.value === '+2') {
    st.pending = 2; st.pendingType = '+2';
  }
  say(st, 'Игра началась');
  return st;
}

function say(st, text) {
  st.log.push(text);
  if (st.log.length > 30) st.log.shift();
}

function step(st, n = 1, from = st.turn) {
  const len = st.order.length;
  return (((from + st.dir * n) % len) + len) % len;
}

function topCard(st) { return st.discard[st.discard.length - 1]; }
function currentId(st) { return st.order[st.turn]; }

function isPlayable(st, card) {
  if (st.pending > 0) {
    if (st.pendingType === '+2') return card.value === '+2' && st.rules.stackPlus2;
    if (st.pendingType === '+4') return card.value === '+4' && st.rules.stackPlus4;
    return false;
  }
  if (card.color === 'w') return true;
  const top = topCard(st);
  return card.color === st.color || card.value === top.value;
}

function takeFromDraw(st, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (st.draw.length === 0) {
      if (st.discard.length <= 1) break;
      const top = st.discard.pop();
      st.draw = shuffle(st.discard, st.rnd);
      st.discard = [top];
    }
    out.push(st.draw.pop());
  }
  return out;
}

function nameOf(st, id) { return (st.names && st.names[id]) || id; }

function act(st, pid, a) {
  if (st.winner) return { error: 'Игра окончена' };
  const hand = st.hands[pid];
  if (!hand) return { error: 'Вы не в игре' };

  if (a.type === 'uno') {
    if (hand.length > 2) return { error: 'Рано для «УНО!»' };
    st.called[pid] = true;
    say(st, `${nameOf(st, pid)}: УНО!`);
    return { ok: true, sound: 'uno' };
  }

  if (a.type === 'catch') {
    const t = st.catchable;
    if (!t || t === pid) return { error: 'Некого ловить' };
    if (st.hands[t].length !== 1 || st.called[t]) { st.catchable = null; return { error: 'Уже поздно' }; }
    st.hands[t].push(...takeFromDraw(st, 2));
    st.catchable = null;
    say(st, `${nameOf(st, pid)} поймал ${nameOf(st, t)} без «УНО!» (+2 карты)`);
    return { ok: true, sound: 'penalty' };
  }

  if (currentId(st) !== pid) return { error: 'Сейчас не ваш ход' };

  if (a.type === 'draw') {
    if (st.drawn !== null) return { error: 'Вы уже взяли карту' };
    if (st.pending > 0) {
      const n = st.pending;
      hand.push(...takeFromDraw(st, n));
      say(st, `${nameOf(st, pid)} берёт ${n} и пропускает ход`);
      st.pending = 0; st.pendingType = null;
      endTurn(st, pid, 0);
      return { ok: true, sound: 'draw' };
    }
    const [c] = takeFromDraw(st, 1);
    if (!c) { endTurn(st, pid, 0); return { ok: true }; }
    hand.push(c);
    st.called[pid] = false;
    if (isPlayable(st, c)) {
      st.drawn = c.id;
      say(st, `${nameOf(st, pid)} берёт карту`);
    } else {
      say(st, `${nameOf(st, pid)} берёт карту и пасует`);
      endTurn(st, pid, 0);
    }
    return { ok: true, sound: 'draw' };
  }

  if (a.type === 'pass') {
    if (st.drawn === null) return { error: 'Сначала возьмите карту' };
    say(st, `${nameOf(st, pid)} пасует`);
    endTurn(st, pid, 0);
    return { ok: true };
  }

  if (a.type === 'play') {
    const idx = hand.findIndex((c) => c.id === a.cardId);
    if (idx < 0) return { error: 'Нет такой карты' };
    const card = hand[idx];
    if (st.drawn !== null && st.drawn !== card.id) return { error: 'Можно сыграть только взятую карту' };
    if (!isPlayable(st, card)) return { error: 'Эту карту нельзя сыграть' };
    if (card.color === 'w' && !COLORS.includes(a.color)) return { error: 'Выберите цвет' };

    hand.splice(idx, 1);
    st.discard.push(card);
    st.color = card.color === 'w' ? a.color : card.color;
    st.drawn = null;
    st.catchable = null;

    if (hand.length === 0) {
      st.winner = pid;
      say(st, `${nameOf(st, pid)} выиграл!`);
      return { ok: true, sound: 'win' };
    }
    if (hand.length === 1 && !st.called[pid]) st.catchable = pid;
    if (hand.length > 1) st.called[pid] = false;

    let skip = 0;
    if (card.value === 'skip') { skip = 1; say(st, `${nameOf(st, pid)}: пропуск хода`); }
    else if (card.value === 'rev') {
      if (st.order.length === 2) skip = 1; else st.dir *= -1;
      say(st, `${nameOf(st, pid)}: смена направления`);
    } else if (card.value === '+2') {
      st.pending += 2; st.pendingType = '+2';
      say(st, `${nameOf(st, pid)}: +2`);
    } else if (card.value === '+4') {
      st.pending += 4; st.pendingType = '+4';
      say(st, `${nameOf(st, pid)}: +4, цвет — ${colorName(st.color)}`);
    } else if (card.value === 'wild') {
      say(st, `${nameOf(st, pid)}: цвет — ${colorName(st.color)}`);
    } else {
      say(st, `${nameOf(st, pid)} ходит`);
    }
    endTurn(st, pid, skip);
    return { ok: true, sound: 'play' };
  }

  return { error: 'Неизвестное действие' };
}

function colorName(c) {
  return { r: 'красный', y: 'жёлтый', g: 'зелёный', b: 'синий' }[c] || c;
}

function endTurn(st, pid, skip) {
  st.drawn = null;
  st.turn = step(st, 1 + skip);
}

function view(st, pid) {
  const me = st.hands[pid] || [];
  const cur = currentId(st);
  const mine = cur === pid && !st.winner;
  return {
    game: 'uno',
    order: st.order,
    counts: Object.fromEntries(st.order.map((id) => [id, st.hands[id].length])),
    called: st.called,
    hand: me,
    playable: mine ? me.filter((c) => (st.drawn === null || st.drawn === c.id) && isPlayable(st, c)).map((c) => c.id) : [],
    top: topCard(st),
    color: st.color,
    dir: st.dir,
    turn: cur,
    pending: st.pending,
    pendingType: st.pendingType,
    drawn: mine ? st.drawn : null,
    canPass: mine && st.drawn !== null,
    drawLeft: st.draw.length,
    catchable: st.catchable && st.catchable !== pid ? st.catchable : null,
    winner: st.winner,
    log: st.log.slice(-6),
  };
}

// Простой бот: играет первую подходящую карту, предпочитая не-дикие; цвет — самый частый в руке.
function botMove(st, pid) {
  if (st.winner) return null;
  const hand = st.hands[pid];
  if (hand.length === 2 && !st.called[pid]) return { type: 'uno' };
  if (st.catchable && st.catchable !== pid && st.rnd() < 0.5) return { type: 'catch' };
  if (currentId(st) !== pid) return null;
  const ok = hand.filter((c) => (st.drawn === null || st.drawn === c.id) && isPlayable(st, c));
  if (ok.length) {
    ok.sort((a, b) => (a.color === 'w') - (b.color === 'w'));
    const c = ok[0];
    const counts = {};
    for (const h of hand) if (h.color !== 'w') counts[h.color] = (counts[h.color] || 0) + 1;
    const color = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0] || COLORS[Math.floor(st.rnd() * 4)];
    return { type: 'play', cardId: c.id, color };
  }
  return st.drawn !== null ? { type: 'pass' } : { type: 'draw' };
}

module.exports = { meta, create, act, view, botMove, isOver: (st) => !!st.winner, _internal: { buildDeck, isPlayable, currentId } };
