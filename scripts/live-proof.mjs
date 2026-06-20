#!/usr/bin/env node
// Reproducible live proof for the @xmemo/openclaw-memory plugin.
//
// Requires:
//   - Node.js >=22.19 (or the Node version used by OpenClaw)
//   - XMEMO_KEY environment variable set to a valid XMemo API key
//
// This script exercises every tool registered by the plugin against the public
// XMemo REST API and prints a redacted summary. It creates transient resources
// (memories, reminders, timeline events, restart snapshots) and cleans them up
// where possible. Audit/ledger endpoints are called opportunistically: if the
// key lacks audit scope or the ledger is empty, the step is reported as skipped
// rather than a failure.

const BASE_URL = process.env.XMEMO_BASE_URL ?? "https://xmemo.dev";
const API_KEY = process.env.XMEMO_KEY ?? process.env.MEMORY_OS_API_KEY ?? process.env.MEMORY_OS_MCP_TOKEN;
const BUCKET = process.env.XMEMO_LIVE_BUCKET ?? "openclaw-live-proof";
const SCOPE = process.env.XMEMO_LIVE_SCOPE ?? "live-proof";

function redact(value) {
  if (!value || typeof value !== "string") return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function headers() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    "X-Memory-OS-Agent-ID": "openclaw-live-proof",
    "X-Memory-OS-Agent-Instance-ID": "live-proof-instance",
  };
}

async function request(pathname, options = {}) {
  const url = `${BASE_URL}${pathname}`;
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  const text = await response.text().catch(() => "unknown error");
  if (!response.ok) {
    const error = new Error(`XMemo ${pathname} failed (${response.status}): ${text}`);
    error.status = response.status;
    error.pathname = pathname;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

function log(step, status, detail = "") {
  const icon = status === "ok" ? "✓" : status === "skip" ? "⊘" : status === "warn" ? "⚠" : "✗";
  console.log(`${icon} ${step}${detail ? `: ${detail}` : ""}`);
}

async function proofTokenValidate() {
  const result = await request("/v1/auth/token/validate");
  log("token/validate", "ok", `status=${result.status}`);
  return result;
}

async function proofMemoryStore() {
  const content = `OpenClaw xmemo-memory live proof at ${new Date().toISOString()}`;
  const stored = await request("/v1/remember", {
    method: "POST",
    body: JSON.stringify({
      content,
      path: BUCKET,
      bucket: BUCKET,
      scope: SCOPE,
      memory_type: "semantic",
      importance: 0.7,
      source: "openclaw-live-proof",
    }),
  });
  log("memory_store", "ok", `id=${stored.id}`);
  return { id: stored.id, content };
}

async function proofMemorySearch() {
  const result = await request(
    `/v1/memories/search?query=OpenClaw+xmemo-memory+live+proof&bucket=${encodeURIComponent(BUCKET)}&limit=5`,
  );
  log("memory_search", "ok", `results=${result.results?.length ?? 0}`);
  return result;
}

async function proofMemoryGet(memoryId) {
  let memory;
  let via = "direct";
  try {
    memory = await request(`/v1/memories/${encodeURIComponent(memoryId)}`);
  } catch (error) {
    if (error.status === 404 || error.status === 405) {
      log("memory_get", "warn", "direct GET returned 404/405; using search fallback");
      const fallback = await request(
        `/v1/memories/search?query=${encodeURIComponent(memoryId)}&limit=5`,
      );
      memory = fallback.results?.find((r) => r.id === memoryId);
      via = "search fallback";
    } else {
      throw error;
    }
  }
  if (!memory) {
    throw new Error(`memory_get could not locate stored id ${memoryId}`);
  }
  log("memory_get", "ok", `id=${memory.id} via=${via}`);
  return memory;
}

async function proofMemoryList() {
  const result = await request(
    `/v1/memories/search?query=OpenClaw&bucket=${encodeURIComponent(BUCKET)}&scope=${encodeURIComponent(SCOPE)}&limit=5`,
  );
  log("xmemo_memory_list", "ok", `results=${result.results?.length ?? 0}`);
  return result;
}

async function proofMemoryUpdate(memoryId) {
  const updated = await request(`/v1/memories/${encodeURIComponent(memoryId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      content: "Updated by live proof",
      importance: 0.8,
    }),
  });
  log("xmemo_memory_update", "ok", `id=${updated.id}`);
  return updated;
}

async function proofTodoCreate() {
  const reminder = await request("/v1/reminders", {
    method: "POST",
    body: JSON.stringify({
      content: `live proof task ${Date.now()}`,
      bucket: BUCKET,
      scope: SCOPE,
    }),
  });
  log("xmemo_todo_create", "ok", `id=${reminder.id}`);
  return reminder;
}

async function proofTodoList() {
  const result = await request(
    `/v1/reminders?bucket=${encodeURIComponent(BUCKET)}&scope=${encodeURIComponent(SCOPE)}&item_status=open`,
  );
  log("xmemo_todo_list", "ok", `reminders=${result.reminders?.length ?? 0}`);
  return result;
}

async function proofTodoComplete(reminderId) {
  const completed = await request(`/v1/reminders/${encodeURIComponent(reminderId)}/complete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  log("xmemo_todo_complete", "ok", `id=${completed.id}`);
  return completed;
}

async function proofRecordEvent() {
  const event = await request("/v1/timeline/events", {
    method: "POST",
    body: JSON.stringify({
      content: `live proof test milestone ${Date.now()}`,
      event_type: "milestone",
      bucket: BUCKET,
      scope: SCOPE,
      source: "openclaw-live-proof",
    }),
  });
  log("xmemo_record_event", "ok", `id=${event.id}`);
  return event;
}

async function proofRestartSnapshotSave() {
  const snapshot = await request("/v1/restart/snapshot", {
    method: "POST",
    body: JSON.stringify({
      label: "live-proof",
      bucket: BUCKET,
      scope: SCOPE,
    }),
  });
  log("xmemo_restart_snapshot_save", "ok", `id=${snapshot.id}`);
  return snapshot;
}

async function proofRestartSnapshotRestore(snapshotId) {
  const result = await request("/v1/restart/restore", {
    method: "POST",
    body: JSON.stringify({
      snapshot_id: snapshotId,
      bucket: BUCKET,
      scope: SCOPE,
      restore_state: false,
      record_restore_event: false,
    }),
  });
  log("xmemo_restart_snapshot_restore", "ok", `status=${result.status ?? result.restored}`);
  return result;
}

async function proofLedgerMonthlySummary() {
  const now = new Date();
  try {
    const summary = await request(
      `/v1/me/ledger/monthly-summary?month=${now.getMonth() + 1}&year=${now.getFullYear()}`,
    );
    log("xmemo_ledger_monthly_summary", "ok", `total=${summary.total} ${summary.currency}`);
    return summary;
  } catch (error) {
    if (error.status === 403 || error.status === 401) {
      log("xmemo_ledger_monthly_summary", "skip", "no ledger scope");
      return null;
    }
    throw error;
  }
}

async function proofAuditEvents() {
  try {
    const result = await request("/v1/audit/events?limit=5");
    log("xmemo_audit_events", "ok", `events=${result.events?.length ?? 0}`);
    return result;
  } catch (error) {
    if (error.status === 403 || error.status === 401) {
      log("xmemo_audit_events", "skip", "no audit scope");
      return null;
    }
    throw error;
  }
}

async function proofAuditConsolidation() {
  try {
    const result = await request("/v1/audit/consolidation?limit=5&action_type=summarize");
    log("xmemo_audit_consolidation", "ok", "returned summary");
    return result;
  } catch (error) {
    if (error.status === 403 || error.status === 401) {
      log("xmemo_audit_consolidation", "skip", "no audit scope");
      return null;
    }
    throw error;
  }
}

async function proofMemoryForget(memoryId) {
  await request(`/v1/memories/${encodeURIComponent(memoryId)}/forget`, {
    method: "POST",
    body: JSON.stringify({
      mode: "soft_delete",
      reason: "live proof cleanup",
    }),
  });
  log("memory_forget", "ok", `id=${memoryId}`);
}

async function runProof(name, fn) {
  try {
    return await fn();
  } catch (error) {
    log(name, "error", `${error.status ? `(${error.status}) ` : ""}${error.message}`);
    return { __proofError: true, error };
  }
}

async function main() {
  if (!API_KEY) {
    console.error("Error: XMEMO_KEY (or MEMORY_OS_API_KEY) must be set.");
    process.exit(1);
  }

  console.log("XMemo for OpenClaw — full Phase G live proof");
  console.log(`  baseUrl: ${BASE_URL}`);
  console.log(`  bucket:  ${BUCKET}`);
  console.log(`  scope:   ${SCOPE}`);
  console.log(`  apiKey:  ${redact(API_KEY)}`);
  console.log();

  const cleanupIds = { memory: null, reminder: null, snapshot: null };
  const errors = [];

  await runProof("token/validate", proofTokenValidate);

  const stored = await runProof("memory_store", proofMemoryStore);
  if (stored?.__proofError) {
    errors.push("memory_store");
  } else {
    cleanupIds.memory = stored.id;
  }

  await runProof("memory_search", proofMemorySearch);
  if (cleanupIds.memory) {
    await runProof("memory_get", () => proofMemoryGet(cleanupIds.memory));
  }
  await runProof("xmemo_memory_list", proofMemoryList);
  if (cleanupIds.memory) {
    await runProof("xmemo_memory_update", () => proofMemoryUpdate(cleanupIds.memory));
  }

  const reminder = await runProof("xmemo_todo_create", proofTodoCreate);
  if (reminder?.__proofError) {
    errors.push("xmemo_todo_create");
  } else {
    cleanupIds.reminder = reminder.id;
  }

  await runProof("xmemo_todo_list", proofTodoList);
  if (cleanupIds.reminder) {
    const completed = await runProof("xmemo_todo_complete", () => proofTodoComplete(cleanupIds.reminder));
    if (completed?.__proofError) {
      errors.push("xmemo_todo_complete");
    }
  }

  await runProof("xmemo_record_event", proofRecordEvent);

  const snapshot = await runProof("xmemo_restart_snapshot_save", proofRestartSnapshotSave);
  if (snapshot?.__proofError) {
    errors.push("xmemo_restart_snapshot_save");
  } else {
    cleanupIds.snapshot = snapshot.id;
    await runProof("xmemo_restart_snapshot_restore", () => proofRestartSnapshotRestore(snapshot.id));
  }

  await runProof("xmemo_ledger_monthly_summary", proofLedgerMonthlySummary);
  await runProof("xmemo_audit_events", proofAuditEvents);
  await runProof("xmemo_audit_consolidation", proofAuditConsolidation);

  console.log("\nCleanup:");
  if (cleanupIds.snapshot) {
    log("snapshot", "skip", "no delete endpoint; snapshot will expire naturally");
  }
  if (cleanupIds.reminder) {
    const cleanupResult = await runProof("reminder cleanup", () => proofTodoComplete(cleanupIds.reminder));
    if (cleanupResult?.__proofError) {
      errors.push("reminder_cleanup");
    }
  }
  if (cleanupIds.memory) {
    await runProof("memory_forget", () => proofMemoryForget(cleanupIds.memory));
  }

  console.log();
  if (errors.length > 0) {
    console.log(`Live proof finished with ${errors.length} error(s): ${errors.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Live proof complete. No API key values were printed in full.");
  }
}

main().catch((error) => {
  console.error(`Live proof failed: ${error.message}`);
  process.exit(1);
});
