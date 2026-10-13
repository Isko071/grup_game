'use strict';
// Реестр игр. Каждая игра: meta, create, act, view, botMove, isOver.
const games = {
  uno: require('./uno'),
  durak: require('./durak'),
  mafia: require('./mafia'),
};

module.exports = {
  games,
  list: () => Object.values(games).map((g) => g.meta),
  soon: [],
};
