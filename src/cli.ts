// XMemo plugin CLI commands.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { XMemoClient } from "./client.js";
import { resolveXMemoMemoryConfig, sharedCredentialPath } from "./config.js";
import { XMemoSearchManager } from "./search-manager.js";

const PLUGIN_ID = "xmemo-memory";
const API_KEY_CONFIG_PATH = `plugins.entries.${PLUGIN_ID}.config.apiKey`;
const LONG_API_KEY_SET_COMMAND = `openclaw config set ${API_KEY_CONFIG_PATH} "xmemo_..."`;
const SHORT_SETUP_COMMAND = `openclaw xmemo setup "xmemo_..."`;

export type XMemoKeyCredential =
  | string
  | { source: "env"; provider: "default"; id: string };

type MutablePluginEntry = {
  enabled?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};

type MutablePluginsConfig = {
  slots?: Record<string, unknown>;
  entries?: Record<string, MutablePluginEntry>;
  [key: string]: unknown;
};

type MutableOpenClawConfig = OpenClawConfig & {
  plugins?: MutablePluginsConfig;
};

type XMemoKeySetOptions = {
  env?: string;
  dryRun?: boolean;
  stdin?: boolean;
};

function trimRequired(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

export function buildXMemoEnvCredential(envVar: string): XMemoKeyCredential {
  const id = trimRequired(envVar, "Environment variable name");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
    throw new Error(`Invalid environment variable name: ${id}`);
  }
  return { source: "env", provider: "default", id };
}

function setXMemoKeyConfig(config: OpenClawConfig, credential: XMemoKeyCredential): void {
  const root = config as MutableOpenClawConfig;
  const plugins = root.plugins ?? {};
  const slots = plugins.slots ?? {};
  const entries = plugins.entries ?? {};
  const entry = entries[PLUGIN_ID] ?? {};
  const pluginConfig = entry.config ?? {};

  pluginConfig.apiKey = credential;
  delete pluginConfig.token;
  entry.enabled = true;
  entry.config = pluginConfig;
  entries[PLUGIN_ID] = entry;
  slots.memory = PLUGIN_ID;
  plugins.entries = entries;
  plugins.slots = slots;
  root.plugins = plugins;
}

export function applyXMemoKeyConfig(
  config: OpenClawConfig,
  credential: XMemoKeyCredential,
): OpenClawConfig {
  const next = structuredClone(config) as OpenClawConfig;
  setXMemoKeyConfig(next, credential);
  return next;
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function resolveKeyCredentialFromInput(
  apiKeyArg: string | undefined,
  opts: XMemoKeySetOptions,
  stdinText?: string,
): XMemoKeyCredential {
  const selectedSources = [Boolean(opts.env), Boolean(opts.stdin), Boolean(apiKeyArg)].filter(Boolean).length;
  if (selectedSources > 1) {
    throw new Error("Pass only one credential source: an API key argument, --stdin, or --env.");
  }
  if (opts.env) {
    return buildXMemoEnvCredential(opts.env);
  }
  if (opts.stdin) {
    return trimRequired(stdinText, "XMemo API key from stdin");
  }
  return trimRequired(apiKeyArg, "XMemo API key");
}

async function resolveKeyCredential(
  apiKeyArg: string | undefined,
  opts: XMemoKeySetOptions,
): Promise<XMemoKeyCredential> {
  const stdinText = opts.stdin ? await readStdinText() : undefined;
  return resolveKeyCredentialFromInput(apiKeyArg, opts, stdinText);
}

function describeCredential(credential: XMemoKeyCredential): string {
  return typeof credential === "string" ? "plaintext API key" : `env:${credential.id}`;
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // chmod is best-effort on Windows and some mounted filesystems.
  }
}

export async function saveXMemoSharedCredential(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const credentialPath = sharedCredentialPath(env);
  await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 });
  await bestEffortChmod(dirname(credentialPath), 0o700);
  const payload = {
    version: 1,
    tokenEnvVar: "XMEMO_KEY",
    storage: "user-scoped-credential-file",
    createdAt: new Date().toISOString(),
    metadata: {
      source: "openclaw-plugin-setup",
      provider: PLUGIN_ID,
    },
    token,
  };
  await writeFile(credentialPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await bestEffortChmod(credentialPath, 0o600);
  return credentialPath;
}

export async function saveXMemoKeyConfig(
  api: OpenClawPluginApi,
  credential: XMemoKeyCredential,
): Promise<void> {
  const mutateConfigFile = api.runtime?.config?.mutateConfigFile;
  if (typeof mutateConfigFile !== "function") {
    throw new Error(
      `This OpenClaw host cannot write plugin config from the XMemo CLI. Fallback: ${LONG_API_KEY_SET_COMMAND}`,
    );
  }

  await mutateConfigFile({
    base: "source",
    afterWrite: { mode: "auto" },
    mutate(draft) {
      setXMemoKeyConfig(draft, credential);
    },
  });
}

async function runKeySetCommand(
  api: OpenClawPluginApi,
  apiKeyArg: string | undefined,
  opts: XMemoKeySetOptions,
): Promise<void> {
  try {
    const credential = await resolveKeyCredential(apiKeyArg, opts);

    if (opts.dryRun) {
      applyXMemoKeyConfig(api.config, credential);
      console.log(
        `XMemo setup dry run: would set ${API_KEY_CONFIG_PATH} from ${describeCredential(credential)} and select ${PLUGIN_ID} as the memory slot.`,
      );
      return;
    }

    await saveXMemoKeyConfig(api, credential);
    console.log("XMemo API key configuration saved for xmemo-memory.");
    if (typeof credential === "string") {
      const credentialPath = await saveXMemoSharedCredential(credential);
      console.log(`XMemo shared credential updated for MCP-compatible clients: ${credentialPath}`);
    }
    console.log("Run `openclaw xmemo status` to verify.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

export type DeviceLoginStartResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

export type DeviceLoginTokenResponse = {
  access_token?: string;
  token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  interval?: number;
};

export type DeviceLoginOptions = {
  baseUrl?: string;
  scopes?: string[];
  loginTimeoutMs?: number;
  pollTimeoutMs?: number;
  openBrowser?: boolean;
  dryRun?: boolean;
};

export async function requestDeviceLoginStart(
  baseUrl: string,
  scopes: string[] = [
    "memory:read",
    "memory:write",
    "memory:restore",
    "ledger:write",
    "ledger:read",
  ],
  fetchFn: typeof fetch = fetch,
): Promise<DeviceLoginStartResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/auth/device/start`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "openclaw-xmemo",
      token_type: "mcp_token",
      scopes,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device login start failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as DeviceLoginStartResponse;
  if (!data.device_code || !data.verification_uri) {
    throw new Error("Device login did not return device_code or verification_uri.");
  }
  return data;
}

export async function pollDeviceLoginToken(
  baseUrl: string,
  deviceCode: string,
  start: { interval?: number; expires_in?: number },
  timeoutMs = 600_000,
  fetchFn: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  let intervalSec = start.interval && start.interval > 0 ? start.interval : 5;
  const maxWaitMs = (start.expires_in ?? 600) * 1000;
  const deadline = Date.now() + Math.min(maxWaitMs, timeoutMs);
  const tokenUrl = `${baseUrl.replace(/\/+$/, "")}/api/v1/auth/device/token`;

  while (Date.now() <= deadline) {
    await sleepFn(intervalSec * 1000);

    let body: DeviceLoginTokenResponse;
    try {
      const res = await fetchFn(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      body = (await res.json()) as DeviceLoginTokenResponse;
    } catch {
      // Network hiccup while polling: retry next tick
      continue;
    }

    const token = body.access_token || body.token;
    if (token) {
      return token;
    }

    if (body.error === "authorization_pending") {
      continue;
    }
    if (body.error === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (body.error) {
      throw new Error(`Device authorization failed: ${body.error_description || body.error}`);
    }
  }

  throw new Error("Device authorization expired before approval was received.");
}

export function tryOpenBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    import("node:child_process")
      .then(({ exec }) => {
        exec(cmd, () => {});
      })
      .catch(() => {});
  } catch {
    // Best-effort
  }
}

export async function runDeviceLoginCommand(
  api: OpenClawPluginApi,
  opts: DeviceLoginOptions = {},
): Promise<string | undefined> {
  const cfg = resolveXMemoMemoryConfig(api.config);
  const baseUrl = opts.baseUrl || cfg.baseUrl || "https://xmemo.dev";

  console.log(`Requesting authorization from ${baseUrl}...`);
  const start = await requestDeviceLoginStart(baseUrl, opts.scopes);

  const verifyUrl = start.verification_uri_complete || start.verification_uri;
  console.log("\n" + "=".repeat(64));
  console.log("  XMemo Browser Authorization");
  console.log("=".repeat(64));
  console.log("\n1. Open this URL in your browser:\n");
  console.log(`   \x1b[36m${verifyUrl}\x1b[0m\n`);
  console.log(`2. Confirm the code in your browser: \x1b[1m\x1b[33m${start.user_code}\x1b[0m\n`);
  console.log("Waiting for confirmation in browser... (Press Ctrl+C to cancel)");
  console.log("=".repeat(64) + "\n");

  if (opts.openBrowser !== false) {
    tryOpenBrowser(verifyUrl);
  }

  const token = await pollDeviceLoginToken(
    baseUrl,
    start.device_code,
    start,
    opts.pollTimeoutMs ?? opts.loginTimeoutMs,
  );

  if (opts.dryRun) {
    console.log("Dry run: authorization successful, token acquired (not saved).");
    return token;
  }

  // Persist shared credential first so the token is never lost if host config mutation fails
  const credentialPath = await saveXMemoSharedCredential(token);
  await saveXMemoKeyConfig(api, token);

  console.log("\n\x1b[32m✓ Successfully authenticated with XMemo!\x1b[0m");
  console.log(`✓ API key saved to OpenClaw config (${API_KEY_CONFIG_PATH}).`);
  console.log(`✓ Selected ${PLUGIN_ID} as the active memory slot.`);
  console.log(`✓ Shared credential written: ${credentialPath}`);
  console.log("Run `openclaw xmemo status` to verify.\n");
  return token;
}

export function registerXMemoCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const xmemo = program.command("xmemo").description("XMemo memory commands for OpenClaw");

      xmemo
        .command("setup")
        .description("Configure XMemo memory")
        .argument("[apiKey]", "XMemo API key")
        .option("--stdin", "Read the XMemo API key from stdin instead of a command argument")
        .option("--env <name>", "Use an environment SecretRef instead of storing a plaintext key")
        .option("--dry-run", "Show what would change without writing config")
        .action(async (apiKeyArg: string | undefined, opts: XMemoKeySetOptions) => {
          await runKeySetCommand(api, apiKeyArg, opts);
        });

      const key = xmemo.command("key").description("XMemo API key configuration");
      key
        .command("set")
        .description("Deprecated alias for `xmemo setup`")
        .argument("[apiKey]", "XMemo API key")
        .option("--stdin", "Read the XMemo API key from stdin instead of a command argument")
        .option("--env <name>", "Use an environment SecretRef instead of storing a plaintext key")
        .option("--dry-run", "Show what would change without writing config")
        .action(async (apiKeyArg: string | undefined, opts: XMemoKeySetOptions) => {
          console.warn(`Deprecated: use \`${SHORT_SETUP_COMMAND}\` instead.`);
          await runKeySetCommand(api, apiKeyArg, opts);
        });

      xmemo
        .command("login")
        .description("Log in to XMemo via browser authorization or configure API key")
        .argument("[apiKey]", "Optional XMemo API key. If omitted, launches browser authorization.")
        .option("--token <token>", "XMemo API key or token")
        .option("--stdin", "Read the XMemo API key from stdin")
        .option("--env <name>", "Use an environment SecretRef instead of storing a plaintext key")
        .option("--no-open", "Do not automatically launch the browser")
        .option("--scopes <scopes>", "Comma-separated scopes")
        .option("--base-url <url>", "XMemo service URL override")
        .option("--dry-run", "Show what would change without writing config")
        .action(
          async (
            apiKeyArg: string | undefined,
            opts: XMemoKeySetOptions & {
              token?: string;
              open?: boolean;
              scopes?: string;
              baseUrl?: string;
            },
          ) => {
            const explicitKey = apiKeyArg || opts.token;
            if (explicitKey || opts.stdin || opts.env) {
              await runKeySetCommand(api, explicitKey, opts);
              return;
            }
            try {
              const scopes = opts.scopes
                ? opts.scopes.split(",").map((s) => s.trim()).filter(Boolean)
                : undefined;
              await runDeviceLoginCommand(api, {
                baseUrl: opts.baseUrl,
                scopes,
                openBrowser: opts.open !== false,
                dryRun: opts.dryRun,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`\x1b[31mError:\x1b[0m ${message}`);
              process.exitCode = 1;
            }
          },
        );

      xmemo
        .command("status")
        .description("Show XMemo memory backend status")
        .option("--json", "Output machine-readable JSON")
        .action(async (opts) => {
          const cfg = resolveXMemoMemoryConfig(api.config);
          const configured = Boolean(cfg.apiKey);

          let connected = false;
          let lastError: string | undefined;

          if (configured) {
            const client = new XMemoClient(
              cfg.baseUrl,
              cfg.apiKey!,
              cfg.agentId,
              cfg.agentInstanceId,
              cfg.authMode,
            );
            const manager = new XMemoSearchManager(client, cfg);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
              connected = await manager.probeConnectivity(controller.signal);
            } finally {
              clearTimeout(timeout);
            }
            const status = manager.status();
            if (status.custom && typeof status.custom.lastError === "string") {
              lastError = status.custom.lastError;
            }
          }

          const status = {
            backend: "xmemo",
            provider: "xmemo-memory",
            configured,
            credentialSource: cfg.credentialSource ?? null,
            connected,
            baseUrl: cfg.baseUrl,
            bucket: cfg.bucket,
            scope: cfg.scope,
            teamId: cfg.teamId,
            agentId: cfg.agentId,
            agentInstanceId: cfg.agentInstanceId,
            autoCapture: cfg.autoCapture,
            ...(lastError ? { lastError } : {}),
          };

          if (opts.json) {
            console.log(JSON.stringify(status, null, 2));
          } else {
            console.log(`XMemo memory backend: ${configured ? "configured" : "not configured"}`);
            if (configured) {
              console.log(`  Credential source: ${cfg.credentialSource ?? "unknown"}`);
            }
            console.log(`  Connected: ${connected ? "yes" : "no"}`);
            console.log(`  Base URL: ${status.baseUrl}`);
            console.log(`  Bucket: ${status.bucket}`);
            if (status.scope) {
              console.log(`  Scope: ${status.scope}`);
            }
            if (status.teamId) {
              console.log(`  Team: ${status.teamId}`);
            }
            console.log(`  Agent: ${status.agentId}`);
            console.log(`  Auto capture: ${status.autoCapture}`);
            if (!configured) {
              console.log(
                `  Setup: run \`openclaw xmemo login\` (browser authorization), paste key in settings, or run: ${SHORT_SETUP_COMMAND}`,
              );
            }
            if (lastError) {
              console.log(`  Last error: ${lastError}`);
            }
          }
        });
    },
    {
      descriptors: [
        { name: "xmemo", description: "XMemo memory commands for OpenClaw", hasSubcommands: true },
      ],
    },
  );
}
