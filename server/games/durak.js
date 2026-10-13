'use strict';
// Логика ДУРАКА (подкидной и переводной). Состояние меняется на месте; игрокам уходит только view().

const SUITS = ['h', 'd', 'c', 's']; // черви, бубны, трефы, пики
const HAND = 6;

const meta = {
  id: 'durak',
  title: 'Дурак',
  minPlayers: 2,
  maxPlayers: 6,
  supportsBots: true,
  defaultRules: { transfer: false, deckSize: 36, everyoneThrows: true },
  rulesSchema: [
    { key: 'transfer', label: 'Переводной (перевод картой того же достоинства)', type: 'bool' },
    { key: 'everyoneThrows', label: 'Подкидывают все игроки (иначе только соседи защитника)', type: 'bool' },
    { key: 'deckSize', label: 'Колода', type: 'select', options: [24, 36, 52], unit: 'карт' },
  ],
};

function validate(players, rules) {
  const size = Number({ ...meta.defaultRules, ...rules }.deckSize);
  if (players.length * HAND > size) return `В колоде на ${size} карт максимум ${Math.floor(size / HAND)} игрока`;
  return null;
}

function buildDeck(size) {
  const from = { 24: 9, 36: 6, 52: 2 }[size] || 6;
  const deck = [];
  let n = 0;
  for (const suit of SUITS) for (let rank = from; rank <= 14; rank++) deck.push({ id: n++, suit, rank });
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
  r.deckSize = [24, 36, 52].includes(Number(r.deckSize)) ? Number(r.deckSize) : 36;
  const deck = shuffle(buildDeck(r.deckSize), rnd);
  const trumpCard = deck[0]; // лежит снизу колоды, берётся последней
  const st = {
    rules: r,
    order: players.map((p) => p.id),
    hands: {},
    deck,
    trumpCard,
    trumpSuit: trumpCard.suit,
    discard: 0,
    table: [], // [{a, d}]
    attacker: null,
    defender: null,
    taking: false,
    passed: {},
    out: [], // вышедшие (в порядке выхода)
    roundDefHand: 0,
    firstBout: true,
    over: false,
    loser: null,
    bubbles: {}, // id -> короткая реплика над аватаром («Пас», «Беру»)
    lastEnd: null, // снимок стола перед закрытием раунда: чтобы клиент успел показать последнюю карту
    log: [],
    rnd,
  };
  for (const id of st.order) st.hands[id] = [];
  for (let i = 0; i < HAND; i++) for (const id of st.order) if (st.deck.length) st.hands[id].push(st.deck.pop());
  // ходит первым владелец младшего козыря
  let first = st.order[0];
  let best = 99;
  for (const id of st.order) for (const c of st.hands[id]) if (c.suit === st.trumpSuit && c.rank < best) { best = c.rank; first = id; }
  st.attacker = first;
  st.defender = nextActive(st, first);
  st.roundDefHand = st.hands[st.defender].length;
  say(st, 'Игра началась');
  return st;
}

function say(st, t) { st.log.push(t); if (st.log.length > 30) st.log.shift(); }
const nm = (st, id) => (st.names && st.names[id]) || id;
const isOut = (st, id) => st.out.includes(id);

// следующий не вышедший игрок после id по кругу
function nextActive(st, id) {
  const n = st.order.length;
  let i = st.order.indexOf(id);
  for (let k = 0; k < n; k++) {
    i = (i + 1) % n;
    if (!isOut(st, st.order[i])) return st.order[i];
  }
  return id;
}

const isTrump = (st, c) => c.suit === st.trumpSuit;
function beats(st, att, def) {
  if (def.suit === att.suit) return def.rank > att.rank;
  return def.suit === st.trumpSuit && att.suit !== st.trumpSuit;
}
const limit = (st) => Math.min(st.firstBout ? 5 : HAND, st.roundDefHand);
const undefended = (st) => st.table.filter((p) => !p.d);
const allCovered = (st) => st.table.length > 0 && undefended(st).length === 0;
const tableRanks = (st) => new Set(st.table.flatMap((p) => (p.d ? [p.a.rank, p.d.rank] : [p.a.rank])));

function throwerIds(st) {
  let ids = st.order.filter((id) => !isOut(st, id) && id !== st.defender && st.hands[id].length > 0);
  if (!st.rules.everyoneThrows) {
    const nb = nextActive(st, st.defender);
    ids = ids.filter((id) => id === st.attacker || id === nb);
  }
  return ids;
}

function legalThrow(st, pid, card) {
  if (st.table.length === 0) return pid === st.attacker;
  if (pid === st.defender) return false;
  if (!throwerIds(st).includes(pid)) return false;
  if (st.table.length >= limit(st)) return false;
  return tableRanks(st).has(card.rank);
}

const isDone = (st, pid) => !!st.passed[pid] || !st.hands[pid].some((c) => legalThrow(st, pid, c));

function roundComplete(st) {
  if (st.table.length === 0) return false;
  if (!(st.taking || allCovered(st))) return false;
  return throwerIds(st).every((id) => isDone(st, id));
}

function canTransferCard(st, pid, card) {
  if (!st.rules.transfer || pid !== st.defender || st.taking || st.table.length === 0) return false;
  if (st.table.some((p) => p.d)) return false;
  if (!st.table.every((p) => p.a.rank === card.rank)) return false;
  const next = nextActive(st, st.defender);
  if (next === st.defender) return false;
  return st.hands[next].length >= st.table.length + 1;
}

function act(st, pid, a) {
  if (st.over) return { error: 'Игра окончена' };
  const hand = st.hands[pid];
  if (!hand || isOut(st, pid)) return { error: 'Вы не в игре' };

  if (a.type === 'attack') {
    const idx = hand.findIndex((c) => c.id === a.cardId);
    if (idx < 0) return { error: 'Нет такой карты' };
    const card = hand[idx];
    if (!legalThrow(st, pid, card)) {
      return { error: st.table.length === 0 ? 'Сейчас ходит другой игрок' : 'Эту карту подкинуть нельзя' };
    }
    hand.splice(idx, 1);
    st.table.push({ a: card, d: null });
    st.passed = {};
    st.bubbles = {};
    say(st, `${nm(st, pid)} ${st.table.length === 1 ? 'ходит' : 'подкидывает'}`);
    return after(st, 'play');
  }

  if (a.type === 'defend') {
    if (pid !== st.defender) return { error: 'Вы не защищаетесь' };
    if (st.taking) return { error: 'Вы уже берёте' };
    const pair = st.table[a.attackId];
    if (!pair || pair.d) return { error: 'Нет такой карты на столе' };
    const idx = hand.findIndex((c) => c.id === a.cardId);
    if (idx < 0) return { error: 'Нет такой карты' };
    if (!beats(st, pair.a, hand[idx])) return { error: 'Эта карта не бьёт' };
    pair.d = hand.splice(idx, 1)[0];
    st.passed = {};
    st.bubbles = {};
    return after(st, 'play');
  }

  if (a.type === 'transfer') {
    const idx = hand.findIndex((c) => c.id === a.cardId);
    if (idx < 0) return { error: 'Нет такой карты' };
    if (!canTransferCard(st, pid, hand[idx])) return { error: 'Перевести нельзя' };
    const next = nextActive(st, st.defender);
    st.table.push({ a: hand.splice(idx, 1)[0], d: null });
    st.attacker = pid;
    st.defender = next;
    st.roundDefHand = st.hands[next].length;
    st.passed = {};
    st.bubbles = { [pid]: 'Перевод' };
    say(st, `${nm(st, pid)} переводит на ${nm(st, next)}`);
    return after(st, 'play');
  }

  if (a.type === 'take') {
    if (pid !== st.defender) return { error: 'Вы не защищаетесь' };
    if (st.taking) return { error: 'Вы уже берёте' };
    if (undefended(st).length === 0) return { error: 'Нечего брать' };
    st.taking = true;
    st.passed = {};
    st.bubbles = { [pid]: 'Беру' };
    say(st, `${nm(st, pid)} берёт`);
    return after(st, 'draw');
  }

  if (a.type === 'pass') {
    if (st.table.length === 0) return { error: 'Нужно сделать ход' };
    if (!throwerIds(st).includes(pid)) return { error: 'Вы не подкидываете' };
    if (!(st.taking || allCovered(st))) return { error: 'Защитник ещё отбивается' };
    st.passed[pid] = true;
    st.bubbles[pid] = 'Пас';
    return after(st, null);
  }

  return { error: 'Неизвестное действие' };
}

function after(st, sound) {
  if (roundComplete(st)) {
    const s = endRound(st);
    return { ok: true, sound: st.over ? 'win' : (s || sound) };
  }
  return { ok: true, sound };
}

function endRound(st) {
  const def = st.defender;
  const att = st.attacker;
  const took = st.taking;
  const snapshot = {
    n: (st.lastEnd ? st.lastEnd.n : 0) + 1,
    table: st.table.map((p) => ({ a: p.a, d: p.d })),
    took,
    attacker: att,
    defender: def,
    counts: Object.fromEntries(st.order.map((id) => [id, st.hands[id].length])),
    hands: Object.fromEntries(st.order.map((id) => [id, [...st.hands[id]]])),
    deckLeft: st.deck.length,
    discard: st.discard,
  };
  const cards = st.table.flatMap((p) => (p.d ? [p.a, p.d] : [p.a]));
  let sound = null;
  if (took) { st.hands[def].push(...cards); sound = 'draw'; say(st, `${nm(st, def)} забрал карты`); }
  else { st.discard += cards.length; say(st, 'Бито'); }
  st.table = [];
  st.taking = false;
  st.passed = {};
  st.bubbles = {};
  st.firstBout = false;

  // добор: сначала атакующий, затем по кругу, защитник последним
  const seq = [];
  let id = att;
  for (let i = 0; i < st.order.length; i++) {
    if (!isOut(st, id) && id !== def) seq.push(id);
    id = st.order[(st.order.indexOf(id) + 1) % st.order.length];
  }
  if (!isOut(st, def)) seq.push(def);
  for (const p of seq) while (st.hands[p].length < HAND && st.deck.length) st.hands[p].push(st.deck.pop());

  if (st.deck.length === 0) {
    for (const p of st.order) {
      if (!isOut(st, p) && st.hands[p].length === 0) { st.out.push(p); say(st, `${nm(st, p)} вышел из игры`); }
    }
  }
  st.lastEnd = snapshot;
  const active = st.order.filter((p) => !isOut(st, p));
  if (active.length <= 1) {
    st.over = true;
    st.loser = active[0] || null;
    say(st, st.loser ? `${nm(st, st.loser)} — дурак!` : 'Ничья');
    return sound;
  }
  let cand = took ? nextActive(st, def) : def;
  if (isOut(st, cand)) cand = nextActive(st, cand);
  st.attacker = cand;
  st.defender = nextActive(st, cand);
  st.roundDefHand = st.hands[st.defender].length;
  return sound;
}

function view(st, pid) {
  const me = st.hands[pid] || [];
  const isDef = pid === st.defender;
  const throwers = throwerIds(st);
  const und = st.table.map((p, i) => ({ p, i })).filter((x) => !x.p.d);
  const canAttack = st.over ? [] : me.filter((c) => legalThrow(st, pid, c)).map((c) => c.id);
  const canDefend = {};
  if (isDef && !st.taking && !st.over) {
    for (const c of me) {
      const t = und.filter((x) => beats(st, x.p.a, c)).map((x) => x.i);
      if (t.length) canDefend[c.id] = t;
    }
  }
  const canTransfer = st.over ? [] : me.filter((c) => canTransferCard(st, pid, c)).map((c) => c.id);
  return {
    game: 'durak',
    order: st.order,
    counts: Object.fromEntries(st.order.map((id) => [id, st.hands[id].length])),
    out: st.out,
    hand: me,
    table: st.table,
    trump: st.trumpCard,
    trumpSuit: st.trumpSuit,
    deckLeft: st.deck.length,
    discard: st.discard,
    attacker: st.attacker,
    defender: st.defender,
    taking: st.taking,
    canAttack,
    canDefend,
    canTransfer,
    canTake: isDef && !st.taking && und.length > 0 && !st.over,
    canPass: !st.over && throwers.includes(pid) && st.table.length > 0 && (st.taking || allCovered(st)) && !st.passed[pid],
    bubbles: st.bubbles,
    lastEnd: st.lastEnd ? { n: st.lastEnd.n, table: st.lastEnd.table, took: st.lastEnd.took, attacker: st.lastEnd.attacker, defender: st.lastEnd.defender, counts: st.lastEnd.counts, hand: st.lastEnd.hands[pid] || [], deckLeft: st.lastEnd.deckLeft, discard: st.lastEnd.discard } : null,
    over: st.over,
    loser: st.loser,
    log: st.log.slice(-6),
  };
}

const rankSort = (st) => (a, b) => (isTrump(st, a) - isTrump(st, b)) || a.rank - b.rank;
const cardCost = (st, c) => (isTrump(st, c) ? 100 : 0) + c.rank; // чем «дороже» карта, тем жальче её тратить

// Лучший способ отбить все карты на столе: перебор с минимальной суммарной «ценой» (null — отбить нечем)
function bestCover(st, und, hand) {
  const items = und
    .map((u) => ({ ...u, n: hand.filter((c) => beats(st, u.p.a, c)).length }))
    .sort((x, y) => x.n - y.n);
  let best = null;
  const used = new Set();
  const cur = [];
  (function dfs(k, total) {
    if (best && total >= best.cost) return;
    if (k === items.length) { best = { pairs: [...cur], cost: total }; return; }
    const it = items[k];
    const opts = hand.filter((c) => !used.has(c.id) && beats(st, it.p.a, c)).sort((a, b) => cardCost(st, a) - cardCost(st, b));
    for (const c of opts) {
      used.add(c.id); cur.push({ i: it.i, card: c });
      dfs(k + 1, total + cardCost(st, c));
      cur.pop(); used.delete(c.id);
    }
  }(0, 0));
  return best;
}

// Бот. Видит только то, что видит игрок.
//  - отбивается так, чтобы потратить как можно меньше (и не отдать нужную карту другой атаке);
//  - не тратит старшие козыри на мелочь, пока колода большая: лучше взять;
//  - ходит младшими некозырями, предпочитая достоинства, которые есть парой (потом можно подкинуть);
//  - при «беру» у защитника сбрасывает ему любые некозыри, а в конце игры и козыри;
//  - переводит некозырной картой, когда можно.
function botMove(st, pid) {
  if (st.over) return null;
  const hand = st.hands[pid];
  if (isOut(st, pid) || !hand.length) return null;

  if (pid === st.defender) {
    if (st.taking) return null;
    const und = st.table.map((p, i) => ({ p, i })).filter((x) => !x.p.d);
    if (!und.length) return null;
    const tr = [...hand].sort(rankSort(st)).find((c) => !isTrump(st, c) && canTransferCard(st, pid, c));
    if (tr) return { type: 'transfer', cardId: tr.id };
    const cover = bestCover(st, und, hand);
    if (!cover) return { type: 'take' };
    const burned = cover.pairs.filter((x) => isTrump(st, x.card));
    const cheapAttack = und.every((u) => !isTrump(st, u.p.a) && u.p.a.rank <= 9);
    if (burned.length && st.deck.length >= 8 && cheapAttack && burned.some((x) => x.card.rank >= 11)) return { type: 'take' };
    return { type: 'defend', attackId: cover.pairs[0].i, cardId: cover.pairs[0].card.id };
  }

  if (st.table.length === 0) {
    if (pid !== st.attacker) return null;
    const sorted = [...hand].sort(rankSort(st));
    const pool = sorted.some((c) => !isTrump(st, c)) ? sorted.filter((c) => !isTrump(st, c)) : sorted;
    const cnt = {};
    for (const c of hand) cnt[c.rank] = (cnt[c.rank] || 0) + 1;
    const lead = pool.reduce((m, c) => (c.rank - (cnt[c.rank] > 1 ? 2 : 0) < m.rank - (cnt[m.rank] > 1 ? 2 : 0) ? c : m), pool[0]);
    return { type: 'attack', cardId: lead.id };
  }

  if (!throwerIds(st).includes(pid) || !(st.taking || allCovered(st)) || st.passed[pid]) return null;
  const legal = hand.filter((x) => legalThrow(st, pid, x)).sort(rankSort(st));
  let c = legal.find((x) => !isTrump(st, x));
  if (!c && st.deck.length === 0) c = legal.find(() => st.taking || hand.length <= 2); // конец игры: добиваем или нагружаем защитника
  return c ? { type: 'attack', cardId: c.id } : { type: 'pass' };
}

module.exports = {
  meta, create, act, view, botMove, validate,
  isOver: (st) => st.over,
  _internal: { buildDeck, beats, legalThrow, nextActive, canTransferCard, throwerIds },
};
