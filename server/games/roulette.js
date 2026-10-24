'use strict';
// ЗАДАНИЯ — «правда или действие» с рулеткой имён.
// Круг: кто-то крутит рулетку с именами → она останавливается на случайном игроке → он выбирает «правда» или «действие» →
// тот, кто крутил, придумывает задание (или берёт случайное из колоды) → игрок выполняет или отказывается.
// Кто крутит следующим — настраивается в лобби. Состояние меняется на месте; игрокам уходит только view().

const TASKS = require('./roulette-tasks');

const meta = {
  id: 'roulette',
  title: 'Задания',
  minPlayers: 2,
  maxPlayers: 15,
  supportsBots: false,
  joinAnytime: true, // можно зайти по ссылке посреди игры
  defaultRules: { spinner: 'target', tasks: 'player' },
  rulesSchema: [
    {
      key: 'spinner', label: 'Кто крутит', type: 'select',
      choices: [
        { value: 'target', label: 'На кого выпало' },
        { value: 'round', label: 'По кругу' },
        { value: 'anyone', label: 'Любой' },
        { value: 'host', label: 'Создатель' },
      ],
    },
    {
      key: 'tasks', label: 'Кто придумывает', type: 'select',
      choices: [{ value: 'player', label: 'Решают игроки' }, { value: 'deck', label: 'Предлагает сайт' }],
    },
  ],
};

const HISTORY = 12;

function create(players, rules = {}, rnd = Math.random, ctx = {}) {
  const r = { ...meta.defaultRules, ...rules };
  const order = players.map((p) => p.id);
  const st = {
    rules: r,
    order,
    phase: 'spin', // spin → choose → task → doing → spin …
    spinner: null, // кто крутит сейчас (null — любой)
    round: null, // { by, target, kind, task, fromDeck }
    spinSeq: 0, // номер прокрутки — клиент по нему запускает анимацию
    turns: 5, // сколько полных оборотов в анимации
    jitter: 0, // где именно внутри сектора игрока остановится стрелка (−0.35…0.35 от ширины сектора)
    recent: [], // на кого выпадало недавно (последний — в конце)
    stats: Object.fromEntries(order.map((id) => [id, { done: 0, refused: 0 }])),
    used: { truth: [], dare: [] },
    history: [],
    over: false,
    rnd,
  };
  st.spinner = firstSpinner(st, ctx.hostId || ctx.host);
  return st;
}

function firstSpinner(st, host) {
  const m = st.rules.spinner;
  if (m === 'anyone') return null;
  if (m === 'host') return host || st.order[0];
  return st.order[Math.floor(st.rnd() * st.order.length)];
}

// кто крутит в следующем круге
function nextSpinner(st, host) {
  const m = st.rules.spinner;
  const r = st.round;
  if (m === 'anyone') return null;
  if (m === 'host') return host;
  if (m === 'target' && r && st.order.includes(r.target)) return r.target;
  // по кругу: следующий за тем, кто крутил
  const prev = r ? r.by : st.spinner;
  const i = st.order.indexOf(prev);
  if (i < 0) return st.order[0];
  return st.order[(i + 1) % st.order.length];
}

function canSpin(st, pid, host) {
  if (st.over || st.phase !== 'spin' || !st.order.includes(pid)) return false;
  if (st.rules.spinner === 'anyone') return true;
  if (st.rules.spinner === 'host') return pid === host;
  return pid === st.spinner;
}

// Случайный игрок; кому недавно выпадало, тому шанс меньше (но выпасть снова можно):
// последнему — 35% от обычного, предпоследнему — 60%
function pickTarget(st, others) {
  const w = others.map((id) => (id === st.recent[st.recent.length - 1] ? 0.35 : id === st.recent[st.recent.length - 2] ? 0.6 : 1));
  let x = st.rnd() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < others.length; i++) { x -= w[i]; if (x < 0) return others[i]; }
  return others[others.length - 1];
}

function drawTask(st, kind) {
  const list = TASKS[kind];
  let free = list.map((_, i) => i).filter((i) => !st.used[kind].includes(i));
  if (!free.length) { st.used[kind] = []; free = list.map((_, i) => i); }
  const i = free[Math.floor(st.rnd() * free.length)];
  st.used[kind].push(i);
  return list[i];
}

function newRound(st, host) {
  st.spinner = nextSpinner(st, host);
  st.round = null;
  st.phase = 'spin';
}

function finishRound(st, result, host) {
  const r = st.round;
  if (r && st.stats[r.target]) st.stats[r.target][result === 'done' ? 'done' : 'refused']++;
  if (r) {
    st.history.push({ by: r.by, target: r.target, kind: r.kind, task: r.task, result });
    if (st.history.length > HISTORY) st.history.shift();
  }
  newRound(st, host);
}

function act(st, pid, a, ctx = {}) {
  const host = ctx.host;
  if (st.over) return { error: 'Игра окончена' };
  const r = st.round;
  switch (a.type) {
    case 'spin': {
      if (!canSpin(st, pid, host)) return { error: 'Сейчас крутите не вы' };
      const others = st.order.filter((id) => id !== pid);
      if (!others.length) return { error: 'Не с кем играть' };
      const target = pickTarget(st, others);
      st.round = { by: pid, target, kind: null, task: null, fromDeck: false, from: null };
      st.recent.push(target);
      if (st.recent.length > 2) st.recent.shift();
      st.spinSeq++;
      st.turns = 4 + Math.floor(st.rnd() * 3);
      st.jitter = Math.round((st.rnd() * 0.7 - 0.35) * 100) / 100;
      st.phase = 'choose';
      return { ok: true, sound: 'spin' };
    }
    case 'choose': {
      if (st.phase !== 'choose' || pid !== r.target) return { error: 'Выбирает тот, на кого выпало' };
      if (a.kind !== 'truth' && a.kind !== 'dare') return { error: 'Правда или действие?' };
      r.kind = a.kind;
      if (st.rules.tasks === 'deck' || st.order.length < 2) {
        r.task = drawTask(st, a.kind); r.fromDeck = true;
        st.phase = 'doing';
      } else st.phase = 'task';
      return { ok: true, sound: 'play' };
    }
    case 'task': {
      // задание придумывают сами игроки: любой, кроме того, на кого выпало; чьё отправлено первым — то и в силе
      if (st.phase !== 'task') return { error: 'Задание уже есть' };
      if (pid === r.target || !st.order.includes(pid)) return { error: 'Себе задание не придумывают' };
      if (a.random) { r.task = drawTask(st, r.kind); r.fromDeck = true; } else {
        const text = String(a.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
        if (!text) return { error: 'Напишите задание' };
        r.task = text; r.fromDeck = false; r.from = pid;
      }
      st.phase = 'doing';
      return { ok: true, sound: 'turn' };
    }
    case 'reroll': { // «Предлагает сайт»: игроки могут попросить другое задание (кроме того, кому оно)
      if (st.phase !== 'doing' || !r.fromDeck || pid === r.target || !st.order.includes(pid)) return { error: 'Нельзя' };
      r.task = drawTask(st, r.kind);
      return { ok: true, sound: 'turn' };
    }
    case 'done':
    case 'refuse': {
      if (st.phase !== 'doing') return { error: 'Сейчас нечего засчитывать' };
      // выполнение засчитывают сам игрок, тот, кто дал задание, или создатель; отказаться может только сам игрок
      if (a.type === 'refuse' ? pid !== r.target : ![r.target, r.by, r.from, host].includes(pid)) return { error: 'Нельзя' };
      finishRound(st, a.type, host);
      return { ok: true, sound: a.type === 'done' ? 'win' : 'penalty' };
    }
    case 'skip': {
      if (pid !== host) return { error: 'Только создатель' };
      if (st.phase === 'spin') { // крутящий пропал — передаём ход дальше
        if (st.rules.spinner === 'anyone' || st.rules.spinner === 'host') return { error: 'Крутить может любой' };
        const i = st.order.indexOf(st.spinner);
        st.spinner = st.order[(i + 1) % st.order.length];
        return { ok: true };
      }
      if (r) {
        st.history.push({ by: r.by, target: r.target, kind: r.kind, task: r.task, result: 'skip' });
        if (st.history.length > HISTORY) st.history.shift();
      }
      newRound(st, host);
      return { ok: true };
    }
    case 'finish': {
      if (pid !== host) return { error: 'Только создатель' };
      st.over = true;
      return { ok: true, sound: 'win' };
    }
    default:
      return { error: 'Неизвестное действие' };
  }
}

function view(st, pid, ctx = {}) {
  const host = ctx.host;
  const r = st.round;
  const spinner = st.rules.spinner === 'host' ? host : st.spinner;
  return {
    phase: st.over ? 'over' : st.phase,
    order: st.order,
    spinnerMode: st.rules.spinner,
    tasksMode: st.rules.tasks,
    spinner,
    round: r ? { ...r } : null,
    spinSeq: st.spinSeq,
    turns: st.turns,
    jitter: st.jitter,
    stats: st.stats,
    history: st.history.slice(-6),
    canSpin: canSpin(st, pid, host),
    isHost: pid === host,
    over: st.over,
  };
}

// Игрок вышел: убираем его из круга; если круг был про него — начинаем новый
function removePlayer(st, pid, ctx = {}) {
  const i = st.order.indexOf(pid);
  if (i < 0) return;
  const r = st.round;
  const wasSpinner = st.spinner === pid;
  const next = st.order[(i + 1) % st.order.length];
  st.order.splice(i, 1);
  if (r && r.target === pid) {
    st.round = null; st.phase = 'spin';
    st.spinner = st.rules.spinner === 'anyone' ? null : (r.target === pid ? (st.order.includes(r.by) ? r.by : st.order[0]) : r.target);
  } else if (wasSpinner && st.phase === 'spin') st.spinner = next === pid ? st.order[0] : next;
  if (st.spinner && !st.order.includes(st.spinner)) st.spinner = st.order[0] || null;
  if (st.order.length < 2) st.over = true;
}

// Новый игрок посреди игры встаёт в круг последним
function addPlayer(st, pid) {
  if (st.order.includes(pid)) return;
  st.order.push(pid);
  st.stats[pid] = st.stats[pid] || { done: 0, refused: 0 };
}

const isOver = (st) => st.over;

module.exports = { meta, create, act, view, removePlayer, addPlayer, isOver, TASKS };
