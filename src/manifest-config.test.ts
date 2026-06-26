// Verifies the plugin manifest config schema matches runtime secret-input handling.
import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as {
  configSchema: JsonSchemaObject;
  contracts?: { tools?: string[] };
  setup?: {
    providers?: Array<{ id?: string; authMethods?: string[]; envVars?: string[] }>;
    requiresRuntime?: boolean;
  };
  toolMetadata?: Record<
    string,
    {
      authSignals?: Array<{ provider?: string }>;
      configSignals?: Array<{ rootPath?: string; requiredAny?: string[] }>;
    }
  >;
  uiHints?: Record<string, { advanced?: boolean; help?: string }>;
};
const packageMetadata = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as {
  homepage?: string;
  xmemo?: {
    role?: string;
    discovery?: string;
    mcpEndpoint?: string;
    openclawConfig?: string;
    productPage?: string;
    chatgptConnection?: string;
    pluginListing?: string;
    companionSkill?: string;
    recommendedMode?: string;
    requiresRuntimePlugin?: boolean;
    skillCanExecuteMemory?: boolean;
    credentialsInDiscovery?: boolean;
    capabilities?: string[];
  };
};
const readme = fs.readFileSync(
  new URL("../README.md", import.meta.url),
  "utf-8",
);

const taggedConfigFields = [
  "baseUrl",
  "apiKey",
  "token",
  "authMode",
  "bucket",
  "scope",
  "teamId",
  "agentId",
  "autoCapture",
  "captureMaxChars",
  "customTriggers",
  "recallMaxChars",
  "recallMaxItems",
  "recallMaxTokens",
] as const;

function validate(value: Record<string, unknown>) {
  return validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "xmemo-memory.manifest.config",
    value,
  });
}

describe("xmemo-memory manifest config schema", () => {
  it("accepts a plain string apiKey", () => {
    const result = validate({ apiKey: "xmemo_test_key" });
    expect(result.ok).toBe(true);
  });

  it("keeps every config field accepted by previous tagged releases", () => {
    const properties = manifest.configSchema.properties as Record<string, unknown> | undefined;
    for (const field of taggedConfigFields) {
      expect(properties?.[field]).toBeDefined();
    }
  });

  it("accepts a legacy tagged config object without migration", () => {
    const result = validate({
      baseUrl: "https://xmemo.dev",
      token: "legacy-token",
      authMode: "api-key",
      bucket: "openclaw",
      scope: "project-a",
      teamId: "team-a",
      agentId: "openclaw",
      autoCapture: true,
      captureMaxChars: 500,
      customTriggers: ["remember this"],
      recallMaxChars: 1000,
      recallMaxItems: 8,
      recallMaxTokens: 1500,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an env SecretRef object for apiKey", () => {
    const result = validate({
      apiKey: { source: "env", provider: "default", id: "XMEMO_KEY" },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an env SecretRef object for the deprecated token alias", () => {
    const result = validate({
      token: { source: "env", provider: "default", id: "XMEMO_KEY" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a SecretRef-like object with a missing provider", () => {
    const result = validate({
      apiKey: { source: "env", id: "XMEMO_KEY" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects file/exec secret sources", () => {
    const fileResult = validate({
      apiKey: { source: "file", provider: "default", id: "xmemo_token" },
    });
    expect(fileResult.ok).toBe(false);

    const execResult = validate({
      apiKey: { source: "exec", provider: "vault", id: "xmemo/key" },
    });
    expect(execResult.ok).toBe(false);
  });

  it("rejects unsupported secret sources", () => {
    const result = validate({
      apiKey: { source: "vault", provider: "default", id: "XMEMO_KEY" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("xmemo-memory public discovery metadata", () => {
  it("exposes a one-field ordinary setup path for OpenClaw", () => {
    expect(manifest.setup).toMatchObject({
      requiresRuntime: false,
      providers: [
        {
          id: "xmemo-memory",
          authMethods: ["api-key", "bearer"],
          envVars: ["XMEMO_KEY", "MEMORY_OS_API_KEY", "MEMORY_OS_MCP_TOKEN"],
        },
      ],
    });

    expect(manifest.uiHints?.apiKey?.advanced).toBeUndefined();
    expect(manifest.uiHints?.apiKey?.help).toContain("XMemo CLI shared credential");
    expect(manifest.uiHints?.baseUrl?.advanced).toBe(true);
    expect(manifest.uiHints?.bucket?.advanced).toBe(true);
    expect(manifest.uiHints?.autoCapture?.advanced).toBe(true);
  });

  it("declares XMemo auth availability for every plugin tool", () => {
    const tools = manifest.contracts?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const toolName of tools) {
      expect(manifest.toolMetadata?.[toolName]).toMatchObject({
        authSignals: [{ provider: "xmemo-memory" }],
        configSignals: [
          {
            rootPath: "plugins.entries.xmemo-memory.config",
            requiredAny: ["apiKey", "token"],
          },
        ],
      });
    }
  });

  it("keeps the XMemo discovery and companion Skill relationship machine-readable", () => {
    expect(packageMetadata.homepage).toBe("https://xmemo.dev");
    expect(packageMetadata.xmemo).toMatchObject({
      role: "openclaw_memory_provider",
      discovery: "https://xmemo.dev/.well-known/agent-discovery.json",
      mcpEndpoint: "https://xmemo.dev/mcp",
      openclawConfig: "https://xmemo.dev/v1/mcp/config/openclaw",
      productPage: "https://xmemo.dev/product/mcp",
      chatgptConnection: "https://xmemo.dev/mcp",
      pluginListing: "https://clawhub.ai/plugins/@xmemo/openclaw-memory",
      companionSkill: "https://clawhub.ai/xmemo/xmemo",
      recommendedMode: "skill_plus_plugin",
      requiresRuntimePlugin: true,
      skillCanExecuteMemory: false,
      credentialsInDiscovery: false,
    });
    expect(packageMetadata.xmemo?.capabilities).toEqual(
      expect.arrayContaining([
        "long_term_memory",
        "semantic_recall",
        "memory_governance",
        "chatgpt_shared_memory",
        "restart_snapshots",
      ]),
    );
  });

  it("keeps README discovery cues clear for OpenClaw and generic MCP clients", () => {
    expect(readme).toContain("https://clawhub.ai/xmemo/xmemo");
    expect(readme).toContain(
      "https://clawhub.ai/plugins/@xmemo/openclaw-memory",
    );
    expect(readme).toContain(
      "https://xmemo.dev/.well-known/agent-discovery.json",
    );
    expect(readme).toContain("https://xmemo.dev/v1/mcp/config/openclaw");
    expect(readme).toContain("https://xmemo.dev/mcp");
    expect(readme).toContain('openclaw xmemo setup "xmemo_..."');
    expect(readme).toContain("openclaw xmemo setup --env XMEMO_KEY");
    expect(readme).toContain("systemctl --user set-environment XMEMO_KEY");
    expect(readme).toContain("XMemo shared user credential");
    expect(readme).toContain("xmemo login");
    expect(readme).not.toContain("openclaw config set plugins.entries.xmemo-memory.config.apiKey");
    expect(readme).toContain("No manual `openclaw.json` editing is required.");
    expect(readme).toContain("Upgrade compatibility");
    expect(readme).toContain("`token` is kept as a compatibility alias");
    expect(readme).toContain('"memory": "xmemo-memory"');
    expect(readme).toContain("The Skill alone cannot execute memory operations.");
    expect(readme).toContain("Shared memory with ChatGPT");
    expect(readme).toContain("ChatGPT's built-in native memory");
  });
});
