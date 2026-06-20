#!/usr/bin/env node
// Verify the plugin entrypoint can register the expected tools/capabilities/cli
// without needing the full OpenClaw runtime. This is a smoke test for the
// compiled tarball output.

import path from "node:path";
import { pathToFileURL } from "node:url";

const tarballDir = process.argv[2] ?? path.resolve(process.cwd(), "unpacked/package");
const entryPath = pathToFileURL(path.resolve(tarballDir, "dist/index.js")).href;

const registered = {
  tools: [],
  cli: false,
  memoryCapability: false,
  hooks: new Set(),
};

const mockApi = {
  config: { plugins: {} },
  registerTool(tool, _opts) {
    registered.tools.push(tool.name);
  },
  registerCli(_registrar, _opts) {
    registered.cli = true;
  },
  registerMemoryCapability(_capability) {
    registered.memoryCapability = true;
  },
  on(event, _handler) {
    registered.hooks.add(event);
  },
  logger: { info() {}, warn() {} },
  runtime: { config: { current: () => ({ plugins: {} }) } },
};

const plugin = await import(entryPath);
const definition = plugin.default ?? plugin;

if (!definition.register) {
  console.error("FAIL: plugin does not expose register()");
  process.exit(1);
}

definition.register(mockApi);

const expectedTools = [
  "memory_search",
  "memory_get",
  "memory_store",
  "memory_forget",
  "xmemo_memory_list",
  "xmemo_memory_update",
  "xmemo_todo_create",
  "xmemo_todo_list",
  "xmemo_todo_complete",
  "xmemo_record_event",
  "xmemo_restart_snapshot_save",
  "xmemo_restart_snapshot_restore",
  "xmemo_ledger_monthly_summary",
  "xmemo_audit_events",
  "xmemo_audit_consolidation",
];

const missing = expectedTools.filter((t) => !registered.tools.includes(t));
const unexpected = registered.tools.filter((t) => !expectedTools.includes(t));

console.log(`Plugin ID: ${definition.id}`);
console.log(`Kind: ${definition.kind}`);
console.log(`Memory capability: ${registered.memoryCapability}`);
console.log(`CLI registered: ${registered.cli}`);
console.log(`Hooks: ${[...registered.hooks].join(", ") || "none"}`);
console.log(`Tools (${registered.tools.length}): ${registered.tools.join(", ")}`);

if (missing.length > 0) {
  console.error(`FAIL: missing tools: ${missing.join(", ")}`);
  process.exit(1);
}
if (unexpected.length > 0) {
  console.error(`FAIL: unexpected tools: ${unexpected.join(", ")}`);
  process.exit(1);
}
if (!registered.memoryCapability) {
  console.error("FAIL: memory capability not registered");
  process.exit(1);
}
if (!registered.cli) {
  console.error("FAIL: CLI not registered");
  process.exit(1);
}

console.log("\nOK: plugin entrypoint smoke test passed");
