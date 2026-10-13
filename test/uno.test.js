'use strict';
const test = require('node:test');
const assert = require('node:assert');
const uno = require('../server/games/uno');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i }));
const card = (id, color, value) => ({ id, color, value });

function fresh(n = 3, rules = {}) {
  const st = uno.create(P(n), rules);
  // нейтральный стол: верх — красная 5, ходит p0, нет штрафов
  st.discard = [card(900, 'r', '5')];
  st.color = 'r';
  st.turn = 0; st.dir = 1; st.pending = 0; st.pendingType = null; st.drawn = null;
  return st;
}

test('колода: 108 карт, раздача по 7', () => {
  assert.strictEqual(uno._internal.buildDeck().length, 108);
  const st = uno.create(P(4));
  for (const id of st.order) assert.strictEqual(st.hands[id].length, 7);
  assert.strictEqual(st.draw.length + st.discard.length + 28, 108);
  assert.notStrictEqual(st.discard[0].color, 'w');
});

test('нельзя сыграть чужой ход и неподходящую карту', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'b', '7'), card(2, 'r', '9')];
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 2 }).ok);
  assert.strictEqual(uno._internal.currentId(st), 'p1');
});

test('skip пропускает, reverse меняет направление', () => {
  const st = fresh(4);
  st.hands.p0 = [card(1, 'r', 'skip'), card(2, 'r', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(uno._internal.currentId(st), 'p2');
  st.hands.p2 = [card(3, 'r', 'rev'), card(4, 'r', '2')];
  uno.act(st, 'p2', { type: 'play', cardId: 3 });
  assert.strictEqual(uno._internal.currentId(st), 'p1');
});

test('+2 без стаканья: следующий берёт 2 и пропускает', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'r', '+2'), card(2, 'r', '1')];
  st.hands.p1 = [card(3, 'r', '+2'), card(4, 'g', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 3 }).error);
  uno.act(st, 'p1', { type: 'draw' });
  assert.strictEqual(st.hands.p1.length, 4);
  assert.strictEqual(uno._internal.currentId(st), 'p2');
});

test('+2 на +2 при включённом правиле копит штраф', () => {
  const st = fresh(3, { stackPlus2: true });
  st.hands.p0 = [card(1, 'r', '+2'), card(2, 'r', '1')];
  st.hands.p1 = [card(3, 'g', '+2'), card(4, 'g', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.ok(uno.act(st, 'p1', { type: 'play', cardId: 3 }).ok);
  assert.strictEqual(st.pending, 4);
  const before = st.hands.p2.length;
  uno.act(st, 'p2', { type: 'draw' });
  assert.strictEqual(st.hands.p2.length, before + 4);
});

test('+4 на +4 только при включённом правиле', () => {
  const off = fresh(3, { strictWild4: false });
  off.hands.p0 = [card(1, 'w', '+4'), card(2, 'r', '1')];
  off.hands.p1 = [card(3, 'w', '+4'), card(4, 'r', '1')];
  uno.act(off, 'p0', { type: 'play', cardId: 1, color: 'g' });
  assert.ok(uno.act(off, 'p1', { type: 'play', cardId: 3, color: 'g' }).error);
  const on = fresh(3, { stackPlus4: true, strictWild4: false });
  on.hands.p0 = [card(1, 'w', '+4'), card(2, 'r', '1')];
  on.hands.p1 = [card(3, 'w', '+4'), card(4, 'r', '1')];
  uno.act(on, 'p0', { type: 'play', cardId: 1, color: 'g' });
  assert.ok(uno.act(on, 'p1', { type: 'play', cardId: 3, color: 'b' }).ok);
  assert.strictEqual(on.pending, 8);
  assert.strictEqual(on.color, 'b');
});

test('дикая карта требует цвет', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'w', 'wild'), card(2, 'r', '1')];
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'y' }).ok);
  assert.strictEqual(st.color, 'y');
});

test('взятая играбельная карта: можно сыграть или пасовать', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'b', '3')];
  st.draw = [card(50, 'b', '3'), card(51, 'r', '8')]; // pop() берёт последнюю
  uno.act(st, 'p0', { type: 'draw' });
  assert.strictEqual(st.drawn, 51);
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1 }).error);
  assert.ok(uno.act(st, 'p0', { type: 'pass' }).ok);
  assert.strictEqual(uno._internal.currentId(st), 'p1');
});

test('«УНО!»: поймать без заявки — +2 карты', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'r', '1'), card(2, 'r', '2')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(st.catchable, 'p0');
  uno.act(st, 'p1', { type: 'catch' });
  assert.strictEqual(st.hands.p0.length, 3);
});

test('«УНО!» заранее защищает от ловли', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'r', '1'), card(2, 'r', '2')];
  uno.act(st, 'p0', { type: 'uno' });
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(st.catchable, null);
});

test('победа при пустой руке', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'r', '1')];
  uno.act(st, 'p0', { type: 'play', cardId: 1 });
  assert.strictEqual(st.winner, 'p0');
  assert.ok(uno.act(st, 'p1', { type: 'draw' }).error);
});

test('вид игрока не раскрывает чужие карты', () => {
  const st = fresh();
  const v = uno.view(st, 'p0');
  assert.strictEqual(v.hand.length, 7);
  assert.strictEqual(v.counts.p1, 7);
  assert.ok(!('hands' in v));
});

test('боты доигрывают партию до конца', () => {
  for (let g = 0; g < 20; g++) {
    const st = uno.create(P(4), { stackPlus2: true, stackPlus4: true });
    let guard = 0;
    while (!st.winner && guard++ < 5000) {
      const pid = uno._internal.currentId(st);
      const a = uno.botMove(st, pid);
      const r = uno.act(st, pid, a);
      assert.ok(!r.error, JSON.stringify(a) + ' ' + r.error);
    }
    assert.ok(st.winner, 'партия не завершилась');
  }
});

test('«+4» только без карты нужного цвета (строгое правило)', () => {
  const st = fresh();
  st.hands.p0 = [card(1, 'w', '+4'), card(2, 'r', '1')];
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'g' }).error);
  assert.deepStrictEqual(uno.view(st, 'p0').playable, [2]);
  st.hands.p0 = [card(1, 'w', '+4'), card(3, 'b', '1')];
  assert.ok(uno.act(st, 'p0', { type: 'play', cardId: 1, color: 'g' }).ok);
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
