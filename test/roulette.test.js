'use strict';
const test = require('node:test');
const assert = require('node:assert');
const roulette = require('../server/games/roulette');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, bot: false }));
const ctx = { host: 'p0', hostId: 'p0' };
const act = (st, pid, a) => roulette.act(st, pid, a, ctx);

test('полный круг: крутит → выпал другой → правда/действие → задание → выполнено', () => {
  const st = roulette.create(P(4), {}, Math.random, ctx);
  const by = st.spinner;
  assert.ok(st.order.includes(by));
  const other = st.order.find((id) => id !== by);
  assert.ok(act(st, other, { type: 'spin' }).error, 'крутит только тот, чья очередь');
  assert.ok(!act(st, by, { type: 'spin' }).error);
  const target = st.round.target;
  assert.notStrictEqual(target, by, 'рулетка не выпадает на того, кто крутил');
  assert.strictEqual(st.phase, 'choose');
  assert.ok(act(st, by, { type: 'choose', kind: 'truth' }).error, 'выбирает только тот, на кого выпало');
  assert.ok(!act(st, target, { type: 'choose', kind: 'dare' }).error);
  assert.strictEqual(st.phase, 'task');
  assert.ok(act(st, by, { type: 'task', text: '   ' }).error, 'пустое задание нельзя');
  assert.ok(!act(st, by, { type: 'task', text: 'Спой песню' }).error);
  assert.strictEqual(st.round.task, 'Спой песню');
  assert.strictEqual(st.phase, 'doing');
  assert.ok(act(st, by, { type: 'refuse' }).error, 'отказаться может только сам игрок');
  assert.ok(!act(st, target, { type: 'done' }).error);
  assert.strictEqual(st.stats[target].done, 1);
  assert.strictEqual(st.phase, 'spin');
  assert.strictEqual(st.spinner, target, 'по умолчанию крутит тот, на кого выпало');
  assert.strictEqual(st.history.length, 1);
});

test('случайные задания: задание из колоды выдаётся сразу после выбора', () => {
  const st = roulette.create(P(3), { tasks: 'deck' }, Math.random, ctx);
  act(st, st.spinner, { type: 'spin' });
  act(st, st.round.target, { type: 'choose', kind: 'truth' });
  assert.strictEqual(st.phase, 'doing');
  assert.ok(roulette.TASKS.truth.includes(st.round.task));
});

test('колода не повторяется, пока не кончится', () => {
  const st = roulette.create(P(2), { tasks: 'deck' }, Math.random, ctx);
  const seen = new Set();
  for (let i = 0; i < roulette.TASKS.dare.length; i++) {
    act(st, st.spinner, { type: 'spin' });
    act(st, st.round.target, { type: 'choose', kind: 'dare' });
    seen.add(st.round.task);
    act(st, st.round.target, { type: 'refuse' });
  }
  assert.strictEqual(seen.size, roulette.TASKS.dare.length);
});

test('режимы: по кругу, любой, только создатель', () => {
  const round = roulette.create(P(4), { spinner: 'round' }, Math.random, ctx);
  const first = round.spinner;
  act(round, first, { type: 'spin' });
  act(round, round.round.target, { type: 'choose', kind: 'truth' });
  act(round, first, { type: 'task', random: true });
  act(round, round.round.target, { type: 'done' });
  assert.strictEqual(round.spinner, round.order[(round.order.indexOf(first) + 1) % 4]);

  const any = roulette.create(P(3), { spinner: 'anyone' }, Math.random, ctx);
  assert.ok(!act(any, 'p2', { type: 'spin' }).error);

  const host = roulette.create(P(3), { spinner: 'host' }, Math.random, ctx);
  assert.ok(act(host, 'p1', { type: 'spin' }).error);
  assert.ok(!act(host, 'p0', { type: 'spin' }).error);
  assert.strictEqual(roulette.view(host, 'p0', ctx).spinner, 'p0');
});

test('в большой компании одному и тому же не выпадает дважды подряд', () => {
  const st = roulette.create(P(5), { spinner: 'anyone', tasks: 'deck' }, Math.random, ctx);
  let last = null;
  for (let i = 0; i < 200; i++) {
    act(st, 'p0', { type: 'spin' });
    assert.notStrictEqual(st.round.target, last);
    last = st.round.target;
    act(st, 'p0', { type: 'skip' });
  }
});

test('создатель пропускает зависший круг; выход игрока не ломает игру; можно зайти посреди игры', () => {
  const st = roulette.create(P(3), {}, Math.random, ctx);
  const by = st.spinner;
  act(st, by, { type: 'spin' });
  const target = st.round.target;
  roulette.removePlayer(st, target);
  assert.strictEqual(st.phase, 'spin');
  assert.ok(st.order.includes(st.spinner));
  roulette.addPlayer(st, 'p9');
  assert.ok(st.order.includes('p9'));
  assert.deepStrictEqual(st.stats.p9, { done: 0, refused: 0 });
  act(st, st.spinner, { type: 'spin' });
  assert.ok(act(st, 'p1', { type: 'skip' }).error || ctx.host === 'p1');
  assert.ok(!act(st, 'p0', { type: 'skip' }).error);
  assert.strictEqual(st.phase, 'spin');
  // остался один — игра окончена
  for (const id of [...st.order].slice(1)) roulette.removePlayer(st, id);
  assert.ok(roulette.isOver(st));
});

test('создатель заканчивает игру', () => {
  const st = roulette.create(P(2), {}, Math.random, ctx);
  assert.ok(act(st, 'p1', { type: 'finish' }).error);
  act(st, 'p0', { type: 'finish' });
  assert.ok(roulette.isOver(st));
  assert.strictEqual(roulette.view(st, 'p1', ctx).phase, 'over');
});
