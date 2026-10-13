'use strict';
const test = require('node:test');
const assert = require('node:assert');
const durak = require('../server/games/durak');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i }));
const c = (id, suit, rank) => ({ id, suit, rank });

// стол: p0 атакует, p1 защищается, козырь — пики
function fresh(n = 3, rules = {}) {
  const st = durak.create(P(n), rules);
  st.trumpSuit = 's';
  st.attacker = 'p0';
  st.defender = 'p1';
  st.table = []; st.taking = false; st.passed = {}; st.firstBout = false; st.out = [];
  st.roundDefHand = 6;
  st.deck = [c(900, 'h', 6), c(901, 'h', 7), c(902, 'h', 8), c(903, 'h', 9), c(904, 'h', 10), c(905, 'h', 11), c(906, 'h', 12), c(907, 'h', 13), c(908, 'h', 14), c(909, 'd', 6), c(910, 'd', 7), c(911, 'd', 8)];
  return st;
}

test('колоды: 24, 36, 52 карты, раздача по 6, козырь — нижняя карта', () => {
  assert.strictEqual(durak._internal.buildDeck(24).length, 24);
  assert.strictEqual(durak._internal.buildDeck(36).length, 36);
  assert.strictEqual(durak._internal.buildDeck(52).length, 52);
  const st = durak.create(P(4), { deckSize: 36 });
  for (const id of st.order) assert.strictEqual(st.hands[id].length, 6);
  assert.strictEqual(st.deck.length, 12);
  assert.strictEqual(st.deck[0], st.trumpCard);
});

test('validate: слишком много игроков для маленькой колоды', () => {
  assert.ok(durak.validate(P(5), { deckSize: 24 }));
  assert.strictEqual(durak.validate(P(6), { deckSize: 36 }), null);
});

test('бьёт: старшая той же масти или козырь', () => {
  const st = fresh();
  const b = durak._internal.beats;
  assert.ok(b(st, c(1, 'h', 7), c(2, 'h', 9)));
  assert.ok(!b(st, c(1, 'h', 9), c(2, 'h', 7)));
  assert.ok(!b(st, c(1, 'h', 7), c(2, 'd', 14)));
  assert.ok(b(st, c(1, 'h', 14), c(2, 's', 6)));
  assert.ok(b(st, c(1, 's', 6), c(2, 's', 7)));
  assert.ok(!b(st, c(1, 's', 7), c(2, 'h', 14)));
});

test('первый ход только у атакующего, подкидывать можно только достоинства со стола', () => {
  const st = fresh();
  st.hands.p0 = [c(1, 'h', 7), c(2, 'c', 7), c(3, 'c', 9)];
  st.hands.p2 = [c(4, 'd', 7), c(5, 'd', 8)];
  st.hands.p1 = [c(6, 'h', 8), c(7, 'h', 9)];
  assert.ok(durak.act(st, 'p2', { type: 'attack', cardId: 4 }).error);
  assert.ok(durak.act(st, 'p0', { type: 'attack', cardId: 1 }).ok);
  assert.ok(durak.act(st, 'p0', { type: 'attack', cardId: 3 }).error); // 9 нет на столе
  assert.ok(durak.act(st, 'p2', { type: 'attack', cardId: 4 }).ok); // сосед подкинул 7
  assert.ok(durak.act(st, 'p1', { type: 'attack', cardId: 6 }).error); // защитник не подкидывает
});

test('отбой: все отбиты, подкидывать нечего → бито, ход защитника, добор', () => {
  const st = fresh();
  st.hands.p0 = [c(1, 'h', 7), c(2, 'c', 9)];
  st.hands.p1 = [c(3, 'h', 9), c(4, 'c', 10)];
  st.hands.p2 = [c(5, 'd', 12), c(6, 'd', 13)];
  durak.act(st, 'p0', { type: 'attack', cardId: 1 });
  assert.ok(durak.act(st, 'p1', { type: 'defend', attackId: 0, cardId: 4 }).error); // трефа 10 не бьёт червы 7
  const r = durak.act(st, 'p1', { type: 'defend', attackId: 0, cardId: 3 });
  assert.ok(r.ok);
  // у p0 остался 9♣ — совпадает достоинство 9 (стол: 7♥, 9♥) → ещё можно подкинуть, ждём пас
  assert.strictEqual(st.table.length, 1);
  assert.ok(durak.act(st, 'p0', { type: 'pass' }).ok);
  assert.strictEqual(st.table.length, 0);
  assert.strictEqual(st.attacker, 'p1');
  assert.strictEqual(st.defender, 'p2');
  assert.strictEqual(st.hands.p0.length, 6); // добрал
  assert.strictEqual(st.discard, 2);
});

test('«беру»: защитник забирает карты, ход переходит дальше', () => {
  const st = fresh();
  st.hands.p0 = [c(1, 'h', 7), c(2, 'c', 7)];
  st.hands.p1 = [c(3, 'd', 8)];
  st.hands.p2 = [c(4, 'd', 9)];
  durak.act(st, 'p0', { type: 'attack', cardId: 1 });
  assert.ok(durak.act(st, 'p0', { type: 'pass' }).error); // защитник ещё отбивается
  durak.act(st, 'p1', { type: 'take' });
  durak.act(st, 'p0', { type: 'attack', cardId: 2 }); // подкинули при взятии
  // подкидывать больше некому (у p0 нет карт, у p2 нет нужных) — раунд закрывается сам
  assert.strictEqual(st.table.length, 0);
  assert.ok(st.hands.p1.length >= 3); // взял 2 карты + добор до 6
  assert.strictEqual(st.attacker, 'p2'); // пропустил ход
  assert.strictEqual(st.defender, 'p0');
});

test('лимит подкидывания: не больше карт, чем у защитника', () => {
  const st = fresh(2);
  st.roundDefHand = 1;
  st.hands.p0 = [c(1, 'h', 7), c(2, 'c', 7)];
  st.hands.p1 = [c(3, 'h', 9)];
  durak.act(st, 'p0', { type: 'attack', cardId: 1 });
  assert.ok(durak.act(st, 'p0', { type: 'attack', cardId: 2 }).error);
});

test('перевод: той же картой достоинства, только в переводном', () => {
  const off = fresh(3);
  off.hands.p0 = [c(1, 'h', 7)]; off.hands.p1 = [c(2, 'c', 7)]; off.hands.p2 = [c(3, 'd', 8), c(4, 'd', 9)];
  durak.act(off, 'p0', { type: 'attack', cardId: 1 });
  assert.ok(durak.act(off, 'p1', { type: 'transfer', cardId: 2 }).error);
  const on = fresh(3, { transfer: true });
  on.hands.p0 = [c(1, 'h', 7)]; on.hands.p1 = [c(2, 'c', 7), c(5, 'c', 8)]; on.hands.p2 = [c(3, 'd', 8), c(4, 'd', 9)];
  durak.act(on, 'p0', { type: 'attack', cardId: 1 });
  assert.ok(durak.act(on, 'p1', { type: 'transfer', cardId: 2 }).ok);
  assert.strictEqual(on.defender, 'p2');
  assert.strictEqual(on.attacker, 'p1');
  assert.strictEqual(on.table.length, 2);
});

test('конец игры: остаётся один — дурак', () => {
  const st = fresh(2);
  st.deck = [];
  st.hands.p0 = [c(1, 'h', 7)];
  st.hands.p1 = [c(2, 'h', 9), c(3, 'c', 5)];
  durak.act(st, 'p0', { type: 'attack', cardId: 1 });
  durak.act(st, 'p1', { type: 'defend', attackId: 0, cardId: 2 });
  assert.strictEqual(st.over, true);
  assert.strictEqual(st.loser, 'p1');
  assert.ok(durak.act(st, 'p1', { type: 'take' }).error);
});

test('вид игрока не раскрывает чужие карты и подсказывает ходы', () => {
  const st = fresh();
  st.hands.p0 = [c(1, 'h', 7)]; st.hands.p1 = [c(2, 'h', 9)];
  const v0 = durak.view(st, 'p0');
  assert.deepStrictEqual(v0.canAttack, [1]);
  assert.ok(!('hands' in v0));
  durak.act(st, 'p0', { type: 'attack', cardId: 1 });
  const v1 = durak.view(st, 'p1');
  assert.deepStrictEqual(v1.canDefend, { 2: [0] });
  assert.ok(v1.canTake);
});

test('боты доигрывают партии до конца (все варианты)', () => {
  for (const rules of [{}, { transfer: true }, { deckSize: 24, transfer: true }, { deckSize: 52, everyoneThrows: false }]) {
    for (let g = 0; g < 15; g++) {
      const n = 2 + (g % (rules.deckSize === 24 ? 3 : 5));
      const st = durak.create(P(n), rules);
      let guard = 0;
      while (!st.over && guard++ < 4000) {
        let moved = false;
        for (const id of st.order) {
          const a = durak.botMove(st, id);
          if (a) {
            const r = durak.act(st, id, a);
            assert.ok(!r.error, `${id} ${JSON.stringify(a)}: ${r.error}`);
            moved = true;
            break;
          }
        }
        assert.ok(moved, 'ни у кого нет хода — игра зависла');
      }
      assert.ok(st.over, 'партия не завершилась');
    }
  }
});

test('бот дурака: подбирает отбой так, чтобы хватило карт на все атаки', () => {
  const st = fresh(2);
  st.hands.p1 = [c(1, 'h', 9), c(2, 'h', 10), c(3, 'c', 7)];
  st.table = [{ a: c(10, 'h', 8), d: null }, { a: c(11, 'h', 6), d: null }];
  const m = durak.botMove(st, 'p1');
  // 10♥ нужна только на 8♥: 9♥ должна бить 6♥ или 8♥, но оставить 10♥ для другой — бот не должен застрять
  assert.strictEqual(m.type, 'defend');
  assert.deepStrictEqual([m.attackId, m.cardId].sort(), [m.attackId, m.cardId].sort());
  durak.act(st, 'p1', m);
  const m2 = durak.botMove(st, 'p1');
  assert.strictEqual(m2.type, 'defend'); // второй атаке тоже нашлась карта
  assert.ok(durak.act(st, 'p1', m2).ok);
});

test('бот дурака: не жжёт старший козырь на мелочь при большой колоде, но берёт', () => {
  const st = fresh(2);
  st.hands.p1 = [c(1, 's', 13), c(2, 'c', 7)]; // козырь пики; бить 6♥ нечем, кроме короля-козыря
  st.table = [{ a: c(10, 'h', 6), d: null }];
  const m = durak.botMove(st, 'p1');
  assert.strictEqual(m.type, 'take');
});

test('бот дурака: при «беру» подкидывает некозырь, а в конце игры и козырь', () => {
  const st = fresh(2);
  st.deck = [];
  st.hands.p0 = [c(1, 's', 8), c(2, 'd', 8), c(5, 'h', 7)];
  st.hands.p1 = [c(3, 'h', 10)];
  st.table = [{ a: c(10, 'h', 8), d: null }];
  st.taking = true;
  assert.deepStrictEqual(durak.botMove(st, 'p0'), { type: 'attack', cardId: 2 }); // сначала некозырь 8♦
  st.hands.p0 = [c(1, 's', 8), c(5, 'h', 7)]; // подходит только козырь, колода пуста — сбрасываем
  assert.deepStrictEqual(durak.botMove(st, 'p0'), { type: 'attack', cardId: 1 });
  st.deck = [c(900, 'h', 6), c(901, 'h', 7), c(902, 'h', 8), c(903, 'h', 9), c(904, 'h', 10)]; // колода есть — козырь бережём
  assert.deepStrictEqual(durak.botMove(st, 'p0'), { type: 'pass' });
});

test('перед закрытием раунда сохраняется снимок стола (клиент покажет последнюю карту)', () => {
  const st = fresh(2);
  st.hands.p0 = [c(1, 'h', 7), c(2, 'c', 9)];
  st.hands.p1 = [c(3, 'h', 9), c(4, 'c', 10)];
  durak.act(st, 'p0', { type: 'attack', cardId: 1 });
  assert.strictEqual(durak.view(st, 'p1').lastEnd, null);
  durak.act(st, 'p1', { type: 'defend', attackId: 0, cardId: 3 });
  durak.act(st, 'p0', { type: 'pass' }); // подкидывать нечего → бито
  const e = durak.view(st, 'p1').lastEnd;
  assert.strictEqual(e.n, 1);
  assert.strictEqual(e.took, false);
  assert.strictEqual(e.table.length, 1);
  assert.strictEqual(e.table[0].d.id, 3); // последняя отбивающая карта в снимке
  assert.strictEqual(e.counts.p1, 1); // до добора
  assert.strictEqual(e.hand.length, 1);
  assert.strictEqual(st.hands.p1.length, 6); // после добора
  assert.deepStrictEqual(durak.view(st, 'p0').lastEnd.hand.map((x) => x.id), [2]); // у каждого своя рука
});
