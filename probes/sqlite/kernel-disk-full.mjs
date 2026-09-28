import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const volumeDirectory = resolve(process.argv[2] ?? "");
const markerPath = join(volumeDirectory, ".xmemo-disposable-volume");
if (!existsSync(markerPath)) throw new Error("Refusing disk-full test outside a marked disposable volume.");

const { LocalMemoryKernel } = await import(pathToFileURL(resolve("dist/src/local/kernel.js")));
const dataDirectory = join(volumeDirectory, "kernel-vault");
const fillerPath = join(volumeDirectory, "filler.bin");
const identity = { kind: "direct", actorRef: "disk-full-probe" };
const kernel = await LocalMemoryKernel.open({ dataDirectory, busyTimeoutMs: 500 });

try {
  const acknowledged = await kernel.create({
    body: "acknowledged record remains readable while the disposable volume is full",
    operationId: "disk-full-acknowledged-before-full",
  }, identity);

  const descriptor = openSync(fillerPath, "wx");
  let fillerBytes = 0;
  const block = Buffer.alloc(64 * 1024, 0x58);
  let fillFailure;
  try {
    while (true) fillerBytes += writeSync(descriptor, block);
  } catch (error) {
    if (error?.code !== "ENOSPC") fillFailure = error;
  }
  try { fsyncSync(descriptor); } catch (error) { if (error?.code !== "ENOSPC") fillFailure ??= error; }
  closeSync(descriptor);
  if (fillFailure) throw fillFailure;
  if (fillerBytes === 0) throw new Error("Disposable volume did not accept filler bytes.");

  let fullError;
  try {
    await kernel.create({ body: "large body ".repeat(40_000), operationId: "disk-full-must-not-commit" }, identity);
  } catch (error) {
    fullError = error;
  }
  if (fullError?.category !== "storage_full" || fullError.receipt?.storageStatus !== "not_committed") {
    throw new Error(`Expected storage_full/not_committed, received ${fullError?.category ?? "success"}/${fullError?.receipt?.storageStatus ?? "no receipt"}.`);
  }

  const beforeRecovery = await kernel.get(acknowledged.recordId, identity);
  if (beforeRecovery.body !== "acknowledged record remains readable while the disposable volume is full") {
    throw new Error("Acknowledged data was not readable while the volume was full.");
  }

  unlinkSync(fillerPath);
  const recoveredWrite = await kernel.create({
    body: "write recovers after freeing the disposable volume",
    operationId: "disk-full-write-after-recovery",
  }, identity);
  await kernel.close();

  const reopened = await LocalMemoryKernel.open({ dataDirectory, busyTimeoutMs: 500 });
  try {
    const recoveredBaseline = await reopened.get(acknowledged.recordId, identity);
    const recoveredRecord = await reopened.get(recoveredWrite.recordId, identity);
    if (!recoveredBaseline.body.includes("acknowledged record")) throw new Error("Acknowledged record was lost after reopening.");
    if (!recoveredRecord.body.includes("recovers after freeing")) throw new Error("Post-recovery write was not durable.");
  } finally {
    await reopened.close();
  }

  process.stdout.write(`${JSON.stringify({
    runtime: process.version,
    platform: process.platform,
    volumeDirectory,
    fillerBytes,
    errorCategory: fullError.category,
    storageStatus: fullError.receipt.storageStatus,
    acknowledgedReadWhileFull: true,
    writeRecovered: true,
    reopenedRecords: 2,
  })}\n`);
} finally {
  await kernel.close().catch(() => {});
}
