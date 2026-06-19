// XMemo for OpenClaw plugin entrypoint.
//
// This plugin brings XMemo's identity-aware memory control plane into OpenClaw,
// making XMemo the active long-term memory backend. It implements the OpenClaw
// `kind: "memory"` slot contract by registering a MemoryPluginCapability with
// prompt building, flush planning, and a remote MemorySearchManager backed by
// the XMemo REST API.

import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerXMemoAutoCapture } from "./src/auto-capture.js";
import { registerXMemoCli } from "./src/cli.js";
import { buildXMemoPromptSection } from "./src/prompt-section.js";
import { createXMemoMemoryRuntime } from "./src/runtime.js";
import { registerXMemoTools } from "./src/tools.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "xmemo-memory",
  name: "XMemo for OpenClaw",
  description: "XMemo identity-aware memory control plane for OpenClaw.",
  kind: "memory",
  register(api) {
    api.registerMemoryCapability({
      promptBuilder: buildXMemoPromptSection,
      // XMemo is a remote memory backend; there is no local transcript flush
      // path. Returning null keeps OpenClaw from writing memory files locally.
      flushPlanResolver: () => null,
      runtime: createXMemoMemoryRuntime(api),
    });

    registerXMemoTools(api);
    registerXMemoAutoCapture(api);
    registerXMemoCli(api);
  },
});

export default plugin;
