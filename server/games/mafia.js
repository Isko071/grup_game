'use strict';
// Логика МАФИИ. Два режима:
//  online — сайт ведёт игру сам (ночные действия, голосование, победа);
//  live   — ведёт живой ведущий (хост не играет): сайт раздаёт роли, ведущий видит все роли и отмечает выбывших.
// Состояние меняется на месте; игрокам уходит только view().

const ROLES = {
  mafia: { title: 'Мафия', team: 'mafia', text: 'Каждую ночь мафия вместе выбирает жертву. Днём притворяйтесь мирными.' },
  civil: { title: 'Мирный житель', team: 'town', text: 'Ночью вы спите. Днём ищите мафию и голосуйте.' },
  doctor: { title: 'Доктор', team: 'town', text: 'Каждую ночь лечите одного игрока: если мафия или маньяк выберут его, он выживет. Нельзя лечить одного и того же две ночи подряд.' },
  commissar: { title: 'Комиссар', team: 'town', text: 'Каждую ночь проверяйте одного игрока — узнаете, мафия он или нет.' },
  maniac: { title: 'Маньяк', team: 'maniac', text: 'Играете сам за себя. Каждую ночь убиваете одного игрока. Победа — остаться последним.' },
};
const NIGHT_KIND = { mafia: 'kill', doctor: 'heal', commissar: 'check', maniac: 'maniac' };

const meta = {
  id: 'mafia',
  title: 'Мафия',
  minPlayers: 5,
  maxPlayers: 15,
  supportsBots: false,
  defaultRules: { mode: 'online', maniac: true },
  rulesSchema: [
    {
      key: 'mode', label: 'Режим', type: 'select',
      choices: [{ value: 'online', label: 'Онлайн (сайт ведёт игру)' }, { value: 'live', label: 'С живым ведущим (хост)' }],
    },
    { key: 'maniac', label: 'Маньяк (если игроков 7 и больше)', type: 'bool' },
  ],
};

function validate(players, rules) {
  const live = rules.mode === 'live';
  if (live) {
    if (players.some((p) => p.bot)) return 'В режиме с живым ведущим боты не нужны';
    if (players.length - 1 < 5) return 'С живым ведущим нужно минимум 6 человек (ведущий не играет)';
  }
  return null;
}

function shuffle(arr, rnd = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function create(players, rules = {}, rnd = Math.random, ctx = {}) {
  const r = { ...meta.defaultRules, ...rules };
  const live = r.mode === 'live';
  const hostId = ctx.hostId || null;
  const order = players.filter((p) => !(live && p.id === hostId)).map((p) => p.id);
  const n = order.length;
  const mafiaCount = Math.max(1, Math.floor(n / 3));
  const list = Array(mafiaCount).fill('mafia');
  list.push('doctor', 'commissar');
  if (r.maniac && n >= 7) list.push('maniac');
  while (list.length < n) list.push('civil');
  shuffle(list, rnd);
  const st = {
    mode: live ? 'live' : 'online',
    rules: r,
    hostId,
    order,
    roles: Object.fromEntries(order.map((id, i) => [id, list[i]])),
    alive: Object.fromEntries(order.map((id) => [id, true])),
    phase: 'night', // night | day | over
    round: 1,
    night: { votes: {}, done: {}, doctor: null, commissar: null, maniac: null },
    lastHeal: null,
    checks: [], // {id, mafia}
    votes: {}, // днём: голосующий -> цель | null
    winner: null, // town | mafia | maniac
    log: [],
    rnd,
  };
  say(st, live ? 'Роли розданы. Игру ведёт ведущий' : 'Наступила ночь 1. Город засыпает');
  return st;
}

function say(st, t) { st.log.push(t); if (st.log.length > 40) st.log.shift(); }
const nm = (st, id) => (st.names && st.names[id]) || id;
const hostOf = (st, ctx) => (st.mode === 'live' ? st.hostId : ((ctx && ctx.host) || st.hostId));
const aliveIds = (st) => st.order.filter((id) => st.alive[id]);
const isMafia = (st, id) => st.roles[id] === 'mafia';

function nightTargets(st, pid) {
  const role = st.roles[pid];
  const alive = aliveIds(st);
  if (role === 'mafia') return alive.filter((id) => !isMafia(st, id));
  if (role === 'doctor') return alive.filter((id) => id !== st.lastHeal);
  if (role === 'commissar') return alive.filter((id) => id !== pid && !st.checks.some((c) => c.id === id));
  if (role === 'maniac') return alive.filter((id) => id !== pid);
  return [];
}

function nightComplete(st) {
  return aliveIds(st).every((id) => !NIGHT_KIND[st.roles[id]] || st.night.done[id]);
}

function act(st, pid, a, ctx) {
  if (st.phase === 'over') return { error: 'Игра окончена' };
  const host = hostOf(st, ctx);

  // ---- режим с живым ведущим ----
  if (st.mode === 'live') {
    if (pid !== st.hostId) return { error: 'Игру ведёт ведущий' };
    if (a.type === 'toggleAlive') {
      if (!(a.id in st.alive)) return { error: 'Нет такого игрока' };
      st.alive[a.id] = !st.alive[a.id];
      say(st, st.alive[a.id] ? `${nm(st, a.id)} возвращается в игру` : `${nm(st, a.id)} выбывает (${ROLES[st.roles[a.id]].title})`);
      return { ok: true, sound: st.alive[a.id] ? null : 'penalty' };
    }
    if (a.type === 'setPhase') {
      if (!['night', 'day'].includes(a.phase)) return { error: 'Неизвестная фаза' };
      st.phase = a.phase;
      if (a.phase === 'night') st.round += 1;
      say(st, a.phase === 'night' ? 'Наступает ночь' : 'Наступает день');
      return { ok: true, sound: 'turn' };
    }
    if (a.type === 'endGame') {
      st.phase = 'over';
      say(st, 'Игра окончена');
      return { ok: true, sound: 'win' };
    }
    return { error: 'Неизвестное действие' };
  }

  // ---- онлайн ----
  if (a.type === 'endNight') {
    if (pid !== host) return { error: 'Только хост' };
    if (st.phase !== 'night') return { error: 'Сейчас не ночь' };
    return resolveNight(st);
  }
  if (a.type === 'endDay') {
    if (pid !== host) return { error: 'Только хост' };
    if (st.phase !== 'day') return { error: 'Сейчас не день' };
    return resolveDay(st);
  }
  if (!(pid in st.alive) || !st.alive[pid]) return { error: 'Вы выбыли из игры' };

  if (a.type === 'night') {
    if (st.phase !== 'night') return { error: 'Сейчас не ночь' };
    const role = st.roles[pid];
    if (!NIGHT_KIND[role]) return { error: 'Ночью вы спите' };
    if (!nightTargets(st, pid).includes(a.target)) return { error: 'Нельзя выбрать этого игрока' };
    if (role === 'mafia') st.night.votes[pid] = a.target;
    else if (st.night.done[pid]) return { error: 'Вы уже сделали выбор' };
    else st.night[role] = a.target;
    st.night.done[pid] = true;
    if (role === 'commissar') st.checks.push({ id: a.target, mafia: isMafia(st, a.target) });
    if (nightComplete(st)) return resolveNight(st);
    return { ok: true };
  }

  if (a.type === 'vote') {
    if (st.phase !== 'day') return { error: 'Голосуем только днём' };
    if (a.target === null) { st.votes[pid] = null; return { ok: true }; }
    if (!st.alive[a.target] || a.target === pid) return { error: 'Нельзя голосовать за этого игрока' };
    st.votes[pid] = a.target;
    return { ok: true };
  }

  return { error: 'Неизвестное действие' };
}

function mostVoted(counts, rnd) {
  const max = Math.max(0, ...Object.values(counts));
  if (!max) return null;
  const top = Object.keys(counts).filter((k) => counts[k] === max);
  return top[Math.floor(rnd() * top.length)];
}

function resolveNight(st) {
  const n = st.night;
  const counts = {};
  for (const t of Object.values(n.votes)) counts[t] = (counts[t] || 0) + 1;
  const mafiaTarget = mostVoted(counts, st.rnd);
  const targets = new Set([mafiaTarget, n.maniac].filter(Boolean));
  if (n.doctor) targets.delete(n.doctor);
  const killed = [...targets].filter((id) => st.alive[id]);
  for (const id of killed) st.alive[id] = false;
  st.lastHeal = n.doctor || null;
  say(st, killed.length
    ? `Утро ${st.round}. Ночью погиб${killed.length > 1 ? 'ли' : ''}: ${killed.map((id) => `${nm(st, id)} (${ROLES[st.roles[id]].title})`).join(', ')}`
    : `Утро ${st.round}. Ночь прошла спокойно`);
  st.night = { votes: {}, done: {}, doctor: null, commissar: null, maniac: null };
  st.votes = {};
  st.phase = 'day';
  return finish(st, killed.length ? 'penalty' : 'turn');
}

function resolveDay(st) {
  const counts = {};
  for (const [voter, t] of Object.entries(st.votes)) if (t && st.alive[voter] && st.alive[t]) counts[t] = (counts[t] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max);
  let sound = 'turn';
  if (max > 0 && top.length === 1) {
    st.alive[top[0]] = false;
    say(st, `Голосование: ${nm(st, top[0])} (${ROLES[st.roles[top[0]]].title}) покидает игру — голосов: ${max}`);
    sound = 'penalty';
  } else say(st, max ? 'Голоса разделились — никто не уходит' : 'Никто не проголосовал — никто не уходит');
  st.votes = {};
  st.round += 1;
  st.phase = 'night';
  if (!checkWin(st)) say(st, `Наступила ночь ${st.round}`);
  return finish(st, sound);
}

function finish(st, sound) {
  checkWin(st);
  return { ok: true, sound: st.phase === 'over' ? 'win' : sound };
}

function checkWin(st) {
  const alive = aliveIds(st);
  const M = alive.filter((id) => st.roles[id] === 'mafia').length;
  const K = alive.filter((id) => st.roles[id] === 'maniac').length;
  const O = alive.length - M - K;
  let w = null;
  if (M === 0 && K === 0) w = 'town';
  else if (M === 0 && K === 1 && O <= 1) w = 'maniac';
  else if (M > 0 && M >= O + K) w = 'mafia';
  if (!w) return false;
  st.winner = w;
  st.phase = 'over';
  say(st, { town: 'Победа мирных жителей!', mafia: 'Победа мафии!', maniac: 'Победил маньяк!' }[w]);
  return true;
}

function view(st, pid, ctx) {
  const host = hostOf(st, ctx);
  const live = st.mode === 'live';
  const isMod = live && pid === st.hostId;
  const over = st.phase === 'over';
  const inGame = pid in st.roles;
  const role = inGame ? st.roles[pid] : null;
  const v = {
    game: 'mafia',
    mode: st.mode,
    phase: st.phase,
    round: st.round,
    order: st.order,
    alive: st.alive,
    log: st.log.slice(-12),
    winner: st.winner,
    over,
    isHost: pid === host,
    isMod,
    role,
    roleInfo: role ? ROLES[role] : null,
    team: role === 'mafia' ? st.order.filter((id) => isMafia(st, id)) : [],
    // роли выбывших раскрываются всем; полный список — ведущему и после конца
    roles: over || isMod ? st.roles : Object.fromEntries(st.order.filter((id) => !st.alive[id]).map((id) => [id, st.roles[id]])),
    roleTitles: Object.fromEntries(Object.entries(ROLES).map(([k, x]) => [k, x.title])),
  };
  if (live) return v;

  const me = inGame && st.alive[pid];
  v.votes = st.phase === 'day' ? st.votes : {};
  if (me && st.phase === 'night' && NIGHT_KIND[role]) {
    v.night = {
      kind: NIGHT_KIND[role],
      targets: nightTargets(st, pid),
      done: !!st.night.done[pid],
      choice: role === 'mafia' ? st.night.votes[pid] || null : st.night[role],
    };
  }
  if (me && role === 'mafia' && st.phase === 'night') v.mafiaVotes = st.night.votes;
  if (role === 'commissar') v.checks = st.checks;
  v.canEndNight = pid === host && st.phase === 'night';
  v.canEndDay = pid === host && st.phase === 'day';
  return v;
}

// Кто и куда может писать в чат сейчас: null — нельзя
function chatPolicy(st, pid) {
  if (st.phase === 'over') return { channel: 'all' };
  if (st.mode === 'live') return pid === st.hostId || st.alive[pid] ? { channel: 'all' } : null;
  if (!st.alive[pid]) return null;
  if (st.phase === 'night') {
    if (st.roles[pid] !== 'mafia') return null;
    return { channel: 'mafia', to: st.order.filter((id) => isMafia(st, id)) };
  }
  return { channel: 'all' };
}

// Игрок вышел из партии: считается выбывшим (роль раскрывается), фазы не зависают
function removePlayer(st, pid) {
  if (st.phase === 'over') return;
  if (st.mode === 'live' && pid === st.hostId) {
    st.phase = 'over';
    say(st, 'Ведущий вышел — игра окончена');
    return;
  }
  if (!st.alive[pid]) return;
  st.alive[pid] = false;
  delete st.night.votes[pid];
  delete st.night.done[pid];
  delete st.votes[pid];
  say(st, `${nm(st, pid)} (${ROLES[st.roles[pid]].title}) вышел из игры`);
  if (st.mode === 'live') return; // живой ведущий сам следит за ходом игры
  if (checkWin(st)) return;
  if (st.phase === 'night' && nightComplete(st)) resolveNight(st);
}

module.exports = {
  meta, create, act, view, validate, chatPolicy, removePlayer,
  isOver: (st) => st.phase === 'over',
  _internal: { checkWin, nightTargets, ROLES },
};
