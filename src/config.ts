import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { resolvePluginConfigObject } from "./openclaw-compat.js";

export type XMemoAuthMode = "api-key" | "bearer" | "both";

export type XMemoMemoryConfig = {
  baseUrl: string;
  apiKey: string | undefined;
  credentialSource?: "config" | "env-secret-ref" | "env" | "shared-credential";
  bucket: string;
  scope: string | undefined;
  readBucket: string;
  readScope: string | undefined;
  teamId: string | undefined;
  agentId: string;
  agentInstanceId: string;
  authMode: XMemoAuthMode;
  autoCapture: boolean;
  captureMaxChars: number;
  customTriggers: string[] | undefined;
  recallMaxChars: number;
  recallMaxItems: number;
  recallMaxTokens: number;
};

export const DEFAULT_BASE_URL = "https://xmemo.dev";
export const DEFAULT_BUCKET = "openclaw";
export const DEFAULT_READ_BUCKET = "%";
export const DEFAULT_AGENT_ID = "openclaw";
export const DEFAULT_AUTH_MODE: XMemoAuthMode = "api-key";

export const API_KEY_ENV_VARS = ["XMEMO_KEY", "MEMORY_OS_API_KEY", "MEMORY_OS_MCP_TOKEN"];
export const BASE_URL_ENV_VARS = [
  "XMEMO_BASE_URL",
  "XMEMO_URL",
  "MEMORY_OS_BASE_URL",
  "MEMORY_OS_URL",
];
export const AGENT_ID_ENV_VARS = ["XMEMO_AGENT_ID", "MEMORY_OS_AGENT_ID"];
export const AGENT_INSTANCE_ID_ENV_VARS = [
  "XMEMO_AGENT_INSTANCE_ID",
  "MEMORY_OS_AGENT_INSTANCE_ID",
];
export const SHARED_CREDENTIAL_FILE = "credentials.json";

type ResolvedCredential = {
  value: string | undefined;
  source?: XMemoMemoryConfig["credentialSource"];
  defaultAuthMode?: XMemoAuthMode;
};

function firstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function normalizeBaseUrl(input: string | undefined): string {
  if (!input) {
    return DEFAULT_BASE_URL;
  }
  let url = input.trim();
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  return url;
}

function normalizeAuthMode(input: string | undefined): XMemoAuthMode {
  if (input === "api-key" || input === "bearer" || input === "both") {
    return input;
  }
  return DEFAULT_AUTH_MODE;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveEnvSecretRef(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const ref = coerceSecretRef(value);
  if (ref && ref.source === "env") {
    return firstEnv(env, [ref.id]);
  }
  return undefined;
}

function configRoot(env: NodeJS.ProcessEnv): string {
  if (env.XMEMO_CONFIG_HOME) {
    return env.XMEMO_CONFIG_HOME;
  }
  if (env.MEMORY_OS_CONFIG_HOME) {
    return env.MEMORY_OS_CONFIG_HOME;
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "XMemo", "CLI");
  }
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "xmemo");
  }
  return join(env.HOME || homedir(), ".config", "xmemo");
}

export function sharedCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configRoot(env), SHARED_CREDENTIAL_FILE);
}

function readSharedCredential(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const raw = readFileSync(sharedCredentialPath(env), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const token = (parsed as { token?: unknown }).token;
    return optionalString(token);
  } catch {
    return undefined;
  }
}

function resolveCredential(
  pluginConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): ResolvedCredential {
  // Prefer the modern `apiKey` config key; fall back to deprecated `token`.
  const fromConfigString =
    normalizeSecretInputString(pluginConfig.apiKey) ??
    normalizeSecretInputString(pluginConfig.token);
  if (fromConfigString) {
    return { value: fromConfigString, source: "config" };
  }

  // Support canonical env SecretRef: { source: "env", provider: "default", id: "XMEMO_KEY" }.
  // We only resolve env refs here; file/exec must not be silently ignored or falsely promised.
  const fromEnvRef =
    resolveEnvSecretRef(pluginConfig.apiKey, env) ??
    resolveEnvSecretRef(pluginConfig.token, env);
  if (fromEnvRef) {
    return { value: fromEnvRef, source: "env-secret-ref" };
  }

  // Environment variables remain the daemon-friendly fallback for OpenClaw services.
  const fromEnv = firstEnv(env, API_KEY_ENV_VARS);
  if (fromEnv) {
    return { value: fromEnv, source: "env" };
  }

  // Last fallback: XMemo's shared user credential contract used by the `xmemo` CLI.
  // Device-login credentials are bearer tokens, so the default auth mode switches
  // to Authorization: Bearer unless the plugin config explicitly overrides it.
  const fromSharedCredential = readSharedCredential(env);
  if (fromSharedCredential) {
    return {
      value: fromSharedCredential,
      source: "shared-credential",
      defaultAuthMode: "bearer",
    };
  }

  return { value: undefined };
}

export function resolveXMemoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBaseUrl(firstEnv(env, BASE_URL_ENV_VARS));
}

export function resolveXMemoAgentId(env: NodeJS.ProcessEnv = process.env): string {
  return firstEnv(env, AGENT_ID_ENV_VARS) ?? DEFAULT_AGENT_ID;
}

let moduleInstanceId: string | undefined;

export function resolveXMemoAgentInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  // Prefer explicit env. OpenClaw plugins should not silently write JSON sidecars;
  // if no stable id is configured, cache a single process-local id so repeated
  // config resolves stay consistent across runtime/tools/cli/hooks.
  const fromEnv = firstEnv(env, AGENT_INSTANCE_ID_ENV_VARS);
  if (fromEnv) {
    return fromEnv;
  }
  moduleInstanceId ??= `xmemo-${randomUUID()}`;
  return moduleInstanceId;
}

export function resolveXMemoMemoryConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): XMemoMemoryConfig {
  // Plugin config lives at plugins.entries["xmemo-memory"].config in resolved OpenClaw config.
  const pluginConfig = resolvePluginConfigObject(cfg, "xmemo-memory") ?? {};
  const credential = resolveCredential(pluginConfig, env);
  const explicitAuthMode = normalizeAuthMode(pluginConfig.authMode as string | undefined);

  return {
    baseUrl: normalizeBaseUrl(
      (pluginConfig.baseUrl as string | undefined) ?? resolveXMemoBaseUrl(env),
    ),
    apiKey: credential.value,
    credentialSource: credential.source,
    bucket: (pluginConfig.bucket as string | undefined) ?? DEFAULT_BUCKET,
    scope: (pluginConfig.scope as string | undefined) ?? undefined,
    readBucket: optionalString(pluginConfig.readBucket) ?? DEFAULT_READ_BUCKET,
    readScope: optionalString(pluginConfig.readScope),
    teamId: (pluginConfig.teamId as string | undefined) ?? undefined,
    agentId: (pluginConfig.agentId as string | undefined) ?? resolveXMemoAgentId(env),
    agentInstanceId: resolveXMemoAgentInstanceId(env),
    authMode:
      typeof pluginConfig.authMode === "string" ? explicitAuthMode : credential.defaultAuthMode ?? explicitAuthMode,
    autoCapture: (pluginConfig.autoCapture as boolean | undefined) ?? false,
    captureMaxChars: (pluginConfig.captureMaxChars as number | undefined) ?? 500,
    customTriggers: Array.isArray(pluginConfig.customTriggers)
      ? (pluginConfig.customTriggers as string[]).filter(
          (s) => typeof s === "string" && s.length > 0,
        )
      : undefined,
    recallMaxChars: (pluginConfig.recallMaxChars as number | undefined) ?? 1000,
    recallMaxItems: (pluginConfig.recallMaxItems as number | undefined) ?? 8,
    recallMaxTokens: (pluginConfig.recallMaxTokens as number | undefined) ?? 1500,
  };
}
