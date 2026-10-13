'use strict';
const crypto = require('crypto');
const registry = require('./games');

const ROOM_TTL_MS = 20 * 60 * 1000; // пустая комната живёт 20 минут
const BOT_DELAY_MS = 900;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CHAT = 100;
const REACTIONS = ['👍', '😂', '😮', '😡', '🔥', '👏'];

class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.players = []; // {id, token, name, bot, connected, socketId, lastSeen}
    this.hostId = null;
    this.gameId = 'uno';
    this.rules = {};
    this.game = null; // состояние игры
    this.phase = 'lobby'; // lobby | playing | over
    this.chat = [];
    this.emptyTimer = null;
    this.botTimer = null;
    this.onEmpty = onEmpty;
  }

  get humans() { return this.players.filter((p) => !p.bot); }
  get connectedHumans() { return this.humans.filter((p) => p.connected); }
  byId(id) { return this.players.find((p) => p.id === id); }
  byToken(t) { return t ? this.humans.find((p) => p.token === t) : null; }

  addHuman(name, socketId) {
    const p = {
      id: 'p' + crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name: cleanName(name),
      bot: false,
      connected: true,
      socketId,
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.cancelEmptyTimer();
    return p;
  }

  addBot() {
    const used = new Set(this.players.map((p) => p.name));
    const names = ['Робо-Вася', 'Робо-Маша', 'Робо-Гоша', 'Робо-Люся', 'Робо-Борис', 'Робо-Зина', 'Робо-Тимур', 'Робо-Нина', 'Робо-Кеша'];
    const name = names.find((n) => !used.has(n)) || 'Бот' + this.players.length;
    const p = { id: 'b' + crypto.randomBytes(3).toString('hex'), token: null, name, bot: true, connected: true, socketId: null };
    this.players.push(p);
    return p;
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
    if (this.hostId === id) this.reassignHost();
  }

  reassignHost() {
    const h = this.connectedHumans[0] || this.humans[0];
    this.hostId = h ? h.id : null;
  }

  markDisconnected(id) {
    const p = this.byId(id);
    if (!p) return;
    p.connected = false;
    p.socketId = null;
    if (this.phase === 'lobby') {
      // в лобби место освобождается после короткой паузы (перезагрузка страницы)
      setTimeout(() => {
        const q = this.byId(id);
        if (q && !q.connected && this.phase === 'lobby') { this.removePlayer(id); this.touch(); this.broadcast(); }
      }, 15000).unref?.();
    }
    if (this.hostId === id) this.reassignHost();
    if (this.connectedHumans.length === 0) this.startEmptyTimer();
  }

  startEmptyTimer() {
    this.cancelEmptyTimer();
    this.emptyTimer = setTimeout(() => this.onEmpty(this.code), ROOM_TTL_MS);
    this.emptyTimer.unref?.();
  }
  cancelEmptyTimer() { if (this.emptyTimer) clearTimeout(this.emptyTimer); this.emptyTimer = null; }
  touch() { if (this.connectedHumans.length === 0) this.startEmptyTimer(); }

  setIo(io) { this.io = io; }

  // --- игра ---
  start() {
    const g = registry.games[this.gameId];
    if (!g) return 'Игра недоступна';
    if (this.players.length < g.meta.minPlayers) return `Нужно минимум ${g.meta.minPlayers} игрока`;
    if (this.players.length > g.meta.maxPlayers) return `Максимум ${g.meta.maxPlayers} игроков`;
    this.game = g.create(this.players, this.rules);
    this.game.names = Object.fromEntries(this.players.map((p) => [p.id, p.name]));
    this.phase = 'playing';
    this.scheduleBot();
    return null;
  }

  act(pid, action) {
    if (this.phase !== 'playing') return { error: 'Игра не идёт' };
    const g = registry.games[this.gameId];
    const res = g.act(this.game, pid, action);
    if (res.error) return res;
    if (g.isOver(this.game)) { this.phase = 'over'; clearTimeout(this.botTimer); }
    else this.scheduleBot();
    return res;
  }

  scheduleBot() {
    clearTimeout(this.botTimer);
    const g = registry.games[this.gameId];
    if (this.phase !== 'playing' || !g.supportsBots && !g.meta.supportsBots) return;
    const bots = this.players.filter((p) => p.bot);
    if (!bots.length) return;
    this.botTimer = setTimeout(() => {
      if (this.phase !== 'playing') return;
      for (const b of bots) {
        const a = g.botMove(this.game, b.id);
        if (a) {
          const res = this.act(b.id, a);
          this.broadcast(res.sound);
          return;
        }
      }
    }, BOT_DELAY_MS);
    this.botTimer.unref?.();
  }

  backToLobby() {
    clearTimeout(this.botTimer);
    this.game = null;
    this.phase = 'lobby';
    // отключившиеся люди уходят
    for (const p of this.humans.filter((x) => !x.connected)) this.removePlayer(p.id);
  }

  // --- вид для клиента ---
  viewFor(pid) {
    const g = registry.games[this.gameId];
    return {
      code: this.code,
      me: pid,
      host: this.hostId,
      phase: this.phase,
      gameId: this.gameId,
      rules: { ...g.meta.defaultRules, ...this.rules },
      games: registry.list(),
      soon: registry.soon,
      players: this.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, connected: p.connected })),
      chat: this.chat.slice(-40),
      game: this.game && this.phase !== 'lobby' ? g.view(this.game, pid) : null,
      reactions: REACTIONS,
    };
  }

  broadcast(sound) {
    if (!this.io) return;
    for (const p of this.humans) {
      if (p.socketId) this.io.to(p.socketId).emit('state', { ...this.viewFor(p.id), sound: sound || null });
    }
  }

  pushChat(from, text) {
    const m = { t: Date.now(), from, text: String(text).slice(0, 300) };
    this.chat.push(m);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    return m;
  }
}

function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || 'Игрок';
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  create() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, (c) => this.rooms.delete(c));
    room.setIo(this.io);
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase().trim()); }
}

module.exports = { RoomManager, REACTIONS, ROOM_TTL_MS };
