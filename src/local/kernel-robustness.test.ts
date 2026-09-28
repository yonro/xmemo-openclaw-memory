import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMemoryKernel, resolveLocalVaultPath, type TrustedLocalIdentityContext } from "./kernel.js";

const directIdentity: TrustedLocalIdentityContext = { kind: "direct", actorRef: "robustness-owner" };
const helperMode = process.env.XMEMO_LOCAL_KERNEL_HELPER_MODE;
const helperParams = JSON.parse(process.env.XMEMO_LOCAL_KERNEL_HELPER_PARAMS ?? "{}") as Record<string, string>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
}

async function waitForFile(path: string, child?: ChildProcess, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Helper exited before writing ${path}.`);
      }
      await sleep(10);
    }
  }
  throw new Error(`Timed out waiting for helper output ${path}.`);
}

type ChildHandle = {
  child: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function spawnVitestHelper(mode: string, params: Record<string, string>): ChildHandle {
  const testFile = relative(process.cwd(), fileURLToPath(import.meta.url));
  const cliPath = resolve("node_modules/vitest/vitest.mjs");
  const environment = { ...process.env };
  delete environment.XMEMO_API_KEY;
  delete environment.XMEMO_KEY;
  delete environment.MEMORY_OS_API_KEY;
  delete environment.MEMORY_OS_MCP_TOKEN;
  environment.XMEMO_LOCAL_KERNEL_HELPER_MODE = mode;
  environment.XMEMO_LOCAL_KERNEL_HELPER_PARAMS = JSON.stringify(params);

  const child = spawn(process.execPath, [cliPath, "run", testFile, "--pool=threads", "--reporter=dot", "--no-color"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let captured = "";
  child.stdout?.on("data", chunk => { captured = `${captured}${String(chunk)}`.slice(-30_000); });
  child.stderr?.on("data", chunk => { captured = `${captured}${String(chunk)}`.slice(-30_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, output: () => captured, exited };
}

async function waitForExit(handle: ChildHandle, timeoutMs = 30_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handle.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Helper did not exit in ${timeoutMs} ms.\n${handle.output()}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readJsonFile<T>(path: string, child?: ChildProcess): Promise<T> {
  return JSON.parse(await waitForFile(path, child)) as T;
}

function parseLines<T>(text: string): T[] {
  const lines = text.split(/\r?\n/);
  if (!text.endsWith("\n")) lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line) as T);
}

async function inspectCrashDatabase(dataDirectory: string): Promise<string> {
  const databasePath = resolveLocalVaultPath({ dataDirectory });
  const files = await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async path => {
    try {
      return `${path.split(/[\\/]/).at(-1)}=${(await stat(path)).size} bytes`;
    } catch {
      return `${path.split(/[\\/]/).at(-1)}=missing`;
    }
  }));
  let sqlite = "unreadable";
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const integrity = database.prepare("PRAGMA quick_check(1)").get();
      const userVersion = database.prepare("PRAGMA user_version").get();
      const records = database.prepare("SELECT count(*) AS count FROM records").get();
      sqlite = `quick_check=${String(integrity?.quick_check)} user_version=${String(userVersion?.user_version)} records=${String(records?.count)}`;
    } finally {
      database.close();
    }
  } catch (error) {
    sqlite = `read_error=${error instanceof Error ? error.message : String(error)}`;
  }
  const names = await readdir(dataDirectory).catch(() => []);
  return `files=[${files.join(", ")}] entries=${JSON.stringify(names)} sqlite={${sqlite}}`;
}

if (helperMode === "cross-process-writer") {
  it("performs the requested cross-process writes", async () => {
    const kernel = await LocalMemoryKernel.open({ dataDirectory: helperParams.dataDirectory, busyTimeoutMs: 5_000 });
    try {
      const base = await kernel.get(helperParams.recordId, directIdentity);
      if (base.revision.revisionId !== helperParams.baseRevision) throw new Error("Child observed an unexpected base revision.");
      await writeFile(helperParams.readyFile, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      await waitForFile(helperParams.startFile);
      const created = await kernel.create({
        body: "cross-process child-created record",
        operationId: `${helperParams.runId}-child-create`,
      }, directIdentity);
      await writeFile(helperParams.createReceiptFile, JSON.stringify(created), { flag: "wx" });
      const updated = await kernel.update(helperParams.recordId, {
        body: "cross-process child branch",
        baseRevision: helperParams.baseRevision,
        operationId: `${helperParams.runId}-child-update`,
      }, directIdentity);
      await writeFile(helperParams.updateReceiptFile, JSON.stringify(updated), { flag: "wx" });
    } finally {
      await kernel.close();
    }
  }, 30_000);
} else if (helperMode === "crash-durability-writer") {
  it("writes acknowledged records until killed by the parent", async () => {
    const kernel = await LocalMemoryKernel.open({ dataDirectory: helperParams.dataDirectory, busyTimeoutMs: 5_000 });
    let sequence = 0;
    while (true) {
      const body = `crash-proof ${helperParams.runId} ${sequence} ${"x".repeat(128)}`;
      const receipt = await kernel.create({
        body,
        operationId: `${helperParams.runId}-operation-${sequence}`,
      }, directIdentity);
      const acknowledgement = JSON.stringify({ runId: helperParams.runId, pid: process.pid, recordId: receipt.recordId, body });
      const descriptor = openSync(helperParams.acknowledgementFile, "a");
      try {
        writeSync(descriptor, `${acknowledgement}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      sequence += 1;
      await sleep(Math.floor(Math.random() * 5));
    }
  }, 120_000);
} else if (helperMode === "write-lock-holder") {
  it("holds the requested SQLite write lock until released", async () => {
    const database = new DatabaseSync(helperParams.databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      await writeFile(helperParams.readyFile, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      await waitForFile(helperParams.releaseFile);
      database.exec("ROLLBACK");
    } finally {
      if (database.isTransaction) database.exec("ROLLBACK");
      database.close();
    }
  }, 120_000);
} else {
  const dataDirectories: string[] = [];
  const kernels: LocalMemoryKernel[] = [];
  const childProcesses: ChildHandle[] = [];

  async function openKernel(dataDirectory: string, busyTimeoutMs = 2_000): Promise<LocalMemoryKernel> {
    const kernel = await LocalMemoryKernel.open({ dataDirectory, busyTimeoutMs });
    kernels.push(kernel);
    return kernel;
  }

  afterEach(async () => {
    const children = childProcesses.splice(0);
    for (const handle of children) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
    }
    await Promise.allSettled(children.map(handle => waitForExit(handle, 30_000)));
    if (children.some(handle => handle.child.pid !== undefined && handle.child.exitCode === null && handle.child.signalCode === null)) {
      throw new Error("A local-kernel helper is still running; leaving its data directory intact.");
    }
    await Promise.all(kernels.splice(0).map(kernel => kernel.close().catch(() => {})));
    for (const directory of dataDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  describe("local kernel robustness across workers and processes", () => {
    it("serializes two Worker clients without losing acknowledged creates or updates", async () => {
      const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-two-workers-"));
      dataDirectories.push(dataDirectory);
      const first = await openKernel(dataDirectory);
      const second = await openKernel(dataDirectory);
      const base = await first.create({ body: "two-worker common base", operationId: "workers-base" }, directIdentity);

      const [firstUpdate, secondUpdate, firstCreate, secondCreate] = await Promise.all([
        first.update(base.recordId, { body: "worker one branch", baseRevision: base.revisionId, operationId: "worker-one-update" }, directIdentity),
        second.update(base.recordId, { body: "worker two branch", baseRevision: base.revisionId, operationId: "worker-two-update" }, directIdentity),
        first.create({ body: "worker one independent acknowledged record", operationId: "worker-one-create" }, directIdentity),
        second.create({ body: "worker two independent acknowledged record", operationId: "worker-two-create" }, directIdentity),
      ]);

      expect([firstUpdate.writeKind, secondUpdate.writeKind].sort()).toEqual(["conflict", "versioned_update"]);
      expect((await first.get(firstCreate.recordId, directIdentity)).body).toContain("worker one independent");
      expect((await second.get(secondCreate.recordId, directIdentity)).body).toContain("worker two independent");
      const current = await first.get(base.recordId, directIdentity);
      expect(current.revision.revisionId).toBe([firstUpdate, secondUpdate].find(item => item.writeKind === "versioned_update")?.revisionId);
      expect(current.body).toMatch(/worker one branch|worker two branch/);

      const database = new DatabaseSync(resolveLocalVaultPath({ dataDirectory }), { readOnly: true });
      try {
        const preserved = database.prepare("SELECT operation_id, revision_state FROM revisions WHERE operation_id IN (?, ?)")
          .all("worker-one-update", "worker-two-update");
        expect(preserved).toHaveLength(2);
        expect(preserved.map(row => String(row.revision_state)).sort()).toEqual(["conflict", "current"]);
      } finally {
        database.close();
      }
    });

    it("runs concurrent create and same-base update writes from two OS processes", async () => {
      const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-two-processes-"));
      dataDirectories.push(dataDirectory);
      const parentKernel = await openKernel(dataDirectory);
      const base = await parentKernel.create({ body: "two-process common base", operationId: "process-base" }, directIdentity);
      const runId = `process-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const readyFile = join(dataDirectory, "child-ready.json");
      const startFile = join(dataDirectory, "start-writes");
      const childCreateReceiptFile = join(dataDirectory, "child-create.json");
      const childUpdateReceiptFile = join(dataDirectory, "child-update.json");
      const child = spawnVitestHelper("cross-process-writer", {
        dataDirectory,
        recordId: base.recordId,
        baseRevision: base.revisionId,
        runId,
        readyFile,
        startFile,
        createReceiptFile: childCreateReceiptFile,
        updateReceiptFile: childUpdateReceiptFile,
      });
      childProcesses.push(child);

      try {
        const ready = await readJsonFile<{ pid: number }>(readyFile, child.child);
        expect(ready.pid).not.toBe(process.pid);
        expect(ready.pid).toBe(child.child.pid);
        const parentCreatePromise = parentKernel.create({
          body: "cross-process parent-created record",
          operationId: `${runId}-parent-create`,
        }, directIdentity);
        const parentUpdatePromise = parentKernel.update(base.recordId, {
          body: "cross-process parent branch",
          baseRevision: base.revisionId,
          operationId: `${runId}-parent-update`,
        }, directIdentity);
        await writeFile(startFile, "go", { flag: "wx" });

        const [parentCreate, parentUpdate, childCreate, childUpdate] = await Promise.all([
          parentCreatePromise,
          parentUpdatePromise,
          readJsonFile<{ recordId: string; operationId: string }>(childCreateReceiptFile, child.child),
          readJsonFile<{ recordId: string; operationId: string; writeKind: string; revisionId: string }>(childUpdateReceiptFile, child.child),
        ]);
        const childExit = await waitForExit(child);
        expect(childExit).toMatchObject({ code: 0, signal: null });
        expect([parentUpdate.writeKind, childUpdate.writeKind].sort()).toEqual(["conflict", "versioned_update"]);
        expect((await parentKernel.get(parentCreate.recordId, directIdentity)).body).toContain("parent-created");
        expect((await parentKernel.get(childCreate.recordId, directIdentity)).body).toContain("child-created");
        const current = await parentKernel.get(base.recordId, directIdentity);
        expect(current.revision.revisionId).toBe([parentUpdate, childUpdate].find(item => item.writeKind === "versioned_update")?.revisionId);

        const database = new DatabaseSync(resolveLocalVaultPath({ dataDirectory }), { readOnly: true });
        try {
          const branches = database.prepare("SELECT operation_id, revision_state FROM revisions WHERE operation_id IN (?, ?)")
            .all(`${runId}-parent-update`, `${runId}-child-update`);
          expect(branches).toHaveLength(2);
          expect(branches.map(row => String(row.revision_state)).sort()).toEqual(["conflict", "current"]);
        } finally {
          database.close();
        }
      } catch (error) {
        throw new Error(`${String(error)}\nCross-process helper output:\n${child.output()}`);
      }
    }, 60_000);

    it("reports a cross-process busy lock without writing and retries the same operation ids", async () => {
      const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-cross-process-busy-"));
      dataDirectories.push(dataDirectory);
      const kernel = await openKernel(dataDirectory, 50);
      const base = await kernel.create({
        recordId: "cross-process-busy-update-target",
        body: "unchanged before lock release",
        operationId: "cross-process-busy-base",
      }, directIdentity);
      const readyFile = join(dataDirectory, "lock-ready.json");
      const releaseFile = join(dataDirectory, "release-lock");
      const child = spawnVitestHelper("write-lock-holder", {
        databasePath: resolveLocalVaultPath({ dataDirectory }),
        readyFile,
        releaseFile,
      });
      childProcesses.push(child);

      try {
        const ready = await readJsonFile<{ pid: number }>(readyFile, child.child);
        expect(ready.pid).not.toBe(process.pid);
        expect(ready.pid).toBe(child.child.pid);

        await expect(kernel.create({
          recordId: "cross-process-busy-create-target",
          body: "crossprocessbusycreatephrase",
          operationId: "cross-process-busy-create",
        }, directIdentity)).rejects.toMatchObject({
          category: "storage_busy",
          receipt: {
            operationId: "cross-process-busy-create",
            storageStatus: "not_committed",
            error: { category: "storage_busy" },
          },
        });
        await expect(kernel.update(base.recordId, {
          body: "crossprocessbusyupdatephrase",
          baseRevision: base.revisionId,
          operationId: "cross-process-busy-update",
        }, directIdentity)).rejects.toMatchObject({
          category: "storage_busy",
          receipt: {
            operationId: "cross-process-busy-update",
            storageStatus: "not_committed",
            error: { category: "storage_busy" },
          },
        });

        const database = new DatabaseSync(resolveLocalVaultPath({ dataDirectory }), { readOnly: true });
        try {
          expect(database.prepare("SELECT 1 FROM records WHERE record_id = 'cross-process-busy-create-target'").get()).toBeUndefined();
          expect(database.prepare("SELECT count(*) AS count FROM revisions WHERE record_id = ?").get(base.recordId))
            .toMatchObject({ count: 1 });
          expect(database.prepare("SELECT count(*) AS count FROM operations WHERE operation_id IN (?, ?)")
            .get("cross-process-busy-create", "cross-process-busy-update")).toMatchObject({ count: 0 });
        } finally {
          database.close();
        }
        expect(await kernel.search("crossprocessbusycreatephrase", directIdentity)).toEqual([]);
        expect(await kernel.search("crossprocessbusyupdatephrase", directIdentity)).toEqual([]);
        expect((await kernel.get(base.recordId, directIdentity)).body).toBe("unchanged before lock release");
      } finally {
        await writeFile(releaseFile, "release").catch(() => {});
        await waitForExit(child, 30_000);
      }

      const created = await kernel.create({
        recordId: "cross-process-busy-create-target",
        body: "crossprocessbusycreatephrase",
        operationId: "cross-process-busy-create",
      }, directIdentity);
      const updated = await kernel.update(base.recordId, {
        body: "crossprocessbusyupdatephrase",
        baseRevision: base.revisionId,
        operationId: "cross-process-busy-update",
      }, directIdentity);
      expect(created.storageStatus).toBe("committed_local");
      expect(updated.writeKind).toBe("versioned_update");
      expect((await kernel.get(created.recordId, directIdentity)).body).toBe("crossprocessbusycreatephrase");
      expect((await kernel.get(base.recordId, directIdentity)).body).toBe("crossprocessbusyupdatephrase");
      expect(await kernel.search("crossprocessbusycreatephrase", directIdentity)).toHaveLength(1);
      expect(await kernel.search("crossprocessbusyupdatephrase", directIdentity)).toHaveLength(1);
    }, 60_000);

    it("ignores only an unterminated trailing acknowledgement line", () => {
      const complete = JSON.stringify({ runId: "complete", recordId: "known" });
      expect(parseLines<{ runId: string; recordId: string }>(`${complete}\n{"runId":"partial`)).toEqual([
        { runId: "complete", recordId: "known" },
      ]);
    });

    it("preserves every acknowledged record across five randomized SIGKILL process crashes", async () => {
      const allAcknowledged: Array<{ runId: string; pid: number; recordId: string; body: string }> = [];
      let recoveredCount = 0;

      for (let run = 0; run < 5; run += 1) {
        const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-crash-durability-"));
        dataDirectories.push(dataDirectory);
        const acknowledgementFile = join(dataDirectory, "acknowledged.jsonl");
        const runId = `crash-${process.version.replace(/[^a-z0-9]/gi, "")}-${run}-${Date.now()}`;
        const child = spawnVitestHelper("crash-durability-writer", { dataDirectory, acknowledgementFile, runId });
        childProcesses.push(child);
        const line = await waitForFile(acknowledgementFile, child.child, 45_000);
        const recordsForRun = parseLines<{ runId: string; pid: number; recordId: string; body: string }>(line)
          .filter(record => record.runId === runId);
        let attempts = 0;
        while (recordsForRun.length === 0 && attempts < 100) {
          await sleep(10);
          const refreshed = await readFile(acknowledgementFile, "utf8");
          recordsForRun.push(...parseLines<{ runId: string; pid: number; recordId: string; body: string }>(refreshed)
            .filter(record => record.runId === runId));
          attempts += 1;
        }
        expect(recordsForRun.length, `run ${run} must acknowledge a write before SIGKILL`).toBeGreaterThan(0);
        expect(recordsForRun[0].pid).not.toBe(process.pid);
        expect(recordsForRun[0].pid).toBe(child.child.pid);
        await sleep(Math.floor(Math.random() * 75));
        child.child.kill("SIGKILL");
        const exit = await waitForExit(child, 30_000);
        expect(exit.signal === "SIGKILL" || exit.code !== 0).toBe(true);

        const afterKill = parseLines<{ runId: string; pid: number; recordId: string; body: string }>(
          await readFile(acknowledgementFile, "utf8"),
        ).filter(record => record.runId === runId);
        expect(afterKill.length).toBeGreaterThan(0);
        allAcknowledged.push(...afterKill);
        let recovered: LocalMemoryKernel;
        try {
          recovered = await openKernel(dataDirectory);
        } catch (error) {
          throw new Error(`Could not reopen crash run ${run}; acknowledged=${afterKill.length}; ${await inspectCrashDatabase(dataDirectory)}`, { cause: error });
        }
        for (const acknowledged of afterKill) {
          const record = await recovered.get(acknowledged.recordId, directIdentity);
          expect(record.body).toBe(acknowledged.body);
          recoveredCount += 1;
        }
        await recovered.close();
      }

      expect(allAcknowledged.length).toBeGreaterThanOrEqual(5);
      expect(recoveredCount).toBe(allAcknowledged.length);
      console.info(`[kernel crash durability] node=${process.version} killRuns=5 acknowledged=${allAcknowledged.length} recovered=${recoveredCount} evidence=process-crash-only`);
    }, 180_000);

    it("fails closed on runtime corruption without changing damaged database bytes", async () => {
      const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-runtime-corruption-"));
      dataDirectories.push(dataDirectory);
      const kernel = await openKernel(dataDirectory);
      const acknowledged = await kernel.create({ body: "must survive corruption refusal" }, directIdentity);
      const databasePath = resolveLocalVaultPath({ dataDirectory });
      await kernel.close();

      const before = await readFile(databasePath);
      expect(before.byteLength).toBeGreaterThan(8_192);
      const descriptor = openSync(databasePath, "r+");
      try {
        writeSync(descriptor, Buffer.alloc(512), 0, 512, 4_096);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const damaged = await readFile(databasePath);
      expect(damaged).not.toEqual(before);
      await expect(LocalMemoryKernel.open({ dataDirectory })).rejects.toMatchObject({
        category: "corrupt_store",
        receipt: { storageStatus: "not_committed", error: { category: "corrupt_store" } },
      });
      expect(await readFile(databasePath)).toEqual(damaged);
      expect(acknowledged.recordId).toMatch(/[a-f0-9-]+/);
    });

    it("keeps full CRUD and search local under a fetch trap and rejects network dependencies in the module graph", async () => {
      const networkImports: string[] = [];
      const visited = new Set<string>();
      const importPattern = /(?:from\s*|import\s*)["']([^"']+)["']/g;
      const networkModule = /^(?:node:)?(?:http|https|net|dns|tls)(?:\/.*)?$/;
      const work = [
        resolve(fileURLToPath(new URL("./kernel.ts", import.meta.url))),
        resolve(fileURLToPath(new URL("./sqlite-worker.mjs", import.meta.url))),
      ];
      while (work.length > 0) {
        const file = work.pop() as string;
        if (visited.has(file)) continue;
        visited.add(file);
        const source = await readFile(file, "utf8");
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1];
          if (networkModule.test(specifier)) networkImports.push(`${file}: ${specifier}`);
          if (!specifier.startsWith(".")) continue;
          const unresolved = resolve(dirname(file), specifier);
          const candidates = specifier.endsWith(".js")
            ? [unresolved.replace(/\.js$/, ".ts"), unresolved]
            : [unresolved, `${unresolved}.ts`, `${unresolved}.mjs`];
          const sourcePath = candidates.find(candidate => existsSync(candidate));
          if (sourcePath) work.push(sourcePath);
        }
        expect(source).not.toMatch(/\bfetch\s*\(/);
      }
      expect(networkImports).toEqual([]);

      const fetchTrap = vi.fn(async () => { throw new Error("Unexpected network request during local kernel operation."); });
      vi.stubGlobal("fetch", fetchTrap);
      const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-zero-network-"));
      dataDirectories.push(dataDirectory);
      const kernel = await openKernel(dataDirectory);
      const created = await kernel.create({ body: "offline record to search", operationId: "offline-create" }, directIdentity);
      expect((await kernel.get(created.recordId, directIdentity)).body).toBe("offline record to search");
      const updated = await kernel.update(created.recordId, {
        body: "offline updated local record",
        baseRevision: created.revisionId,
        operationId: "offline-update",
      }, directIdentity);
      expect((await kernel.search("updated local", directIdentity)).map(record => record.recordId)).toContain(created.recordId);
      await kernel.softDelete(created.recordId, { baseRevision: updated.revisionId, operationId: "offline-delete" }, directIdentity);
      expect(await kernel.search("updated local", directIdentity)).toHaveLength(0);
      await expect(kernel.get(created.recordId, directIdentity)).rejects.toMatchObject({ category: "not_found" });
      expect(fetchTrap).not.toHaveBeenCalled();
    });

    it("rejects in-flight calls after Worker termination and can open a fresh Worker", async () => {
      const dataDirectory = await mkdtemp(join(tmpdir(), "xmemo-local-worker-crash-"));
      dataDirectories.push(dataDirectory);
      const kernel = await openKernel(dataDirectory);
      const pending = kernel.create({ body: `request interrupted by Worker exit ${"x".repeat(500_000)}`, operationId: "worker-crash-request" }, directIdentity);
      const internals = kernel as unknown as { worker: import("node:worker_threads").Worker; pending: Map<number, unknown> };
      const deadline = Date.now() + 2_000;
      while (internals.pending.size === 0 && Date.now() < deadline) await sleep(1);
      expect(internals.pending.size).toBeGreaterThan(0);
      const termination = internals.worker.terminate();
      const outcome = await Promise.race([
        pending.then(value => ({ value }), error => ({ error })),
        sleep(2_000).then(() => ({ timeout: true as const })),
      ]);
      await termination;
      expect(outcome).toMatchObject({
        error: {
          category: "worker_failure",
          receipt: { storageStatus: "unknown", error: { category: "worker_failure" } },
        },
      });

      const recovered = await openKernel(dataDirectory);
      const receipt = await recovered.create({ body: "fresh Worker can recover" }, directIdentity);
      expect((await recovered.get(receipt.recordId, directIdentity)).body).toBe("fresh Worker can recover");
    });
  });
}
