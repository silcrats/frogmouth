// Runs the board's suggestion work on its own thread, so that a large board
// doesn't hold up everyone else's requests while it's worked out.
const { parentPort, workerData } = require('node:worker_threads');
const { suggestBoard, rateGroup, closestPassages } = require('./board-suggest');

const tasks = {
  suggest: suggestBoard,
  rate: ({ cards, members }) => rateGroup(cards, members),
  evidence: ({ pairs }) => pairs.map(([a, b]) => closestPassages(a, b)),
};

parentPort.postMessage(tasks[workerData.task](workerData.input));
