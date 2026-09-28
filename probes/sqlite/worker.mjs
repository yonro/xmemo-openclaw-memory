import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const database = new DatabaseSync(workerData.databasePath);
database.exec('PRAGMA busy_timeout = 1000');

if (workerData.operation === 'round-trip') {
  database.exec('CREATE TABLE IF NOT EXISTS worker_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  database.prepare('INSERT INTO worker_probe(value) VALUES (?)').run(workerData.value);
  const row = database.prepare('SELECT value FROM worker_probe WHERE value = ?').get(workerData.value);
  parentPort.postMessage({ row, count: database.prepare('SELECT count(*) AS count FROM worker_probe').get().count });
} else if (workerData.operation === 'slow-query') {
  const started = performance.now();
  const result = database.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < ${workerData.iterations}
    ) SELECT sum(value) AS total FROM sequence
  `).get();
  parentPort.postMessage({ elapsedMs: performance.now() - started, total: Number(result.total) });
} else {
  throw new Error(`Unknown worker operation: ${workerData.operation}`);
}

database.close();
