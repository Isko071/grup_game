'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mafia = require('../server/games/mafia');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, bot: false }));
const ctx = { host: 'p0', hostId: 'p0' };

// Игра с заданными ролями: p0 мафия, p1 доктор, p2 комиссар, p3..: мирные
function game(roles, rules = {}) {
  const n = roles.length;
  const st = mafia.create(P(n), rules, Math.random, ctx);
  roles.forEach((r, i) => { st.roles['p' + i] = r; });
  return st;
}
const night = (st, pid, target) => mafia.act(st, pid, { type: 'night', target }, ctx);

test('раздача ролей по умолчанию: мафия — каждый третий, доктор, комиссар, маньяка нет', () => {
  const count = (st) => Object.values(st.roles).reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {});
  const c4 = count(mafia.create(P(4), {}, Math.random, ctx));
  assert.deepStrictEqual([c4.mafia, c4.doctor, c4.commissar, c4.civil, c4.maniac], [1, 1, 1, 1, undefined]);
  const c9 = count(mafia.create(P(9), {}, Math.random, ctx));
  assert.deepStrictEqual([c9.mafia, c9.maniac, c9.civil], [3, undefined, 4]);
});

test('создатель сам задаёт состав: число мафий, доктор, комиссар, маньяк', () => {
  const count = (st) => Object.values(st.roles).reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {});
  const c = count(mafia.create(P(8), { mafiaCount: 2, doctor: false, commissar: true, maniac: true }, Math.random, ctx));
  assert.deepStrictEqual([c.mafia, c.doctor, c.commissar, c.maniac, c.civil], [2, undefined, 1, 1, 4]);
  const only = count(mafia.create(P(5), { mafiaCount: 1, doctor: false, commissar: false }, Math.random, ctx));
  assert.deepStrictEqual([only.mafia, only.civil], [1, 4]);
});

test('онлайн от 4 игроков; нечестный состав не даёт начать', () => {
  assert.strictEqual(mafia.meta.minPlayers, 4);
  assert.strictEqual(mafia.validate(P(4), {}), null);
  assert.ok(mafia.validate(P(3), {}));
  assert.ok(mafia.validate(P(4), { mafiaCount: 2 })); // 2 мафии из 4 — половина
  assert.strictEqual(mafia.validate(P(5), { mafiaCount: 2 }), null);
  assert.strictEqual(mafia.validate(P(4), { mafiaCount: 1, doctor: true, commissar: true, maniac: true }), null); // все роли, мирных нет — можно
  assert.ok(mafia.preview(P(4), {}).ok);
  assert.ok(!mafia.preview(P(4), { mafiaCount: 3 }).ok);
});

test('ночь закрывается сама, когда все с ночными ролями сходили', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  assert.ok(night(st, 'p3', 'p1').error); // мирный ночью спит
  assert.ok(night(st, 'p0', 'p0').error); // мафия не бьёт своих
  assert.ok(night(st, 'p0', 'p3').ok);
  assert.strictEqual(st.phase, 'night');
  night(st, 'p1', 'p2');
  const r = night(st, 'p2', 'p0');
  assert.ok(r.ok);
  assert.strictEqual(st.phase, 'day');
  assert.strictEqual(st.alive.p3, false);
  assert.ok(st.log.at(-1).includes('p3'));
});

test('доктор спасает цель мафии, нельзя лечить одного дважды подряд', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  night(st, 'p0', 'p3'); night(st, 'p1', 'p3'); night(st, 'p2', 'p4');
  assert.strictEqual(st.alive.p3, true);
  assert.ok(st.log.at(-1).includes('спокойно'));
  mafia.act(st, 'p0', { type: 'endDay' }, ctx); // ночь 2
  assert.strictEqual(st.phase, 'night');
  assert.ok(night(st, 'p1', 'p3').error);
  assert.ok(night(st, 'p1', 'p1').ok); // себя можно
});

test('комиссар узнаёт мафию, повторно того же не проверить', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  night(st, 'p2', 'p0');
  assert.deepStrictEqual(mafia.view(st, 'p2', ctx).checks, [{ id: 'p0', mafia: true }]);
  assert.ok(!mafia.view(st, 'p3', ctx).checks);
  assert.ok(!mafia.nightTargets && !mafia._internal.nightTargets(st, 'p2').includes('p0'));
});

test('голосование: побеждает большинство, при ничьей никто не уходит', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil', 'civil', 'civil']);
  st.phase = 'day'; st.votes = {};
  for (const [v, t] of [['p1', 'p3'], ['p2', 'p3'], ['p4', 'p3'], ['p0', 'p5']]) assert.ok(mafia.act(st, v, { type: 'vote', target: t }, ctx).ok);
  assert.ok(mafia.act(st, 'p1', { type: 'vote', target: 'p1' }, ctx).error); // за себя нельзя
  mafia.act(st, 'p0', { type: 'endDay' }, ctx);
  assert.strictEqual(st.alive.p3, false);
  assert.strictEqual(st.phase, 'night');

  const tie = game(['mafia', 'doctor', 'commissar', 'civil', 'civil', 'civil', 'civil']);
  tie.phase = 'day';
  mafia.act(tie, 'p1', { type: 'vote', target: 'p3' }, ctx);
  mafia.act(tie, 'p2', { type: 'vote', target: 'p4' }, ctx);
  mafia.act(tie, 'p0', { type: 'endDay' }, ctx);
  assert.ok(Object.values(tie.alive).every(Boolean));
});

test('завершать фазы может только создатель', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  assert.ok(mafia.act(st, 'p3', { type: 'endNight' }, ctx).error);
  assert.ok(mafia.act(st, 'p0', { type: 'endNight' }, ctx).ok);
  assert.strictEqual(st.phase, 'day');
  assert.ok(mafia.act(st, 'p3', { type: 'endDay' }, ctx).error);
});

test('победа мирных и мафии, маньяка', () => {
  const town = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  town.alive.p0 = false;
  assert.ok(mafia._internal.checkWin(town));
  assert.strictEqual(town.winner, 'town');
  const bad = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  bad.alive.p3 = false; bad.alive.p4 = false; bad.alive.p1 = false;
  mafia._internal.checkWin(bad);
  assert.strictEqual(bad.winner, 'mafia'); // 1 мафия против 1 мирного
  const man = game(['maniac', 'doctor', 'commissar', 'civil', 'civil']);
  man.alive.p2 = false; man.alive.p3 = false; man.alive.p4 = false;
  mafia._internal.checkWin(man);
  assert.strictEqual(man.winner, 'maniac');
});

test('вид скрывает роли живых; роли выбывших раскрыты всем; после конца открыто всё', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  const v = mafia.view(st, 'p3', ctx);
  assert.strictEqual(v.role, 'civil');
  assert.deepStrictEqual(v.roles, {});
  assert.deepStrictEqual(mafia.view(st, 'p0', ctx).team, ['p0']);
  st.alive.p1 = false;
  assert.deepStrictEqual(mafia.view(st, 'p3', ctx).roles, { p1: 'doctor' });
  st.phase = 'over';
  assert.strictEqual(Object.keys(mafia.view(st, 'p3', ctx).roles).length, 5);
});

test('в логе гибели указана роль', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  night(st, 'p0', 'p3'); night(st, 'p1', 'p2'); night(st, 'p2', 'p0');
  assert.ok(st.log.at(-1).includes('Мирный житель'));
});

test('чат: ночью пишет только живая мафия, днём — все живые', () => {
  const st = game(['mafia', 'mafia', 'doctor', 'commissar', 'civil', 'civil']);
  assert.deepStrictEqual(mafia.chatPolicy(st, 'p0'), { channel: 'mafia', to: ['p0', 'p1'] });
  assert.strictEqual(mafia.chatPolicy(st, 'p4'), null);
  st.phase = 'day';
  assert.deepStrictEqual(mafia.chatPolicy(st, 'p4'), { channel: 'all' });
  st.alive.p4 = false;
  assert.strictEqual(mafia.chatPolicy(st, 'p4'), null);
});

test('режим с ведущим: ведущий не играет, видит роли, отмечает выбывших', () => {
  const players = P(7);
  const st = mafia.create(players, { mode: 'live' }, Math.random, ctx);
  assert.strictEqual(st.order.length, 6);
  assert.ok(!st.order.includes('p0'));
  assert.ok(mafia.view(st, 'p0', ctx).roles);
  assert.deepStrictEqual(mafia.view(st, 'p1', ctx).roles, {});
  assert.ok(mafia.act(st, 'p1', { type: 'toggleAlive', id: 'p2' }, ctx).error);
  mafia.act(st, 'p0', { type: 'toggleAlive', id: 'p2' }, ctx);
  assert.strictEqual(st.alive.p2, false);
  mafia.act(st, 'p0', { type: 'setPhase', phase: 'day' }, ctx);
  assert.strictEqual(mafia.view(st, 'p3', ctx).phase, 'day');
  mafia.act(st, 'p0', { type: 'endGame' }, ctx);
  assert.ok(mafia.isOver(st));
  assert.ok(mafia.validate(P(4), { mode: 'live' })); // 3 играющих + ведущий — мало
  assert.strictEqual(mafia.validate(P(5), { mode: 'live' }), null); // 4 играющих + ведущий
});

test('мафия без ботов', () => {
  assert.strictEqual(mafia.meta.supportsBots, false);
  assert.strictEqual(typeof mafia.botMove, 'undefined');
});

test('выход игрока: считается выбывшим, роль раскрыта, ночь не зависает', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil', 'civil']);
  night(st, 'p0', 'p3'); night(st, 'p1', 'p3'); // ждём только комиссара
  assert.strictEqual(st.phase, 'night');
  mafia.removePlayer(st, 'p2'); // комиссар вышел — ночь закрывается сама
  assert.strictEqual(st.alive.p2, false);
  assert.strictEqual(st.phase, 'day');
  assert.deepStrictEqual(mafia.view(st, 'p4', ctx).roles, { p2: 'commissar' });
  assert.ok(st.log.some((l) => l.includes('вышел из игры') && l.includes('Комиссар')));
});

test('выход последней мафии — победа мирных; выход ведущего в живом режиме — конец', () => {
  const st = game(['mafia', 'doctor', 'commissar', 'civil', 'civil']);
  mafia.removePlayer(st, 'p0');
  assert.strictEqual(st.phase, 'over');
  assert.strictEqual(st.winner, 'town');
  const live = mafia.create(P(7), { mode: 'live' }, Math.random, ctx);
  mafia.removePlayer(live, 'p3'); // обычный игрок — просто выбыл
  assert.strictEqual(live.alive.p3, false);
  assert.strictEqual(live.phase, 'night');
  mafia.removePlayer(live, 'p0'); // ведущий
  assert.strictEqual(live.phase, 'over');
});

test('партии без ботов доигрываются до конца (игроки ходят случайно)', () => {
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  for (const n of [4, 5, 6, 7, 9, 12, 15]) {
    for (let g = 0; g < 10; g++) {
      const st = mafia.create(P(n), { maniac: g % 2 === 0 }, Math.random, ctx);
      let guard = 0;
      while (st.phase !== 'over' && guard++ < 2000) {
        const alive = st.order.filter((id) => st.alive[id]);
        if (st.phase === 'night') {
          for (const id of alive) {
            const t = mafia._internal.nightTargets(st, id);
            if (t.length && st.phase === 'night') mafia.act(st, id, { type: 'night', target: rnd(t) }, ctx);
          }
          if (st.phase === 'night') assert.ok(!mafia.act(st, 'p0', { type: 'endNight' }, ctx).error);
        } else {
          for (const id of alive) mafia.act(st, id, { type: 'vote', target: rnd(alive.filter((x) => x !== id)) }, ctx);
          assert.ok(!mafia.act(st, 'p0', { type: 'endDay' }, ctx).error);
        }
      }
      assert.strictEqual(st.phase, 'over', `n=${n} не завершилась`);
    }
  }
});
