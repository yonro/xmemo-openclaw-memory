import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  applyXMemoKeyConfig,
  buildXMemoEnvCredential,
  pollDeviceLoginToken,
  requestDeviceLoginStart,
  registerXMemoCli,
  readXMemoLocalStatus,
  resolveKeyCredentialFromInput,
  runDeviceLoginCommand,
  saveXMemoSharedCredential,
  saveXMemoKeyConfig,
  type XMemoKeyCredential,
} from "./cli.js";
import { resolveXMemoMemoryConfig, sharedCredentialPath } from "./config.js";
import { LocalMemoryKernel } from "./local/kernel.js";
import { trustedLocalIdentity } from "./memory-service.js";

class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  handler?: (...args: unknown[]) => unknown;

  constructor(readonly name = "root") {}
  command(name: string) {
    const command = new FakeCommand(name);
    this.children.set(name, command);
    return command;
  }
  description() { return this; }
  argument() { return this; }
  option() { return this; }
  requiredOption() { return this; }
  action(handler: (...args: unknown[]) => unknown) { this.handler = handler; return this; }
}

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

  it("can read a plaintext setup credential from stdin input", () => {
    expect(resolveKeyCredentialFromInput(undefined, { stdin: true }, "xmemo_stdin_key\n")).toBe(
      "xmemo_stdin_key",
    );
  });

  it("rejects ambiguous stdin setup options", () => {
    expect(() => resolveKeyCredentialFromInput("xmemo_arg_key", { stdin: true }, "xmemo_stdin_key")).toThrow(
      "Pass only one credential source",
    );
    expect(() => resolveKeyCredentialFromInput(undefined, { env: "XMEMO_KEY", stdin: true }, "xmemo_stdin_key")).toThrow(
      "Pass only one credential source",
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

  describe("device code browser authorization", () => {
    it("requests device login start and parses returned endpoints", async () => {
      const mockFetch = async (input: unknown, init?: unknown) => {
        expect(String(input)).toBe("https://xmemo.dev/api/v1/auth/device/start");
        const body = JSON.parse((init as { body?: string })?.body || "{}");
        expect(body).toMatchObject({
          client_id: "openclaw-xmemo",
          token_type: "mcp_token",
          scopes: ["memory:read", "memory:write"],
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "dev_123",
            user_code: "USER-456",
            verification_uri: "https://xmemo.dev/device-login",
            verification_uri_complete: "https://xmemo.dev/device-login?user_code=USER-456",
            expires_in: 300,
            interval: 2,
          }),
        } as Response;
      };

      const start = await requestDeviceLoginStart(
        "https://xmemo.dev",
        ["memory:read", "memory:write"],
        mockFetch as unknown as typeof fetch,
      );

      expect(start.device_code).toBe("dev_123");
      expect(start.user_code).toBe("USER-456");
      expect(start.verification_uri_complete).toBe("https://xmemo.dev/device-login?user_code=USER-456");
    });

    it("polls until authorization is granted", async () => {
      let pollCount = 0;
      const sleepDelays: number[] = [];

      const mockFetch = async (input: unknown, _init?: unknown) => {
        expect(String(input)).toBe("https://xmemo.dev/api/v1/auth/device/token");
        pollCount++;
        if (pollCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ error: "authorization_pending" }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "xmemo_polled_token_abc" }),
        } as Response;
      };

      const mockSleep = async (ms: number) => {
        sleepDelays.push(ms);
      };

      const token = await pollDeviceLoginToken(
        "https://xmemo.dev",
        "dev_123",
        { interval: 2, expires_in: 30 },
        10_000,
        mockFetch as unknown as typeof fetch,
        mockSleep,
      );

      expect(token).toBe("xmemo_polled_token_abc");
      expect(pollCount).toBe(2);
      expect(sleepDelays).toEqual([2000, 2000]);
    });

    it("throws when device authorization fails with an error", async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ error: "access_denied", error_description: "User rejected login" }),
        } as Response;
      };

      await expect(
        pollDeviceLoginToken(
          "https://xmemo.dev",
          "dev_123",
          { interval: 1, expires_in: 10 },
          5_000,
          mockFetch as unknown as typeof fetch,
          async () => {},
        ),
      ).rejects.toThrow("Device authorization failed: User rejected login");
    });

    it("runDeviceLoginCommand logs verifyUrl and user_code without invoking child processes or auto-opening browser", async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });

      const mockFetch = async (input: unknown) => {
        const urlStr = String(input);
        if (urlStr.endsWith("/api/v1/auth/device/start")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              device_code: "dev_test_abc",
              user_code: "CODE-XYZ-123",
              verification_uri: "https://xmemo.dev/device-login",
              verification_uri_complete: "https://xmemo.dev/device-login?user_code=CODE-XYZ-123",
              expires_in: 300,
              interval: 1,
            }),
          } as Response;
        }
        if (urlStr.endsWith("/api/v1/auth/device/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "xmemo_test_device_token",
            }),
          } as Response;
        }
        throw new Error(`Unexpected url: ${urlStr}`);
      };

      const mockApi = {
        config: {},
      } as unknown as Parameters<typeof runDeviceLoginCommand>[0];

      try {
        const token = await runDeviceLoginCommand(mockApi, {
          dryRun: true,
          fetchFn: mockFetch as unknown as typeof fetch,
          sleepFn: async () => {},
        });

        expect(token).toBe("xmemo_test_device_token");

        const combinedOutput = logs.join("\n");
        expect(combinedOutput).toContain("https://xmemo.dev/device-login?user_code=CODE-XYZ-123");
        expect(combinedOutput).toContain("CODE-XYZ-123");
        expect(combinedOutput).toContain("Open this URL in your browser");
        expect(combinedOutput).toContain("Confirm the code in your browser");

        // Verify tryOpenBrowser is completely removed and cli.ts has zero child_process references
        const cliModule = await import("./cli.js");
        expect((cliModule as Record<string, unknown>).tryOpenBrowser).toBeUndefined();

        const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf-8");
        expect(cliSource).not.toContain("child_process");
        expect(cliSource).not.toContain("tryOpenBrowser");
        expect(cliSource).not.toContain("exec(");
        expect(cliSource).not.toContain("spawn(");
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

describe("xmemo local CLI", () => {
  it("reports local readiness without networking and exposes preview, import, and export commands", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "xmemo-local-cli-"));
    const outputPath = join(dataDir, "export.jsonl");
    const ledgerPath = join(dataDir, "legacy-import.jsonl");
    const recallCachePath = join(dataDir, "recall-cache.json");
    const writeOutboxPath = join(dataDir, "write-outbox.json");
    const network = vi.fn(() => { throw new Error("network blocked in local CLI test"); });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPENCLAW_DATA_DIR", dataDir);
    vi.stubEnv("XMEMO_KEY", "configured-cloud-key-must-not-be-used");
    global.fetch = network as unknown as typeof fetch;
    try {
      const config = {
        plugins: {
          entries: {
            "xmemo-memory": { enabled: true, config: { mode: "local", apiKey: "configured-cloud-key", agentId: "agent-cli" } },
          },
        },
      } as unknown as OpenClawConfig;
      const kernel = await LocalMemoryKernel.open();
      try {
        await kernel.create({ body: "cli export violet note", title: "Export sample" }, trustedLocalIdentity({ agentId: "agent-cli" }, "agent-cli"));
      } finally {
        await kernel.close();
      }

      const status = await readXMemoLocalStatus(resolveXMemoMemoryConfig(config));
      expect(status).toMatchObject({ mode: "local", providerReadiness: "ready", pendingPhysicalCleanup: 0, autoCapture: false, networkAccess: "none" });
      expect(status.vaultPath).toContain("local-vault.sqlite");
      expect(network).not.toHaveBeenCalled();

      const program = new FakeCommand();
      const api = {
        config,
        registerCli(callback: (input: { program: FakeCommand }) => void) { callback({ program }); },
      };
      registerXMemoCli(api as never);
      const xmemo = program.children.get("xmemo")!;
      const captured: unknown[] = [];
      logSpy.mockImplementation((value?: unknown) => captured.push(value));

      await xmemo.children.get("status")!.handler?.({ json: true });
      const statusOutput = JSON.parse(String(captured.pop())) as Record<string, unknown>;
      expect(statusOutput).toMatchObject({ mode: "local", providerReadiness: "ready", networkAccess: "none" });

      const hybridProgram = new FakeCommand();
      const hybridConfig = {
        plugins: { entries: { "xmemo-memory": { enabled: true, config: { mode: "hybrid", apiKey: "configured-cloud-key" } } } },
      } as unknown as OpenClawConfig;
      registerXMemoCli({
        config: hybridConfig,
        registerCli(callback: (input: { program: FakeCommand }) => void) { callback({ program: hybridProgram }); },
      } as never);
      await hybridProgram.children.get("xmemo")!.children.get("status")!.handler?.({ json: true });
      expect(JSON.parse(String(captured.pop()))).toMatchObject({ mode: "hybrid", error: "capability_unavailable", networkAccess: "none" });

      await xmemo.children.get("export")!.handler?.({ output: outputPath, json: true });
      const exportResult = JSON.parse(String(captured.pop())) as Record<string, unknown>;
      expect(exportResult).toMatchObject({ records: 1, outputPath });
      expect(readFileSync(outputPath, "utf8")).toContain("cli export violet note");
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);

      const cacheBytes = JSON.stringify({ version: 1, entries: {} });
      const outboxBytes = JSON.stringify({ version: 1, records: {} });
      writeFileSync(recallCachePath, cacheBytes);
      writeFileSync(writeOutboxPath, outboxBytes);
      await xmemo.children.get("import-preview")!.handler?.({ recallCache: recallCachePath, writeOutbox: writeOutboxPath, json: true });
      expect(JSON.parse(String(captured.pop()))).toMatchObject({ totalSourceEntries: 0 });
      await xmemo.children.get("import")!.handler?.({ recallCache: recallCachePath, writeOutbox: writeOutboxPath, ledger: ledgerPath, json: true });
      expect(JSON.parse(String(captured.pop()))).toMatchObject({ imported: 0, quarantined: 0, skipped: 0, reconciled: true });
      expect(readFileSync(recallCachePath, "utf8")).toBe(cacheBytes);
      expect(readFileSync(writeOutboxPath, "utf8")).toBe(outboxBytes);
      expect(network).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
