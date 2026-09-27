import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveXMemoMemoryConfig, sharedCredentialPath } from "./config.js";

function emptyConfig(): OpenClawConfig {
  return {
    plugins: { entries: { "xmemo-memory": { enabled: true, config: {} } } },
  } as OpenClawConfig;
}

describe("Vitest process isolation", () => {
  it("uses temporary homes and keeps default credential resolution empty", () => {
    const configuredPaths = [
      process.env.HOME,
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME,
      process.env.OPENCLAW_DATA_DIR,
      process.env.XMEMO_CONFIG_HOME,
    ];

    expect(configuredPaths.every((path) => typeof path === "string" && path.length > 0)).toBe(true);
    for (const path of configuredPaths as string[]) {
      expect(relative(tmpdir(), path).startsWith("..")).toBe(false);
    }

    expect(process.env.XMEMO_KEY).toBeUndefined();
    expect(process.env.MEMORY_OS_API_KEY).toBeUndefined();
    expect(process.env.MEMORY_OS_MCP_TOKEN).toBeUndefined();
    expect(sharedCredentialPath({})).toBe(join(process.env.HOME!, ".config", "xmemo", "credentials.json"));

    const config = resolveXMemoMemoryConfig(emptyConfig(), {});
    expect(config.apiKey).toBeUndefined();
    expect(config.credentialSource).toBeUndefined();
  });

  it("rejects external requests unless a test replaces fetch with a mock", async () => {
    await expect(fetch("https://example.invalid")).rejects.toThrow(
      "Unexpected network request in test; mock fetch explicitly.",
    );
  });
});
