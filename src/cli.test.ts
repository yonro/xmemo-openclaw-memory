import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  applyXMemoKeyConfig,
  buildXMemoEnvCredential,
  saveXMemoSharedCredential,
  saveXMemoKeyConfig,
  type XMemoKeyCredential,
} from "./cli.js";
import { resolveXMemoMemoryConfig, sharedCredentialPath } from "./config.js";

type EntryView = {
  enabled?: boolean;
  config?: Record<string, unknown>;
};

function xmemoEntry(config: OpenClawConfig): EntryView {
  return config.plugins?.entries?.["xmemo-memory"] as EntryView;
}

describe("xmemo CLI key config helpers", () => {
  it("creates the memory slot and apiKey config from an empty config", () => {
    const next = applyXMemoKeyConfig({} as OpenClawConfig, "xmemo_test_key");

    expect(next.plugins?.slots?.memory).toBe("xmemo-memory");
    expect(xmemoEntry(next).enabled).toBe(true);
    expect(xmemoEntry(next).config?.apiKey).toBe("xmemo_test_key");
  });

  it("preserves existing advanced plugin config while replacing deprecated token", () => {
    const source = {
      plugins: {
        slots: {
          contextEngine: "other-context",
        },
        entries: {
          "xmemo-memory": {
            enabled: false,
            config: {
              baseUrl: "https://memory.example",
              bucket: "project-a",
              token: "old-token",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = applyXMemoKeyConfig(source, "xmemo_new_key");

    expect(next.plugins?.slots?.memory).toBe("xmemo-memory");
    expect(next.plugins?.slots?.contextEngine).toBe("other-context");
    expect(xmemoEntry(next).enabled).toBe(true);
    expect(xmemoEntry(next).config).toMatchObject({
      apiKey: "xmemo_new_key",
      baseUrl: "https://memory.example",
      bucket: "project-a",
    });
    expect(xmemoEntry(next).config?.token).toBeUndefined();
    expect(xmemoEntry(source).enabled).toBe(false);
    expect(xmemoEntry(source).config?.token).toBe("old-token");
  });

  it("can configure an env SecretRef credential", () => {
    const credential: XMemoKeyCredential = buildXMemoEnvCredential("XMEMO_KEY");
    const next = applyXMemoKeyConfig({} as OpenClawConfig, credential);

    expect(xmemoEntry(next).config?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "XMEMO_KEY",
    });
  });

  it("rejects invalid env var names", () => {
    expect(() => buildXMemoEnvCredential("not-valid-name")).toThrow(
      "Invalid environment variable name",
    );
  });

  it("persists key config through the focused runtime mutation API", async () => {
    const draft = {} as OpenClawConfig;
    const calls: Array<{
      base?: string;
      afterWrite?: unknown;
    }> = [];
    const api = {
      runtime: {
        config: {
          async mutateConfigFile(params: {
            base?: string;
            afterWrite?: unknown;
            mutate: (draft: OpenClawConfig, context: unknown) => void;
          }) {
            calls.push({ base: params.base, afterWrite: params.afterWrite });
            params.mutate(draft, {});
            return { result: undefined };
          },
        },
      },
    } as unknown as Parameters<typeof saveXMemoKeyConfig>[0];

    await saveXMemoKeyConfig(api, "xmemo_runtime_key");

    expect(calls).toEqual([{ base: "source", afterWrite: { mode: "auto" } }]);
    expect(draft.plugins?.slots?.memory).toBe("xmemo-memory");
    expect(xmemoEntry(draft).config?.apiKey).toBe("xmemo_runtime_key");
  });

  it("stores plaintext setup credentials in the shared XMemo credential contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "xmemo-cli-shared-"));
    try {
      const env = { XMEMO_CONFIG_HOME: root };
      const credentialPath = await saveXMemoSharedCredential("xmemo_shared_key", env);
      const payload = JSON.parse(readFileSync(credentialPath, "utf-8")) as {
        token?: string;
        tokenEnvVar?: string;
        storage?: string;
        metadata?: { source?: string; provider?: string };
      };

      expect(credentialPath).toBe(sharedCredentialPath(env));
      expect(payload).toMatchObject({
        token: "xmemo_shared_key",
        tokenEnvVar: "XMEMO_KEY",
        storage: "user-scoped-credential-file",
        metadata: {
          source: "openclaw-plugin-setup",
          provider: "xmemo-memory",
        },
      });

      const cfg = resolveXMemoMemoryConfig({} as OpenClawConfig, env);
      expect(cfg.apiKey).toBe("xmemo_shared_key");
      expect(cfg.authMode).toBe("bearer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
