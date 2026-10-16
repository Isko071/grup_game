'use strict';
// Логика УНО по мотивам мобильной версии. Состояние изменяется на месте; игрокам уходит только view().
//  - плюсы суммируются (настраивается), «+4» можно играть всегда (у неё четыре цвета);
//  - если нечем ходить: берёшь одну карту или берёшь, пока не выпадет подходящая;
//  - кнопка «УНО!» общая: ею и защищаешь себя, и ловишь забывшего;
//  - выигравший выходит, остальные играют дальше, пока не выиграет половина игроков (или создатель закончит игру).

const COLORS = ['r', 'y', 'g', 'b'];

const meta = {
  id: 'uno',
  title: 'УНО',
  minPlayers: 2,
  maxPlayers: 10,
  supportsBots: true,
  defaultRules: { stack: 'all', drawMode: 'one', turnTimer: 60 }, // таймер 60 с фиксирован, в настройках его нет
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
      key: 'drawMode', label: 'Если нечем ходить', type: 'select',
      choices: [
        { value: 'one', label: 'Берёт одну карту' },
        { value: 'until', label: 'Берёт, пока не выпадет подходящая' },
      ],
    },
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
    out: {}, // id -> 'finished' | 'left'
    finished: [], // порядок финиша
    places: null, // итоговая таблица мест
    over: false,
    seq: 0, // номер хода: таймер перезапускается на каждом новом ходе, даже если ходит тот же игрок
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

function isPlayable(st, card) {
  if (st.pending > 0) {
    if (st.rules.stack === 'off') return false;
    if (st.rules.stack === 'same') return card.value === st.pendingType;
    return card.value === '+2' || card.value === '+4';
  }
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
    if (!ctx || ctx.host !== pid) return { error: 'Только создатель' };
    if (st.finished.length < 1) return { error: 'Пока никто не выиграл' };
    say(st, 'Создатель завершил игру');
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
    // защитить себя можно, только когда уже осталась одна карта (кнопка появляется именно тогда)
    if (hand.length === 1 && !st.called[pid]) {
      st.called[pid] = true;
      say(st, `${nm(st, pid)}: УНО!`);
      did = true; sound = sound || 'uno';
    }
    if (!did) return { error: 'Сейчас «УНО!» не нужно' };
    return { ok: true, sound };
  }

  if (currentId(st) !== pid) return { error: 'Сейчас не ваш ход' };

  if (a.type === 'draw') {
    if (st.drawn !== null) return { error: 'Вы уже взяли карту' };
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
    } while (st.rules.drawMode === 'until' && !isPlayable(st, c));
    st.called[pid] = false;
    if (c && isPlayable(st, c)) {
      st.drawn = c.id;
      st.seq++;
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
    if (!isPlayable(st, card)) return { error: 'Эту карту нельзя сыграть' };
    if (card.color === 'w' && !COLORS.includes(a.color)) return { error: 'Выберите цвет' };

    hand.splice(idx, 1);
    st.discard.push(card);
    st.color = card.color === 'w' ? a.color : card.color;
    st.drawn = null;
    st.catchable = null;

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
    return { ok: true, sound };
  }

  return { error: 'Неизвестное действие' };
}

function endTurn(st, skip) {
  st.drawn = null;
  st.seq++;
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
    playable: mine ? me.filter((c) => (st.drawn === null || st.drawn === c.id) && isPlayable(st, c)).map((c) => c.id) : [],
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
    canFinish: !!ctx && ctx.host === pid && st.finished.length >= 1 && !st.over,
    // кнопка «UNO!» видна, только когда у кого-то осталась одна карта и «УНО!» ещё не крикнули
    unoAlert: !st.over && !st.out[pid] && ((me.length === 1 && !st.called[pid])
      || (!!st.catchable && st.catchable !== pid && !st.out[st.catchable] && st.hands[st.catchable].length === 1 && !st.called[st.catchable])),
    over: st.over,
    winner: st.finished[0] || null,
    goal: Math.ceil(st.order.length / 2),
    log: st.log.slice(-6),
  };
}

// Бот. Видит только то, что видит игрок: свою руку, верхнюю карту, число карт у соперников.
//  - на двух картах сам жмёт «УНО!», чужих забывших ловит почти всегда;
//  - если следующему осталась пара карт, бьёт его «пропуском», «+2», «+4»;
//  - «дикие» и действия бережёт, пока рука большая, и пускает в ход, когда нужно добить или остановить соперника;
//  - при штрафе кладёт «+2», а «+4» бережёт, пока нет угрозы;
//  - цвет выбирает по большинству оставшихся карт.
function botMove(st, pid) {
  if (st.over || st.out[pid]) return null;
  const hand = st.hands[pid];
  if (hand.length === 1 && !st.called[pid]) return { type: 'uno' };
  const t = st.catchable;
  if (t && t !== pid && !st.out[t] && st.hands[t].length === 1 && !st.called[t] && st.rnd() < 0.7) return { type: 'uno' };
  if (currentId(st) !== pid) return null;

  const ok = hand.filter((c) => (st.drawn === null || st.drawn === c.id) && isPlayable(st, c));
  if (!ok.length) return st.drawn !== null ? { type: 'pass' } : { type: 'draw' };

  const nextId = st.order[advance(st, st.turn, 1)];
  const threat = nextId !== pid && st.hands[nextId].length <= 2; // следующий вот-вот выиграет
  const colorCount = {};
  for (const h of hand) if (h.color !== 'w') colorCount[h.color] = (colorCount[h.color] || 0) + 1;
  const score = (c) => {
    const v = c.value;
    let sc = 0;
    if (v === 'wild') sc = hand.length <= 3 ? 4 : -1;
    else if (v === '+4') sc = st.pending > 0 ? (threat ? 8 : 1) : (hand.length <= 3 ? 5 : -2);
    else if (v === '+2') sc = st.pending > 0 ? 3 : -1;
    else if (v === 'skip' || v === 'rev') sc = -1; // действия приберегаем: числа уходят первыми
    if (threat && (v === '+2' || v === '+4' || v === 'skip')) sc += 7;
    if (c.color !== 'w') sc += 0.4 * (colorCount[c.color] || 0); // остаёмся в «своём» цвете
    return sc;
  };
  const best = ok.map((c) => ({ c, sc: score(c) })).sort((x, y) => y.sc - x.sc)[0];
  // только что взятую «дикую» можно оставить, если нет угрозы
  if (st.drawn !== null && best.sc < 0 && !threat && hand.length > 3) return { type: 'pass' };

  const left = {};
  for (const h of hand) if (h.id !== best.c.id && h.color !== 'w') left[h.color] = (left[h.color] || 0) + 1;
  const color = Object.keys(left).sort((x, y) => left[y] - left[x])[0] || COLORS[Math.floor(st.rnd() * 4)];
  return { type: 'play', cardId: best.c.id, color };
}

// Автоход по таймеру: взять карту (или принять штраф), а если уже взял — пас.
function timeoutMove(st, pid) {
  if (st.over || st.out[pid] || currentId(st) !== pid) return null;
  return st.drawn !== null ? { type: 'pass' } : { type: 'draw' };
}

module.exports = {
  meta, create, act, view, botMove, timeoutMove, removePlayer,
  currentPlayer: currentId,
  turnKey: (st) => `${currentId(st)}:${st.seq}`,
  isOver: (st) => st.over,
  _internal: { buildDeck, isPlayable, currentId, advance },
};
