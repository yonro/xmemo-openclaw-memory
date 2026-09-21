#!/usr/bin/env node
/**
 * scripts/evidence-todo-chain.mjs
 *
 * Full-chain evidence script for Bug 4 (TODO lifecycle & visibility)
 * per docs/plans/2026-09-21-openclaw-bug-audit-and-repair-plan.md §3 Bug 4 / §6 S3 / §7 TODO matrix.
 *
 * Executes against live https://xmemo.dev using process.env.XMEMO_KEY:
 * (1) Creates TODO without due_at and TODO with future due_at in isolated test bucket/scope.
 * (2) Queries immediately with default/explicit open/% without calling complete.
 * (3) Performs precise read to verify underlying metadata: item_status, memory_type, status, due_at.
 * (4) Compares plugin tool REST behavior vs direct REST requests.
 * (5) Evaluates boundary cases: spatial isolation, illegal status, pagination limits.
 * (6) Completes and permanently cleans up all created test fixtures.
 */

import { XMemoClient } from "../dist/src/client.js";
import { registerXMemoTools } from "../dist/src/tools.js";

const BASE_URL = process.env.XMEMO_BASE_URL ?? "https://xmemo.dev";
const API_KEY = process.env.XMEMO_KEY ?? process.env.MEMORY_OS_API_KEY;

if (!API_KEY) {
  console.error("FAIL: XMEMO_KEY environment variable is missing.");
  process.exit(1);
}

const runId = `s3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const testBucket = `test-todo-${runId}`;
const testScope = `scope-${runId}`;
const createdIds = [];

const results = {
  runId,
  testBucket,
  testScope,
  timestamp: new Date().toISOString(),
  steps: {},
  passed: true,
  failures: [],
};

function recordStep(name, ok, details = {}) {
  results.steps[name] = { ok, ...details };
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}`);
  if (!ok) {
    results.passed = false;
    results.failures.push({ step: name, details });
  }
}

function headers() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    "X-Memory-OS-Agent-ID": "openclaw-evidence-runner",
    "X-Memory-OS-Agent-Instance-ID": runId,
  };
}

async function directRequest(pathname, options = {}) {
  const url = `${BASE_URL}${pathname}`;
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  const text = await response.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, ok: response.ok, body: json };
}

function createMockApi(bucket, scope) {
  const registeredTools = new Map();
  const api = {
    config: {
      plugins: {
        entries: {
          "xmemo-memory": {
            config: {
              baseUrl: BASE_URL,
              apiKey: API_KEY,
              bucket: bucket,
              scope: scope,
            },
          },
        },
      },
    },
    registerTool: (definition) => {
      registeredTools.set(definition.name, definition);
    },
  };
  registerXMemoTools(api);
  return { api, tools: registeredTools };
}

async function run() {
  console.log("================================================================================");
  console.log(`OpenClaw S3 Bug 4 TODO Full-Chain Evidence Test`);
  console.log(`Run ID:      ${runId}`);
  console.log(`Test Bucket: ${testBucket}`);
  console.log(`Test Scope:  ${testScope}`);
  console.log(`Base URL:    ${BASE_URL}`);
  console.log("================================================================================\n");

  const client = new XMemoClient(
    BASE_URL,
    API_KEY,
    "openclaw-evidence-runner",
    runId,
  );

  const { tools } = createMockApi(testBucket, testScope);
  const todoCreateTool = tools.get("xmemo_todo_create");
  const todoListTool = tools.get("xmemo_todo_list");
  const todoCompleteTool = tools.get("xmemo_todo_complete");

  if (!todoCreateTool || !todoListTool || !todoCompleteTool) {
    recordStep("tool_registration", false, { error: "Required tools not registered" });
    process.exit(1);
  }
  recordStep("tool_registration", true, {
    tools: ["xmemo_todo_create", "xmemo_todo_list", "xmemo_todo_complete"],
  });

  // ---------------------------------------------------------------------------
  // STEP 1: Create TODOs (no due_at vs future due_at)
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 1: Create TODOs (no due_at vs future due_at) ---");
  const contentA = `TODO-A-${runId}-no-due`;
  const contentB = `TODO-B-${runId}-future-due`;
  const futureDueAt = "2026-12-31T23:59:59Z";

  // Create Todo A via plugin tool
  const resA = await todoCreateTool.execute("call-create-a", {
    content: contentA,
  });
  const idA = resA.details?.id;
  if (idA) createdIds.push(idA);

  const step1AOk = Boolean(idA && resA.content?.[0]?.text?.includes(idA));
  recordStep("step_1_create_no_due_at", step1AOk, {
    id: idA,
    content: contentA,
    toolOutput: resA.content?.[0]?.text,
    details: resA.details,
  });

  // Create Todo B via client
  let reminderB;
  try {
    reminderB = await client.createReminder({
      content: contentB,
      bucket: testBucket,
      scope: testScope,
      due_at: futureDueAt,
    });
  } catch (err) {
    reminderB = { error: String(err) };
  }
  const idB = reminderB?.id;
  if (idB) createdIds.push(idB);

  const step1BOk = Boolean(
    idB &&
    (reminderB?.item_status === "open" || reminderB?.status === "open") &&
    reminderB?.due_at === futureDueAt,
  );
  recordStep("step_1_create_future_due_at", step1BOk, {
    id: idB,
    content: contentB,
    due_at: futureDueAt,
    storageSemantics: reminderB,
  });

  if (!step1AOk || !step1BOk) {
    console.error("FAIL: Fixture creation failed, aborting further steps.");
    await cleanup();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // STEP 2: Query immediately under same credentials WITHOUT complete
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 2: Immediate Query (Default / Open / %) Without Complete ---");

  // 2a. Plugin tool default query (no status param -> defaults to "open")
  const pluginDefaultRes = await todoListTool.execute("call-list-default", {});
  const pluginDefaultReminders = pluginDefaultRes.details?.reminders || [];
  const foundAInPluginDefault = pluginDefaultReminders.some((r) => r.id === idA);
  const foundBInPluginDefault = pluginDefaultReminders.some((r) => r.id === idB);
  recordStep("step_2_plugin_default_query", foundAInPluginDefault && foundBInPluginDefault, {
    count: pluginDefaultReminders.length,
    foundA: foundAInPluginDefault,
    foundB: foundBInPluginDefault,
    text: pluginDefaultRes.content?.[0]?.text,
  });

  // 2b. Plugin tool explicit open query
  const pluginOpenRes = await todoListTool.execute("call-list-open", { status: "open" });
  const pluginOpenReminders = pluginOpenRes.details?.reminders || [];
  const foundAInPluginOpen = pluginOpenReminders.some((r) => r.id === idA);
  const foundBInPluginOpen = pluginOpenReminders.some((r) => r.id === idB);
  recordStep("step_2_plugin_explicit_open", foundAInPluginOpen && foundBInPluginOpen, {
    count: pluginOpenReminders.length,
    foundA: foundAInPluginOpen,
    foundB: foundBInPluginOpen,
  });

  // 2c. Plugin tool % (all) query
  const pluginAllRes = await todoListTool.execute("call-list-all", { status: "%" });
  const pluginAllReminders = pluginAllRes.details?.reminders || [];
  const foundAInPluginAll = pluginAllReminders.some((r) => r.id === idA);
  const foundBInPluginAll = pluginAllReminders.some((r) => r.id === idB);
  recordStep("step_2_plugin_all_wildcard", foundAInPluginAll && foundBInPluginAll, {
    count: pluginAllReminders.length,
    foundA: foundAInPluginAll,
    foundB: foundBInPluginAll,
  });

  // 2d. Direct REST open query
  const restOpenRes = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket)}&scope=${encodeURIComponent(testScope)}&item_status=open`,
  );
  const restOpenReminders = restOpenRes.body?.reminders || [];
  const foundAInRestOpen = restOpenReminders.some((r) => r.id === idA);
  const foundBInRestOpen = restOpenReminders.some((r) => r.id === idB);
  recordStep("step_2_direct_rest_open", foundAInRestOpen && foundBInRestOpen, {
    status: restOpenRes.status,
    count: restOpenReminders.length,
    foundA: foundAInRestOpen,
    foundB: foundBInRestOpen,
  });

  // 2e. Direct REST % (all) query
  const restAllRes = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket)}&scope=${encodeURIComponent(testScope)}&item_status=%`,
  );
  const restAllReminders = restAllRes.body?.reminders || [];
  const foundAInRestAll = restAllReminders.some((r) => r.id === idA);
  const foundBInRestAll = restAllReminders.some((r) => r.id === idB);
  recordStep("step_2_direct_rest_all", foundAInRestAll && foundBInRestAll, {
    status: restAllRes.status,
    count: restAllReminders.length,
    foundA: foundAInRestAll,
    foundB: foundBInRestAll,
  });

  // ---------------------------------------------------------------------------
  // STEP 3: Precise Read & Underlying Metadata Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 3: Precise Read & Underlying Metadata Verification ---");

  // Read A
  const explainA = await directRequest(`/v1/memories/${encodeURIComponent(idA)}/explain?include_embedding=false`);
  const memA = explainA.body?.memory || explainA.body;
  const metaA = memA?.metadata || {};
  const step3AOk =
    explainA.status === 200 &&
    memA?.memory_type === "working" &&
    memA?.status === "active" &&
    metaA?.item_kind === "reminder" &&
    metaA?.item_status === "open" &&
    metaA?.due_at === null &&
    memA?.bucket === testBucket;

  recordStep("step_3_metadata_verification_A_no_due", step3AOk, {
    httpStatus: explainA.status,
    memory_type: memA?.memory_type,
    status: memA?.status,
    item_kind: metaA?.item_kind,
    item_status: metaA?.item_status,
    due_at: metaA?.due_at,
    bucket: memA?.bucket,
    scope: memA?.scope,
  });

  // Read B
  const explainB = await directRequest(`/v1/memories/${encodeURIComponent(idB)}/explain?include_embedding=false`);
  const memB = explainB.body?.memory || explainB.body;
  const metaB = memB?.metadata || {};
  const step3BOk =
    explainB.status === 200 &&
    memB?.memory_type === "working" &&
    memB?.status === "active" &&
    metaB?.item_kind === "reminder" &&
    metaB?.item_status === "open" &&
    metaB?.due_at === futureDueAt &&
    memB?.bucket === testBucket;

  recordStep("step_3_metadata_verification_B_future_due", step3BOk, {
    httpStatus: explainB.status,
    memory_type: memB?.memory_type,
    status: memB?.status,
    item_kind: metaB?.item_kind,
    item_status: metaB?.item_status,
    due_at: metaB?.due_at,
    bucket: memB?.bucket,
    scope: memB?.scope,
  });

  // ---------------------------------------------------------------------------
  // STEP 4: Compare Plugin REST Request vs Direct REST
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 4: Compare Plugin REST Request vs Direct REST ---");

  const pluginIds = pluginOpenReminders.map((r) => r.id).sort();
  const restIds = restOpenReminders.map((r) => r.id).sort();
  const diffMissingInPlugin = restIds.filter((id) => !pluginIds.includes(id));
  const diffMissingInRest = pluginIds.filter((id) => !restIds.includes(id));
  const step4Ok = diffMissingInPlugin.length === 0 && diffMissingInRest.length === 0;

  recordStep("step_4_plugin_vs_rest_parity", step4Ok, {
    pluginCount: pluginIds.length,
    restCount: restIds.length,
    diffMissingInPlugin,
    diffMissingInRest,
    parityConfirmed: step4Ok,
  });

  // ---------------------------------------------------------------------------
  // STEP 5: Boundary Cases
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 5: Boundary Cases (Isolation, Illegal Status, Pagination) ---");

  // 5a. Spatial isolation: query non-matching bucket
  const isolatedBucketRes = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket + "-isolated")}&item_status=open`,
  );
  const step5AOk = isolatedBucketRes.body?.reminders?.length === 0;
  recordStep("step_5_spatial_isolation_bucket", step5AOk, {
    queryBucket: testBucket + "-isolated",
    returnedCount: isolatedBucketRes.body?.reminders?.length,
  });

  // 5b. Illegal status query
  const illegalStatusRes = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket)}&scope=${encodeURIComponent(testScope)}&item_status=illegal_status_val`,
  );
  // Service filters rows where row_status == "illegal_status_val", returning 0 items without 500 crash
  const step5BOk = illegalStatusRes.status === 200 && illegalStatusRes.body?.reminders?.length === 0;
  recordStep("step_5_illegal_status_handling", step5BOk, {
    status: illegalStatusRes.status,
    returnedCount: illegalStatusRes.body?.reminders?.length,
  });

  // 5c. Pagination limit boundary: limit=1
  const limit1Res = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket)}&scope=${encodeURIComponent(testScope)}&item_status=open&limit=1`,
  );
  const step5COk = limit1Res.status === 200 && limit1Res.body?.reminders?.length === 1;
  recordStep("step_5_pagination_limit_boundary", step5COk, {
    status: limit1Res.status,
    returnedCount: limit1Res.body?.reminders?.length,
    limit: 1,
  });

  // ---------------------------------------------------------------------------
  // STEP 6: Lifecycle Completion & Complete Cleanup
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 6: Lifecycle Completion & Complete Cleanup ---");

  // Complete Todo A via plugin tool
  const compResA = await todoCompleteTool.execute("call-comp-a", { id: idA });
  const step6AOk = compResA.details?.action === "completed" && compResA.details?.id === idA;
  recordStep("step_6_complete_A_via_tool", step6AOk, {
    toolOutput: compResA.content?.[0]?.text,
    details: compResA.details,
  });

  // Complete Todo B via direct REST
  const compResB = await directRequest(`/v1/reminders/${encodeURIComponent(idB)}/complete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const step6BOk = compResB.status === 200 && (compResB.body?.reminder?.item_status === "completed" || compResB.body?.item_status === "completed");
  recordStep("step_6_complete_B_via_rest", step6BOk, {
    status: compResB.status,
    body: compResB.body,
  });

  // Verify open list is now empty
  const verifyOpenRes = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket)}&scope=${encodeURIComponent(testScope)}&item_status=open`,
  );
  const step6OpenEmptyOk = verifyOpenRes.body?.reminders?.length === 0;
  recordStep("step_6_verify_open_list_empty", step6OpenEmptyOk, {
    openCount: verifyOpenRes.body?.reminders?.length,
  });

  // Verify completed list contains both items
  const verifyCompRes = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket)}&scope=${encodeURIComponent(testScope)}&item_status=completed`,
  );
  const compList = verifyCompRes.body?.reminders || [];
  const foundAInComp = compList.some((r) => r.id === idA);
  const foundBInComp = compList.some((r) => r.id === idB);
  recordStep("step_6_verify_completed_list", foundAInComp && foundBInComp, {
    completedCount: compList.length,
    foundA: foundAInComp,
    foundB: foundBInComp,
  });

  // Permanent cleanup: forget the underlying memories
  await cleanup();

  // Final verification: % list in testBucket should now be empty
  const finalCheckRes = await directRequest(
    `/v1/reminders?bucket=${encodeURIComponent(testBucket)}&scope=${encodeURIComponent(testScope)}&item_status=%`,
  );
  const finalRemaining = finalCheckRes.body?.reminders?.length ?? 0;
  const step6FinalCleanOk = finalRemaining === 0;
  recordStep("step_6_verify_full_cleanup", step6FinalCleanOk, {
    remainingReminders: finalRemaining,
  });

  console.log("\n================================================================================");
  console.log(`Evidence Run Summary: ${results.passed ? "ALL CHECKS PASSED ✓" : "FAILURES DETECTED ✗"}`);
  console.log(`Total Steps: ${Object.keys(results.steps).length}`);
  console.log(`Failures:    ${results.failures.length}`);
  console.log("================================================================================\n");

  if (!results.passed) {
    process.exit(1);
  }
}

async function cleanup() {
  console.log("\n--- Executing Fixture Cleanup ---");
  for (const id of createdIds) {
    try {
      const delRes = await directRequest(`/v1/memories/${encodeURIComponent(id)}/forget`, {
        method: "POST",
        body: JSON.stringify({ mode: "soft_delete", reason: "cleanup after s3 evidence test" }),
      });
      console.log(`  Cleaned up fixture ${id}: status=${delRes.status}`);
    } catch (err) {
      console.warn(`  Warning: failed to delete fixture ${id}:`, err);
    }
  }
}

run().catch(async (err) => {
  console.error("FATAL: Uncaught error in evidence runner:", err);
  await cleanup();
  process.exit(1);
});
