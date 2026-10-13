'use strict';
// Логика УНО по мотивам мобильной версии. Состояние изменяется на месте; игрокам уходит только view().
//  - плюсы суммируются (настраивается), «+4» можно оспорить;
//  - если нечем ходить: берёшь одну карту или берёшь, пока не выпадет подходящая;
//  - кнопка «УНО!» общая: ею и защищаешь себя, и ловишь забывшего;
//  - выигравший выходит, остальные играют дальше, пока не выиграет половина игроков (или хост закончит игру).

const COLORS = ['r', 'y', 'g', 'b'];

const meta = {
  id: 'uno',
  title: 'УНО',
  minPlayers: 2,
  maxPlayers: 10,
  supportsBots: false,
  defaultRules: { stack: 'all', wild4: 'challenge', drawMode: 'one', turnTimer: 30 },
  rulesSchema: [
    {
      key: 'stack', label: 'Плюсы (+2 и +4) суммируются', type: 'select',
      choices: [
        { value: 'all', label: 'Любые на любые' },
        { value: 'same', label: 'Только одинаковые' },
        { value: 'off', label: 'Не суммируются' },
      ],
    },
    {
      key: 'wild4', label: 'Карта «+4»', type: 'select',
      choices: [
        { value: 'challenge', label: 'Можно оспорить' },
        { value: 'strict', label: 'Только без нужного цвета' },
        { value: 'free', label: 'Без ограничений' },
      ],
    },
    {
      key: 'drawMode', label: 'Если нечем ходить', type: 'select',
      choices: [
        { value: 'one', label: 'Берёт одну карту' },
        { value: 'until', label: 'Берёт, пока не выпадет подходящая' },
      ],
    },
    { key: 'turnTimer', label: 'Таймер хода', type: 'select', options: [0, 15, 30, 45, 60, 90], unit: 'с', zero: 'без таймера' },
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
  const st = {
    rules: r,
    order: players.map((p) => p.id),
    hands: {},
    draw: shuffle(buildDeck(), rnd),
    discard: [],
    color: null,
    dir: 1,
    turn: 0,
    pending: 0, // накопленные штрафные карты
    pendingType: null, // '+2' | '+4' — последняя сыгранная плюс-карта
    drawn: null, // id карты, взятой в этот ход (можно сыграть или пропустить)
    called: {}, // id -> нажал «УНО»
    catchable: null, // id игрока, которого можно поймать
    challenge: null, // {by, target, legal}: ждём, оспорит ли target чужую «+4»
    out: {}, // id -> 'finished' | 'left'
    finished: [], // порядок финиша
    places: null, // итоговая таблица мест
    over: false,
    log: [],
    rnd,
  };
  for (const id of st.order) { st.hands[id] = []; st.called[id] = false; }
  for (let i = 0; i < 7; i++) for (const id of st.order) st.hands[id].push(st.draw.pop());
  let first = st.draw.pop();
  while (first.color === 'w') { st.draw.unshift(first); first = st.draw.pop(); }
  st.discard.push(first);
  st.color = first.color;
  if (first.value === 'skip') st.turn = advance(st, 0, 1);
  else if (first.value === 'rev') {
    if (st.order.length === 2) st.turn = advance(st, 0, 1);
    else st.dir = -1;
  } else if (first.value === '+2') { st.pending = 2; st.pendingType = '+2'; }
  say(st, 'Игра началась');
  return st;
}

function say(st, text) { st.log.push(text); if (st.log.length > 30) st.log.shift(); }
const nm = (st, id) => (st.names && st.names[id]) || id;
const activeIds = (st) => st.order.filter((id) => !st.out[id]);
const topCard = (st) => st.discard[st.discard.length - 1];
const currentId = (st) => st.order[st.turn];

// шаг по кругу на n активных игроков (вышедшие пропускаются)
function advance(st, from, n = 1) {
  const len = st.order.length;
  let i = from;
  if (activeIds(st).length === 0) return i;
  for (let k = 0; k < n; k++) {
    do { i = (((i + st.dir) % len) + len) % len; } while (st.out[st.order[i]]);
  }
  return i;
}

function isPlayable(st, card, hand) {
  if (st.pending > 0) {
    if (st.rules.stack === 'off') return false;
    if (st.rules.stack === 'same') return card.value === st.pendingType;
    return card.value === '+2' || card.value === '+4';
  }
  if (card.value === '+4' && st.rules.wild4 === 'strict' && hand && hand.some((c) => c.color === st.color)) return false;
  if (card.color === 'w') return true;
  return card.color === st.color || card.value === topCard(st).value;
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

function giveCards(st, pid, n) {
  const cards = takeFromDraw(st, n);
  st.hands[pid].push(...cards);
  if (st.hands[pid].length > 1) st.called[pid] = false;
  if (st.catchable === pid && st.hands[pid].length !== 1) st.catchable = null;
  return cards.length;
}

const colorName = (c) => ({ r: 'красный', y: 'жёлтый', g: 'зелёный', b: 'синий' }[c] || c);
const cardWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'карту' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'карты' : 'карт'));

function act(st, pid, a, ctx) {
  if (st.over) return { error: 'Игра окончена' };

  if (a.type === 'finish') {
    if (!ctx || ctx.host !== pid) return { error: 'Только хост' };
    if (st.finished.length < 1) return { error: 'Пока никто не выиграл' };
    say(st, 'Хост завершил игру');
    finalize(st);
    return { ok: true, sound: 'win' };
  }

  const hand = st.hands[pid];
  if (!hand || st.out[pid]) return { error: 'Вы не в игре' };

  // «УНО!» — одна кнопка для всех: защищает себя и ловит забывших
  if (a.type === 'uno') {
    let did = false;
    let sound = null;
    const t = st.catchable;
    if (t && t !== pid && !st.out[t] && st.hands[t].length === 1 && !st.called[t]) {
      giveCards(st, t, 2);
      st.catchable = null;
      say(st, `${nm(st, pid)} поймал ${nm(st, t)} без «УНО!» (+2 карты)`);
      did = true; sound = 'penalty';
    }
    if (hand.length <= 2 && !st.called[pid]) {
      st.called[pid] = true;
      say(st, `${nm(st, pid)}: УНО!`);
      did = true; sound = sound || 'uno';
    }
    if (!did) return { error: 'Сейчас «УНО!» не нужно' };
    return { ok: true, sound };
  }

  if (currentId(st) !== pid) return { error: 'Сейчас не ваш ход' };

  if (a.type === 'challenge') {
    const ch = st.challenge;
    if (!ch || ch.target !== pid) return { error: 'Нечего оспаривать' };
    const n = st.pending;
    st.pending = 0; st.pendingType = null; st.challenge = null;
    if (!ch.legal) {
      giveCards(st, ch.by, n);
      say(st, `${nm(st, pid)} оспорил «+4»: у ${nm(st, ch.by)} был нужный цвет — он берёт ${n} ${cardWord(n)}`);
      return { ok: true, sound: 'penalty' };
    }
    const m = n + 2;
    giveCards(st, pid, m);
    say(st, `${nm(st, pid)} оспорил зря и берёт ${m} ${cardWord(m)}`);
    endTurn(st, 0);
    return { ok: true, sound: 'draw' };
  }

  if (a.type === 'draw') {
    if (st.drawn !== null) return { error: 'Вы уже взяли карту' };
    st.challenge = null; // взять карты = принять «+4»
    if (st.pending > 0) {
      const n = st.pending;
      giveCards(st, pid, n);
      say(st, `${nm(st, pid)} берёт ${n} ${cardWord(n)} и пропускает ход`);
      st.pending = 0; st.pendingType = null;
      endTurn(st, 0);
      return { ok: true, sound: 'draw' };
    }
    let got = 0;
    let c = null;
    do {
      [c] = takeFromDraw(st, 1);
      if (!c) break;
      hand.push(c); got++;
    } while (st.rules.drawMode === 'until' && !isPlayable(st, c, hand));
    st.called[pid] = false;
    if (c && isPlayable(st, c, hand)) {
      st.drawn = c.id;
      say(st, `${nm(st, pid)} берёт ${got} ${cardWord(got)}`);
    } else {
      say(st, `${nm(st, pid)} берёт ${got} ${cardWord(got)} и пасует`);
      endTurn(st, 0);
    }
    return { ok: true, sound: 'draw' };
  }

  if (a.type === 'pass') {
    if (st.drawn === null) return { error: 'Сначала возьмите карту' };
    say(st, `${nm(st, pid)} пасует`);
    endTurn(st, 0);
    return { ok: true };
  }

  if (a.type === 'play') {
    const idx = hand.findIndex((c) => c.id === a.cardId);
    if (idx < 0) return { error: 'Нет такой карты' };
    const card = hand[idx];
    if (st.drawn !== null && st.drawn !== card.id) return { error: 'Можно сыграть только взятую карту' };
    if (!isPlayable(st, card, hand)) return { error: card.value === '+4' ? '«+4» можно, только если нет карты нужного цвета' : 'Эту карту нельзя сыграть' };
    if (card.color === 'w' && !COLORS.includes(a.color)) return { error: 'Выберите цвет' };

    const prevColor = st.color;
    const wasPending = st.pending;
    const hadColor = card.value === '+4' && hand.some((c) => c.id !== card.id && c.color === prevColor);
    hand.splice(idx, 1);
    st.discard.push(card);
    st.color = card.color === 'w' ? a.color : card.color;
    st.drawn = null;
    st.catchable = null;
    st.challenge = null; // сыграть плюс-карту в ответ = принять предыдущую «+4»

    let sound = 'play';
    if (hand.length === 0) {
      st.out[pid] = 'finished';
      st.finished.push(pid);
      say(st, `${nm(st, pid)} выходит из игры — место ${st.finished.length}!`);
      sound = 'win';
      if (st.finished.length >= Math.ceil(st.order.length / 2) || activeIds(st).length < 2) { finalize(st); return { ok: true, sound }; }
    } else if (hand.length === 1 && !st.called[pid]) st.catchable = pid;
    if (hand.length > 1) st.called[pid] = false;

    let skip = 0;
    if (card.value === 'skip') { skip = 1; say(st, `${nm(st, pid)}: пропуск хода`); }
    else if (card.value === 'rev') {
      if (activeIds(st).length === 2 && !st.out[pid]) skip = 1; else st.dir *= -1;
      say(st, `${nm(st, pid)}: смена направления`);
    } else if (card.value === '+2') {
      st.pending += 2; st.pendingType = '+2';
      say(st, `${nm(st, pid)}: +2${st.pending > 2 ? ` (всего ${st.pending})` : ''}`);
    } else if (card.value === '+4') {
      st.pending += 4; st.pendingType = '+4';
      say(st, `${nm(st, pid)}: +4${st.pending > 4 ? ` (всего ${st.pending})` : ''}, цвет — ${colorName(st.color)}`);
    } else if (card.value === 'wild') say(st, `${nm(st, pid)}: цвет — ${colorName(st.color)}`);
    else say(st, `${nm(st, pid)} ходит`);

    endTurn(st, skip);
    if (card.value === '+4' && wasPending === 0 && st.rules.wild4 === 'challenge' && hand.length > 0) {
      st.challenge = { by: pid, target: currentId(st), legal: !hadColor };
    }
    return { ok: true, sound };
  }

  return { error: 'Неизвестное действие' };
}

function endTurn(st, skip) {
  st.drawn = null;
  st.turn = advance(st, st.turn, 1 + skip);
}

// итоговая таблица: финишировавшие, затем остальные по числу карт, затем вышедшие из партии
function finalize(st) {
  const rest = activeIds(st).sort((a, b) => st.hands[a].length - st.hands[b].length);
  const left = st.order.filter((id) => st.out[id] === 'left');
  st.places = [...st.finished, ...rest, ...left];
  st.over = true;
  say(st, 'Партия окончена');
}

// Игрок вышел из партии: карты уходят в низ колоды, ход переходит дальше
function removePlayer(st, pid) {
  if (st.over || st.out[pid] || !st.hands[pid]) return;
  const wasCurrent = currentId(st) === pid;
  st.out[pid] = 'left';
  st.draw.unshift(...st.hands[pid]);
  st.hands[pid] = [];
  if (st.catchable === pid) st.catchable = null;
  if (st.challenge && st.challenge.target === pid) st.challenge = null;
  say(st, `${nm(st, pid)} вышел из партии`);
  if (activeIds(st).length < 2) return finalize(st);
  if (wasCurrent) endTurn(st, 0);
}

function view(st, pid, ctx) {
  const me = st.hands[pid] || [];
  const cur = currentId(st);
  const mine = cur === pid && !st.over && !st.out[pid];
  return {
    game: 'uno',
    order: st.order,
    counts: Object.fromEntries(st.order.map((id) => [id, st.hands[id].length])),
    called: st.called,
    out: st.out,
    finished: st.finished,
    places: st.places,
    hand: me,
    playable: mine ? me.filter((c) => (st.drawn === null || st.drawn === c.id) && isPlayable(st, c, me)).map((c) => c.id) : [],
    top: topCard(st),
    recent: st.discard.slice(-4),
    color: st.color,
    dir: st.dir,
    turn: cur,
    pending: st.pending,
    pendingType: st.pendingType,
    drawn: mine ? st.drawn : null,
    canPass: mine && st.drawn !== null,
    drawLeft: st.draw.length,
    challenge: st.challenge ? { by: st.challenge.by, target: st.challenge.target } : null,
    canFinish: !!ctx && ctx.host === pid && st.finished.length >= 1 && !st.over,
    over: st.over,
    winner: st.finished[0] || null,
    goal: Math.ceil(st.order.length / 2),
    log: st.log.slice(-6),
  };
}

// Автоход по таймеру: принять «+4»/взять карту, а если уже взял — пас.
function timeoutMove(st, pid) {
  if (st.over || st.out[pid] || currentId(st) !== pid) return null;
  return st.drawn !== null ? { type: 'pass' } : { type: 'draw' };
}

module.exports = {
  meta, create, act, view, timeoutMove, removePlayer,
  currentPlayer: currentId,
  turnKey: (st) => `${currentId(st)}:${st.drawn !== null}:${st.challenge ? 1 : 0}`,
  isOver: (st) => st.over,
  _internal: { buildDeck, isPlayable, currentId },
};
