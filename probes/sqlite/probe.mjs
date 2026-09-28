import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';

const role = process.argv[2];

function output(label, result) {
  console.log(JSON.stringify({ probe: label, ...result }));
}

function dbOpen(file, options) {
  return options === undefined ? new DatabaseSync(file) : new DatabaseSync(file, options);
}

function closeQuietly(db) {
  try { db?.close(); } catch {}
}

function runChild(args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line) onLine?.(line, child);
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (pending) onLine?.(pending, child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForLine(start, predicate, timeoutMs = 10000) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...start], { stdio: ['ignore', 'pipe', 'pipe'] });
  let outputText = '';
  let errorText = '';
  let pending = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for child line; stdout=${outputText}`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      outputText += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line && predicate(line)) { clearTimeout(timer); resolve(line); }
    });
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      if (!outputText.includes('DONE')) { clearTimeout(timer); reject(new Error(`Child exited before ready: code=${code} signal=${signal} stdout=${outputText} stderr=${errorText}`)); }
    });
  });
  return { child, ready, getOutput: () => ({ stdout: outputText, stderr: errorText }) };
}

async function workerMessage(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: data });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)); });
  });
}

async function runtimeInfo(directory) {
  const db = dbOpen(':memory:');
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  const compileOptions = db.prepare('PRAGMA compile_options').all().map(row => row.compile_options).sort();
  const fts5 = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get().enabled === 1;
  const json = db.prepare("SELECT json_valid('{\"probe\":true}') AS valid").get().valid === 1;
  db.exec('CREATE TABLE wal_probe (value INTEGER)');
  const journalMode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
  const busyTimeout = db.prepare('PRAGMA busy_timeout = 250').get().timeout;
  db.close();
  assert.equal(json, true, 'SQLite JSON functions must be enabled');
  assert.equal(journalMode, 'memory', 'WAL is not applicable to an in-memory database');

  const file = path.join(directory, 'runtime-info.db');
  const fileDb = dbOpen(file);
  const fileWalMode = fileDb.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
  fileDb.close();
  assert.equal(fileWalMode, 'wal');
  output('runtime-info', {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sqliteVersion,
    nodeSqliteFlagRequired: false,
    fts5CompileOption: fts5,
    jsonFunctions: json,
    fileWalMode: fileWalMode,
    busyTimeoutMs: busyTimeout,
    compileOptions,
  });
}

async function workerProbe(databasePath) {
  const setup = dbOpen(databasePath);
  setup.exec('CREATE TABLE IF NOT EXISTS worker_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  setup.close();
  const roundTrip = await workerMessage({ operation: 'round-trip', databasePath, value: `worker-${Date.now()}` });
  assert.match(roundTrip.row.value, /^worker-/);

  let ticks = 0;
  let maxTimerGapMs = 0;
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    ticks += 1;
    maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick);
    lastTick = now;
  }, 5);
  const slowQuery = await workerMessage({ operation: 'slow-query', databasePath, iterations: 2500000 });
  clearInterval(timer);
  assert.ok(slowQuery.elapsedMs >= 50, `worker query unexpectedly short (${slowQuery.elapsedMs.toFixed(1)}ms)`);
  assert.ok(ticks >= 3, `main-thread timers did not run during worker query (${ticks} ticks)`);
  assert.ok(maxTimerGapMs < 250, `main-thread timer gap was ${maxTimerGapMs.toFixed(1)}ms`);
  output('worker-read-write-main-thread', {
    workerRoundTrip: roundTrip,
    longQueryMs: Number(slowQuery.elapsedMs.toFixed(1)),
    mainThreadTimerTicks: ticks,
    maxMainThreadTimerGapMs: Number(maxTimerGapMs.toFixed(1)),
  });
}

async function processLockProbe(directory) {
  const file = path.join(directory, 'locks.db');
  const setup = dbOpen(file);
  setup.exec('PRAGMA journal_mode = WAL; CREATE TABLE lock_probe (value TEXT NOT NULL)');
  setup.close();

  const holder = await waitForLine(['--role', 'lock-holder', file, '700'], line => line === 'READY');
  await holder.ready;
  const readStarted = performance.now();
  const reader = dbOpen(file);
  const readResult = reader.prepare('SELECT count(*) AS count FROM lock_probe').get().count;
  const readMs = performance.now() - readStarted;
  reader.close();
  assert.equal(readResult, 0);
  assert.ok(readMs < 500, `WAL reader waited ${readMs.toFixed(1)}ms behind a writer`);

  const busyStarted = performance.now();
  const contender = await runChild(['--role', 'contender', file, '250']);
  const busyElapsedMs = performance.now() - busyStarted;
  const busy = JSON.parse(contender.stdout.trim().split('\n').at(-1));
  assert.equal(busy.result, 'busy');
  assert.ok(busy.elapsedMs >= 200 && busy.elapsedMs < 1200, `child busy wait was ${busy.elapsedMs.toFixed(1)}ms`);
  const holderExit = await new Promise((resolve, reject) => {
    holder.child.once('error', reject);
    holder.child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(holderExit.code, 0, `${holder.getOutput().stderr}`);

  const twoLeases = await Promise.all([
    runChild(['--role', 'lease', file, 'lease-a']),
    runChild(['--role', 'lease', file, 'lease-b']),
  ]);
  const leaseResults = twoLeases.map(result => JSON.parse(result.stdout.trim().split('\n').at(-1)));
  assert.equal(leaseResults.filter(result => result.acquired).length, 1, JSON.stringify(leaseResults));
  const finalDb = dbOpen(file);
  const rows = finalDb.prepare('SELECT value FROM lock_probe ORDER BY value').all().map(row => row.value);
  finalDb.close();
  assert.deepEqual(rows, ['holder']);
  output('multiprocess-wal-locks-and-lease', {
    readDuringWriterMs: Number(readMs.toFixed(1)),
    boundedBusyTimeoutMs: 250,
    busyErrorWaitMs: Number(busy.elapsedMs.toFixed(1)),
    childStartupAndWaitMs: Number(busyElapsedMs.toFixed(1)),
    busyError: busy.error,
    holderExit,
    leaseResults,
    finalRows: rows,
  });
}

async function durabilityProbe(directory) {
  const runs = [];
  for (let run = 0; run < 5; run += 1) {
    const file = path.join(directory, `durability-${run}.db`);
    const setup = dbOpen(file);
    setup.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE commits (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    setup.close();
    const target = randomInt(30, 100);
    let acknowledged = 0;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--role', 'durable-writer', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        acknowledged = Math.max(acknowledged, event.committed);
        if (acknowledged >= target && child.exitCode === null) child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
      setTimeout(() => child.kill('SIGKILL'), 10000).unref();
    });
    assert.equal(exit.signal, 'SIGKILL', `writer did not receive SIGKILL: ${JSON.stringify(exit)} ${stderr}`);
    const verify = dbOpen(file);
    const count = verify.prepare('SELECT count(*) AS count FROM commits').get().count;
    const syncMode = verify.prepare('PRAGMA synchronous').get().synchronous;
    verify.close();
    assert.equal(syncMode, 2);
    assert.ok(count >= acknowledged, `run ${run}: recovered ${count} rows, only ${acknowledged} commit acknowledgements observed`);
    runs.push({ randomTargetCommits: target, lastAcknowledgedCommit: acknowledged, recoveredRows: count, signal: exit.signal });
  }
  output('synchronous-full-process-kill', { runs, scopeLimit: 'SIGKILL process-crash evidence only; not power-loss evidence' });
}

async function backupProbe(directory) {
  assert.equal(typeof backup, 'function', 'node:sqlite backup API is required on the declared Node floor');
  const sourcePath = path.join(directory, 'backup-source.db');
  const backupPath = path.join(directory, 'backup-copy.db');
  const db = dbOpen(sourcePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE snapshots (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO snapshots(payload) VALUES (?)');
  const payload = 'x'.repeat(8192);
  const transaction = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  transaction.run();
  for (let i = 0; i < 600; i += 1) insert.run(`${i}:${payload}`);
  commit.run();
  const initialRows = db.prepare('SELECT count(*) AS count FROM snapshots').get().count;

  let writesDuringBackup = 0;
  const backupPromise = backup(db, backupPath, { rate: 1 });
  const timer = setInterval(() => {
    insert.run(`concurrent-${writesDuringBackup}`);
    writesDuringBackup += 1;
  }, 2);
  const pages = await backupPromise;
  clearInterval(timer);
  const finalRows = db.prepare('SELECT count(*) AS count FROM snapshots').get().count;
  db.close();

  const restored = dbOpen(backupPath);
  const restoredRows = restored.prepare('SELECT count(*) AS count FROM snapshots').get().count;
  const integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
  restored.close();
  assert.equal(integrity, 'ok');
  assert.ok(restoredRows >= initialRows && restoredRows <= finalRows);

  const livePath = path.join(directory, 'live-copy-source.db');
  const rawPath = path.join(directory, 'live-main-only-copy.db');
  const live = dbOpen(livePath);
  live.exec('CREATE TABLE live_rows (value TEXT NOT NULL); PRAGMA journal_mode = WAL');
  live.prepare('INSERT INTO live_rows VALUES (?)').run('committed-to-wal');
  const sourceCount = live.prepare('SELECT count(*) AS count FROM live_rows').get().count;
  await copyFile(livePath, rawPath);
  live.close();
  const raw = dbOpen(rawPath);
  const rawCount = raw.prepare('SELECT count(*) AS count FROM live_rows').get().count;
  raw.close();
  assert.equal(sourceCount, 1);
  assert.equal(rawCount, 0, 'main-file-only copy should omit the uncheckpointed WAL commit');
  output('online-backup-and-live-file-copy', {
    backupPages: pages,
    writesDuringBackup,
    sourceRows: finalRows,
    restoredRows,
    restoredIntegrity: integrity,
    liveSourceRows: sourceCount,
    copiedMainFileRows: rawCount,
  });
}

async function corruptionProbe(directory) {
  const badPath = path.join(directory, 'corrupt.db');
  const fs = await import('node:fs/promises');
  await fs.writeFile(badPath, Buffer.from('this is not an sqlite database\0'.repeat(32)));
  let observed;
  let db;
  try {
    db = dbOpen(badPath);
    db.prepare('PRAGMA integrity_check').all();
    throw new Error('corrupt file unexpectedly passed integrity_check');
  } catch (error) {
    if (error.message === 'corrupt file unexpectedly passed integrity_check') throw error;
    observed = { code: error.code, message: error.message };
  } finally { closeQuietly(db); }
  assert.match(observed.message, /not a database|malformed/i);
  output('corrupt-database-error', observed);
}

async function ftsProbe(directory) {
  const file = path.join(directory, 'fts.db');
  const db = dbOpen(file);
  const cases = [
    ['ja', '東京駅で機械学習の記憶を整理する'],
    ['ko', '서울에서 인공지능 기억을 정리합니다'],
    ['zh', '在北京整理机器学习记忆'],
  ];
  db.exec("CREATE VIRTUAL TABLE unicode_fts USING fts5(language, text, tokenize='unicode61')");
  db.exec("CREATE VIRTUAL TABLE trigram_fts USING fts5(language, text, tokenize='trigram')");
  const unicodeInsert = db.prepare('INSERT INTO unicode_fts VALUES (?, ?)');
  const trigramInsert = db.prepare('INSERT INTO trigram_fts VALUES (?, ?)');
  for (const [language, text] of cases) { unicodeInsert.run(language, text); trigramInsert.run(language, text); }
  const observations = cases.map(([language, text]) => ({
    language,
    text,
    unicodeTwoCharacterMatch: db.prepare('SELECT count(*) AS count FROM unicode_fts WHERE unicode_fts MATCH ?').get(language === 'ja' ? '東京' : language === 'ko' ? '서울' : '北京').count,
    trigramSubstringMatch: db.prepare('SELECT count(*) AS count FROM trigram_fts WHERE trigram_fts MATCH ?').get(language === 'ja' ? '東京駅' : language === 'ko' ? '서울에' : '机器学').count,
  }));
  const tokenizerError = (() => {
    try { db.exec("CREATE VIRTUAL TABLE unsupported_tokenizer USING fts5(text, tokenize='unrecognized-tokenizer')"); return null; }
    catch (error) { return { code: error.code, message: error.message }; }
  })();
  db.close();
  output('fts5-cjk-tokenizer-observations', { observations, tokenizerError });
}

async function diskFullSetup(file) {
  const db = dbOpen(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE full_probe (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
  db.close();
  output('disk-full-setup', { databasePath: file });
}

async function diskFullWrite(file) {
  const db = dbOpen(file);
  const insert = db.prepare('INSERT INTO full_probe(payload) VALUES (?)');
  const payload = Buffer.alloc(1024 * 1024, 0x58);
  let committedRows = 0;
  let observed;
  try {
    for (let i = 0; i < 128; i += 1) {
      db.exec('BEGIN IMMEDIATE');
      try { insert.run(payload); db.exec('COMMIT'); committedRows += 1; }
      catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    }
    throw new Error('disk-full fixture did not exhaust the mounted volume');
  } catch (error) {
    if (error.message === 'disk-full fixture did not exhaust the mounted volume') throw error;
    observed = { code: error.code, errcode: error.errcode, message: error.message };
  } finally { closeQuietly(db); }
  assert.match(JSON.stringify(observed), /SQLITE_FULL|database or disk is full|no space/i);
  output('disk-full-write-error', { committedRows, error: observed });
}

if (role === '--role') {
  const mode = process.argv[3];
  const file = process.argv[4];
  if (mode === 'lock-holder') {
    const db = dbOpen(file);
    db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE');
    console.log('READY');
    setTimeout(() => {
      db.prepare('INSERT INTO lock_probe(value) VALUES (?)').run('holder');
      db.exec('COMMIT');
      db.close();
      console.log('DONE');
    }, Number(process.argv[5]));
  } else if (mode === 'contender') {
    const db = dbOpen(file);
    db.exec(`PRAGMA busy_timeout = ${Number(process.argv[5])}`);
    const started = performance.now();
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO lock_probe(value) VALUES (?)').run('contender');
      db.exec('COMMIT');
      output('contender', { result: 'acquired', elapsedMs: performance.now() - started });
    } catch (error) {
      output('contender', { result: 'busy', elapsedMs: performance.now() - started, error: { code: error.code, errcode: error.errcode, message: error.message } });
    } finally { closeQuietly(db); }
  } else if (mode === 'lease') {
    const db = dbOpen(file);
    db.exec('PRAGMA busy_timeout = 2000; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare('SELECT owner, expires_at FROM lease WHERE id = 1').get();
    const now = Date.now();
    let acquired = false;
    if (!existing || existing.expires_at <= now) {
      db.prepare('INSERT INTO lease(id, owner, expires_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at').run(process.argv[5], now + 30000);
      acquired = true;
    }
    db.exec('COMMIT');
    output('lease', { owner: process.argv[5], acquired });
    db.close();
  } else if (mode === 'durable-writer') {
    const db = dbOpen(file);
    db.exec('PRAGMA synchronous = FULL');
    const insert = db.prepare('INSERT INTO commits(value) VALUES (?)');
    for (let committed = 1; ; committed += 1) {
      db.exec('BEGIN IMMEDIATE');
      insert.run(`commit-${committed}`);
      db.exec('COMMIT');
      console.log(JSON.stringify({ committed }));
    }
  } else {
    throw new Error(`Unknown child role: ${mode}`);
  }
} else if (role === 'disk-full-setup') {
  await diskFullSetup(process.argv[3]);
} else if (role === 'disk-full-write') {
  await diskFullWrite(process.argv[3]);
} else {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'xmemo-sqlite-probe-'));
  try {
    await runtimeInfo(temp);
    await workerProbe(path.join(temp, 'worker.db'));
    await processLockProbe(temp);
    await durabilityProbe(temp);
    await backupProbe(temp);
    await corruptionProbe(temp);
    await ftsProbe(temp);
    const emptyDirectory = path.join(temp, 'empty-install');
    await mkdir(emptyDirectory);
    const zeroCompile = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:').close(); console.log('BUILTIN_OK')"], { cwd: emptyDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(zeroCompile.code, 0, zeroCompile.stderr);
    assert.match(zeroCompile.stdout, /BUILTIN_OK/);
    output('zero-compile-builtin-install', { emptyDirectoryRequire: 'passed', command: "node -e \"const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:').close()\"", stderr: zeroCompile.stderr.trim() });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
