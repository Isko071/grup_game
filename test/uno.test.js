'use strict';
const test = require('node:test');
const assert = require('node:assert');
const uno = require('../server/games/uno');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i }));
const card = (id, color, value) => ({ id, color, value });
const cur = (st) => uno._internal.currentId(st);
const ctx = { host: 'p0' };

// нейтральный стол: верх — красная 5, ходит p0, нет штрафов
function fresh(n = 3, rules = {}) {
  const st = uno.create(P(n), { stack: 'off', wild4: 'free', drawMode: 'one', ...rules });
  st.discard = [card(900, 'r', '5')];
  st.color = 'r';
  st.turn = 0; st.dir = 1; st.pending = 0; st.pendingType = null; st.drawn = null; st.challenge = null;
  return st;
}

test('колода: 108 карт, раздача по 7, первая карта не дикая', () => {
  assert.strictEqual(uno._internal.buildDeck().length, 108);
  const st = uno.create(P(4));
  for (const id of st.order) assert.strictEqual(st.hands[id].length, 7);
  assert.strictEqual(st.draw.length + st.discard.length + 28, 108);
  assert.notStrictEqual(st.discard[0].color, 'w');
});

test('нельзя ходить не в свой ход и неподходящей картой', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'b', '7'), card(2, 'r', '9')];
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 2 }).ok);
  assert.strictEqual(cur(st), 'p1');
});

test('skip пропускает, reverse меняет направление', () => {
  const st = fresh(4);
  st.hands.p0 = [card(1, 'r', 'skip'), card(2, 'r', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(cur(st), 'p2');
  st.hands.p2 = [card(3, 'r', 'rev'), card(4, 'r', '2')];
  uno.act(st, 'p2', { type: 'play', cardId: 3 });
  assert.strictEqual(cur(st), 'p1');
});

test('плюсы не суммируются (stack: off): следующий берёт и пропускает', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'r', '+2'), card(2, 'r', '1')];
  st.hands.p1 = [card(3, 'r', '+2'), card(4, 'g', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 3 }).error);
  uno.act(st, 'p1', { type: 'draw' });
  assert.strictEqual(st.hands.p1.length, 4);
  assert.strictEqual(cur(st), 'p2');
});

test('stack: same — только одинаковые плюсы', () => {
  const st = fresh(3, { stack: 'same' });
  st.hands.p0 = [card(1, 'r', '+2'), card(2, 'r', '1')];
  st.hands.p1 = [card(3, 'w', '+4'), card(5, 'g', '+2'), card(4, 'g', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 3, color: 'g' }).error); // +4 на +2 нельзя
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 5 }).ok);
  assert.strictEqual(st.pending, 4);
});

test('stack: all — любые плюсы на любые, штраф суммируется', () => {
  const st = fresh(3, { stack: 'all' });
  st.hands.p0 = [card(1, 'r', '+2'), card(2, 'r', '1')];
  st.hands.p1 = [card(3, 'w', '+4'), card(4, 'g', '1')];
  st.hands.p2 = [card(5, 'g', '+2'), card(6, 'g', '2')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 3, color: 'b' }).ok); // +4 на +2
  assert.strictEqual(st.pending, 6);
  assert.ok(uno.act(st, 'p2', { type: 'play', cardId: 5 }).ok); // +2 на +4
  assert.strictEqual(st.pending, 8);
  const before = st.hands.p0.length;
  uno.act(st, 'p0', { type: 'draw' });
  assert.strictEqual(st.hands.p0.length, before + 8);
});

test('при штрафе нельзя ходить обычной картой', () => {
  const st = fresh(3, { stack: 'all' });
  st.hands.p0 = [card(1, 'r', '+2'), card(2, 'r', '1')];
  st.hands.p1 = [card(3, 'r', '3'), card(4, 'g', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.deepStrictEqual(uno.view(st, 'p1').playable, []);
});

test('«+4»: строгий режим запрещает при нужном цвете', () => {
  const st = fresh(3, { wild4: 'strict' });
  st.hands.p0 = [card(1, 'w', '+4'), card(2, 'r', '1')];
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'g' }).error);
  assert.deepStrictEqual(uno.view(st, 'p0').playable, [2]);
  st.hands.p0 = [card(1, 'w', '+4'), card(3, 'b', '1')];
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'g' }).ok);
});

test('оспаривание «+4»: нечестно сыграли — штраф получает игравший', () => {
  const st = fresh(3, { wild4: 'challenge' });
  st.hands.p0 = [card(1, 'w', '+4'), card(2, 'r', '1'), card(7, 'g', '3')]; // красная есть — играть нельзя
  uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'g' });
  assert.deepStrictEqual(uno.view(st, 'p1').challenge, { by: 'p0', target: 'p1' });
  const mine = st.hands.p1.length;
  assert.ok(uno.act(st, 'p2', { type: 'challenge' }).error); // оспаривает только следующий
  assert.ok(uno.act(st, 'p1', { type: 'challenge' }).ok);
  assert.strictEqual(st.hands.p0.length, 2 + 4); // p0 берёт 4
  assert.strictEqual(st.hands.p1.length, mine); // p1 ничего не берёт
  assert.strictEqual(cur(st), 'p1'); // и ходит сам
  assert.strictEqual(st.pending, 0);
});

test('оспаривание «+4»: сыграли честно — оспоривший берёт 6', () => {
  const st = fresh(3, { wild4: 'challenge' });
  st.hands.p0 = [card(1, 'w', '+4'), card(2, 'b', '1')]; // красных нет — всё честно
  uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'g' });
  const mine = st.hands.p1.length;
  uno.act(st, 'p1', { type: 'challenge' });
  assert.strictEqual(st.hands.p1.length, mine + 6);
  assert.strictEqual(cur(st), 'p2');
});

test('«+4»: принять — обычный штраф 4; оспорить стопку нельзя', () => {
  const st = fresh(3, { wild4: 'challenge', stack: 'all' });
  st.hands.p0 = [card(1, 'w', '+4'), card(2, 'b', '1')];
  st.hands.p1 = [card(3, 'w', '+4'), card(4, 'b', '2')];
  uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'g' });
  uno.act(st, 'p1', { type: 'play', cardId: 3, color: 'y' }); // ответил плюсом — это принятие
  assert.strictEqual(st.challenge, null);
  assert.strictEqual(st.pending, 8);
  const st2 = fresh(3, { wild4: 'challenge' });
  st2.hands.p0 = [card(1, 'w', '+4'), card(2, 'b', '1')];
  uno.act(st2, 'p0', { type: 'play', cardId: 1, color: 'g' });
  const before = st2.hands.p1.length;
  uno.act(st2, 'p1', { type: 'draw' });
  assert.strictEqual(st2.hands.p1.length, before + 4);
});

test('дикая карта требует цвет', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'w', 'wild'), card(2, 'r', '1')];
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'y' }).ok);
  assert.strictEqual(st.color, 'y');
});

test('нечем ходить (drawMode: one): взял подходящую — сыграть или пас', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'b', '3')];
  st.draw = [card(50, 'b', '3'), card(51, 'r', '8')];
  uno.act(st, 'p0', { type: 'draw' });
  assert.strictEqual(st.drawn, 51);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'pass' }).ok);
  assert.strictEqual(cur(st), 'p1');
});

test('нечем ходить (drawMode: until): берёт, пока не выпадет подходящая', () => {
  const st = fresh(3, { drawMode: 'until' });
  st.hands.p0 = [card(1, 'b', '3')];
  st.draw = [card(52, 'r', '8'), card(51, 'g', '2'), card(50, 'b', '4'), card(49, 'y', '9')]; // pop(): 49, 50, 51, 52
  uno.act(st, 'p0', { type: 'draw' });
  assert.strictEqual(st.hands.p0.length, 1 + 4); // 9, 4, 2 неподходящие, 8 красная — подходит
  assert.strictEqual(st.drawn, 52);
  assert.strictEqual(cur(st), 'p0'); // выбор: сыграть или пас
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 52 }).ok);
});

test('«УНО!» у всех: поймать забывшего (+2) и защитить себя', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'r', '1'), card(2, 'r', '2')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(st.catchable, 'p0');
  assert.ok(uno.act(st, 'p1', { type: 'uno' }).ok); // кнопка у соперника = поймать
  assert.strictEqual(st.hands.p0.length, 3);
  assert.ok(uno.act(st, 'p2', { type: 'uno' }).error); // ловить уже некого, самому рано

  const safe = fresh();
  safe.hands.p0 = [card(1, 'r', '1'), card(2, 'r', '2')];
  uno.act(safe, 'p0', { type: 'uno' }); // заранее
  uno.act(safe, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(safe.catchable, null);

  const late = fresh();
  late.hands.p0 = [card(1, 'r', '1'), card(2, 'r', '2')];
  uno.act(late, 'p0', { type: 'play', cardId: 1 });
  assert.ok(uno.act(late, 'p0', { type: 'uno' }).ok); // успел сам
  assert.ok(uno.act(late, 'p1', { type: 'uno' }).error); // ловить поздно
});

test('победитель выходит, остальные играют; игра идёт, пока не выиграет половина', () => {
  const st = fresh(4); // цель: 2 победителя
  st.hands.p0 = [card(1, 'r', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.deepStrictEqual(st.finished, ['p0']);
  assert.strictEqual(st.over, false);
  assert.strictEqual(cur(st), 'p1');
  assert.ok(uno.act(st, 'p0', { type: 'draw' }).error); // вышедший не ходит
  assert.strictEqual(uno.view(st, 'p0', ctx).canFinish, true);
  // ход обходит вышедшего
  st.turn = 3;
  st.hands.p3 = [card(9, 'r', '2'), card(10, 'r', '3')];
  uno.act(st, 'p3', { type: 'play', cardId: 9 });
  assert.strictEqual(cur(st), 'p1');
  // второй победитель — игра окончена
  st.turn = 2; st.hands.p2 = [card(11, 'r', '4')];
  st.discard.push(card(901, 'r', '7')); st.color = 'r';
  uno.act(st, 'p2', { type: 'play', cardId: 11 });
  assert.strictEqual(st.over, true);
  assert.deepStrictEqual(st.places.slice(0, 2), ['p0', 'p2']);
  assert.strictEqual(st.places.length, 4);
});

test('хост может закончить игру после первого победителя', () => {
  const st = fresh(5);
  assert.ok(uno.act(st, 'p0', { type: 'finish' }, ctx).error); // никто ещё не выиграл
  st.hands.p0 = [card(1, 'r', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.ok(uno.act(st, 'p1', { type: 'finish' }, ctx).error); // не хост
  assert.ok(uno.act(st, 'p1', { type: 'finish' }, { host: 'p1' }).ok);
  assert.strictEqual(st.over, true);
});

test('двое: победа первого заканчивает игру', () => {
  const st = fresh(2);
  st.hands.p0 = [card(1, 'r', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(st.over, true);
  assert.strictEqual(st.winner === undefined ? uno.view(st, 'p1').winner : st.winner, 'p0');
});

test('выход игрока: карты в колоду, ход переходит, остался один — конец', () => {
  const st = fresh(3);
  const drawBefore = st.draw.length;
  const n = st.hands.p0.length;
  uno.removePlayer(st, 'p0'); // сейчас его ход
  assert.strictEqual(cur(st), 'p1');
  assert.strictEqual(st.draw.length, drawBefore + n);
  uno.removePlayer(st, 'p2');
  assert.strictEqual(st.over, true);
  assert.strictEqual(st.places[0], 'p1');
});

test('вид игрока не раскрывает чужие карты', () => {
  const st = fresh();
  const v = uno.view(st, 'p0', ctx);
  assert.strictEqual(v.hand.length, 7);
  assert.strictEqual(v.counts.p1, 7);
  assert.ok(!('hands' in v));
});

test('автоход по таймеру: взять карту, затем пас', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'b', '3')];
  st.draw = [card(51, 'r', '8')];
  assert.deepStrictEqual(uno.timeoutMove(st, 'p0'), { type: 'draw' });
  uno.act(st, 'p0', uno.timeoutMove(st, 'p0'));
  assert.deepStrictEqual(uno.timeoutMove(st, 'p0'), { type: 'pass' });
  assert.strictEqual(uno.timeoutMove(st, 'p1'), null);
});

test('случайные партии доигрываются до конца при любых правилах', () => {
  const variants = [
    { stack: 'all', wild4: 'challenge', drawMode: 'until' },
    { stack: 'same', wild4: 'strict', drawMode: 'one' },
    { stack: 'off', wild4: 'free', drawMode: 'one' },
  ];
  for (const rules of variants) {
    for (let g = 0; g < 15; g++) {
      const n = 2 + (g % 7);
      const st = uno.create(P(n), rules);
      let guard = 0;
      while (!st.over && guard++ < 6000) {
        const pid = cur(st);
        // ответ на «+4»: иногда оспаривают
        if (st.challenge && st.challenge.target === pid && Math.random() < 0.5) { assert.ok(!uno.act(st, pid, { type: 'challenge' }).error); continue; }
        const v = uno.view(st, pid);
        let a;
        if (v.playable.length) {
          const c = v.hand.find((x) => x.id === v.playable[0]);
          a = { type: 'play', cardId: c.id, color: 'rgby'[Math.floor(Math.random() * 4)] };
        } else a = v.canPass ? { type: 'pass' } : { type: 'draw' };
        const r = uno.act(st, pid, a);
        assert.ok(!r.error, JSON.stringify(a) + ' ' + r.error);
      }
      assert.ok(st.over, `партия не завершилась (n=${n}, ${JSON.stringify(rules)})`);
      assert.strictEqual(st.places.length, n);
    }
  }
});
