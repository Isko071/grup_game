'use strict';
// Реестр игр. Каждая игра: meta, create, act, view, botMove, isOver.
const games = {
  uno: require('./uno'),
};

module.exports = {
  games,
  list: () => Object.values(games).map((g) => g.meta),
  soon: [
    { id: 'durak', title: 'Дурак' },
    { id: 'mafia', title: 'Мафия' },
  ],
};
