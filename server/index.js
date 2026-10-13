'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, REACTIONS } = require('./rooms');
const registry = require('./games');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new RoomManager(io);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
// ссылки вида /room/ABCD открывают то же одностраничное приложение
app.get('/room/:code', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const attach = (r, p) => {
    room = r; me = p;
    p.connected = true;
    p.socketId = socket.id;
    r.cancelEmptyTimer();
    if (r.hostId == null || !r.byId(r.hostId)) r.hostId = p.id;
    socket.join(r.code);
  };

  const guard = (fn) => (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    try {
      if (!room || !me) return ack({ error: 'Вы не в комнате' });
      fn(payload || {}, ack);
    } catch (e) {
      console.error(e);
      ack({ error: 'Внутренняя ошибка' });
    }
  };

  socket.on('room:create', (p, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (room) return ack({ error: 'Уже в комнате' });
    const r = rooms.create();
    const pl = r.addHuman(p && p.name, socket.id);
    attach(r, pl);
    r.pushChat(null, `${pl.name} создал комнату`);
    ack({ ok: true, code: r.code, token: pl.token });
    r.broadcast();
  });

  socket.on('room:join', (p, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    if (room) return ack({ error: 'Уже в комнате' });
    p = p || {};
    const r = rooms.get(p.code);
    if (!r) return ack({ error: 'Комната не найдена' });
    // возвращение по токену — реконнект
    const known = r.byToken(p.token);
    if (known) {
      if (known.socketId && known.socketId !== socket.id) io.to(known.socketId).emit('kicked', { reason: 'Вы зашли с другого устройства' });
      attach(r, known);
      r.pushChat(null, `${known.name} вернулся`);
      ack({ ok: true, code: r.code, token: known.token });
      return r.broadcast();
    }
    if (r.phase !== 'lobby') return ack({ error: 'Игра уже идёт' });
    const g = registry.games[r.gameId];
    if (r.players.length >= g.meta.maxPlayers) return ack({ error: 'Комната заполнена' });
    const pl = r.addHuman(p.name, socket.id);
    attach(r, pl);
    r.pushChat(null, `${pl.name} зашёл в комнату`);
    ack({ ok: true, code: r.code, token: pl.token });
    r.broadcast();
  });

  socket.on('room:settings', guard((p, ack) => {
    if (room.hostId !== me.id) return ack({ error: 'Только хост' });
    if (room.phase !== 'lobby') return ack({ error: 'Игра уже идёт' });
    if (p.gameId) {
      if (!registry.games[p.gameId]) return ack({ error: 'Игра недоступна' });
      if (p.gameId !== room.gameId) { room.gameId = p.gameId; room.rules = {}; }
    }
    if (p.rules && typeof p.rules === 'object') {
      const schema = registry.games[room.gameId].meta.rulesSchema;
      for (const s of schema) {
        if (!(s.key in p.rules)) continue;
        if (s.type === 'bool') room.rules[s.key] = !!p.rules[s.key];
        else if (s.type === 'select' && s.options.includes(Number(p.rules[s.key]))) room.rules[s.key] = Number(p.rules[s.key]);
      }
    }
    ack({ ok: true });
    room.broadcast();
  }));

  socket.on('room:addBot', guard((_p, ack) => {
    if (room.hostId !== me.id) return ack({ error: 'Только хост' });
    if (room.phase !== 'lobby') return ack({ error: 'Игра уже идёт' });
    const g = registry.games[room.gameId];
    if (!g.meta.supportsBots) return ack({ error: 'В этой игре нет ботов' });
    if (room.players.length >= g.meta.maxPlayers) return ack({ error: 'Комната заполнена' });
    room.addBot();
    ack({ ok: true });
    room.broadcast();
  }));

  socket.on('room:kick', guard((p, ack) => {
    if (room.hostId !== me.id) return ack({ error: 'Только хост' });
    if (room.phase !== 'lobby') return ack({ error: 'Игра уже идёт' });
    const t = room.byId(p.id);
    if (!t || t.id === me.id) return ack({ error: 'Нельзя' });
    if (t.socketId) io.to(t.socketId).emit('kicked', { reason: 'Хост убрал вас из комнаты' });
    room.removePlayer(t.id);
    ack({ ok: true });
    room.broadcast();
  }));

  socket.on('room:start', guard((_p, ack) => {
    if (room.hostId !== me.id) return ack({ error: 'Только хост' });
    if (room.phase !== 'lobby') return ack({ error: 'Уже идёт' });
    const err = room.start();
    if (err) return ack({ error: err });
    ack({ ok: true });
    room.broadcast('start');
  }));

  socket.on('room:lobby', guard((_p, ack) => {
    if (room.hostId !== me.id) return ack({ error: 'Только хост' });
    room.backToLobby();
    ack({ ok: true });
    room.broadcast();
  }));

  socket.on('game:action', guard((p, ack) => {
    const res = room.act(me.id, p);
    if (res.error) return ack({ error: res.error });
    ack({ ok: true });
    room.broadcast(res.sound);
  }));

  socket.on('chat:send', guard((p, ack) => {
    const text = String(p.text || '').trim();
    if (!text) return ack({ error: 'Пусто' });
    room.pushChat(me.name, text);
    ack({ ok: true });
    room.broadcast();
  }));

  socket.on('chat:react', guard((p, ack) => {
    if (!REACTIONS.includes(p.emoji)) return ack({ error: 'Нет такой реакции' });
    io.to(room.code).emit('reaction', { from: me.id, name: me.name, emoji: p.emoji });
    ack({ ok: true });
  }));

  socket.on('room:leave', guard((_p, ack) => {
    const r = room, id = me.id;
    socket.leave(r.code);
    room = null; me = null;
    if (r.phase === 'lobby') r.removePlayer(id);
    else r.markDisconnected(id);
    r.pushChat(null, 'Игрок вышел');
    r.touch();
    r.broadcast();
    ack({ ok: true });
  }));

  socket.on('disconnect', () => {
    if (!room || !me) return;
    if (me.socketId !== socket.id) return; // уже подключён с другого устройства
    room.markDisconnected(me.id);
    room.broadcast();
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Карточный круг: http://localhost:${PORT}`));
}
module.exports = { server, io, rooms };
