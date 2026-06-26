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

function resolveKeyCredential(
  apiKeyArg: string | undefined,
  opts: XMemoKeySetOptions,
): XMemoKeyCredential {
  if (opts.env && apiKeyArg) {
    throw new Error("Pass either an API key or --env, not both.");
  }
  if (opts.env) {
    return buildXMemoEnvCredential(opts.env);
  }
  return trimRequired(apiKeyArg, "XMemo API key");
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
    const credential = resolveKeyCredential(apiKeyArg, opts);

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

export function registerXMemoCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const xmemo = program.command("xmemo").description("XMemo memory commands for OpenClaw");

      xmemo
        .command("setup")
        .description("Configure XMemo memory")
        .argument("[apiKey]", "XMemo API key")
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
        .option("--env <name>", "Use an environment SecretRef instead of storing a plaintext key")
        .option("--dry-run", "Show what would change without writing config")
        .action(async (apiKeyArg: string | undefined, opts: XMemoKeySetOptions) => {
          console.warn(`Deprecated: use \`${SHORT_SETUP_COMMAND}\` instead.`);
          await runKeySetCommand(api, apiKeyArg, opts);
        });

      xmemo
        .command("login")
        .description("Deprecated alias for `xmemo setup`")
        .argument("[apiKey]", "XMemo API key")
        .option("--env <name>", "Use an environment SecretRef instead of storing a plaintext key")
        .option("--dry-run", "Show what would change without writing config")
        .action(async (apiKeyArg: string | undefined, opts: XMemoKeySetOptions) => {
          console.warn(`Deprecated: use \`${SHORT_SETUP_COMMAND}\` instead.`);
          await runKeySetCommand(api, apiKeyArg, opts);
        });

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
                `  Setup: paste an XMemo API key in plugin settings, or run: ${SHORT_SETUP_COMMAND}`,
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
