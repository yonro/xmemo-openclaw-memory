import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRequire } from "node:module";

type PluginConfigRuntime = {
  resolvePluginConfigObject?: (
    config: OpenClawConfig | undefined,
    pluginId: string,
  ) => Record<string, unknown> | undefined;
  resolveLivePluginConfigObject?: (
    runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined,
    pluginId: string,
    startupPluginConfig?: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
};

type MemoryCoreRuntime = {
  asToolParamsRecord?: (params: unknown) => Record<string, unknown>;
};

function isMissingOptionalExport(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "ERR_REQUIRE_ESM"
  );
}

const requireOptional = createRequire(import.meta.url);

function loadPluginConfigRuntime(): PluginConfigRuntime | undefined {
  try {
    return requireOptional("openclaw/plugin-sdk/plugin-config-runtime") as PluginConfigRuntime;
  } catch (error) {
    if (isMissingOptionalExport(error)) {
      return undefined;
    }
    throw error;
  }
}

const pluginConfigRuntime = loadPluginConfigRuntime();
const memoryCoreRuntime = (() => {
  try {
    return requireOptional("openclaw/plugin-sdk/memory-core-host-runtime-core") as
      | MemoryCoreRuntime
      | undefined;
  } catch (error) {
    if (isMissingOptionalExport(error)) {
      return undefined;
    }
    throw error;
  }
})();

export function fallbackResolvePluginConfigObject(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const plugins =
    config?.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins)
      ? (config.plugins as Record<string, unknown>)
      : undefined;
  const entries =
    plugins?.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)
      ? (plugins.entries as Record<string, unknown>)
      : undefined;
  const entry = entries?.[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const pluginConfig = (entry as { config?: unknown }).config;
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as Record<string, unknown>)
    : undefined;
}

export function resolvePluginConfigObject(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  return pluginConfigRuntime?.resolvePluginConfigObject
    ? pluginConfigRuntime.resolvePluginConfigObject(config, pluginId)
    : fallbackResolvePluginConfigObject(config, pluginId);
}

export function fallbackResolveLivePluginConfigObject(
  runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined,
  pluginId: string,
  startupPluginConfig?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof runtimeConfigLoader !== "function") {
    return startupPluginConfig;
  }
  return fallbackResolvePluginConfigObject(runtimeConfigLoader(), pluginId);
}

export function resolveLivePluginConfigObject(
  runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined,
  pluginId: string,
  startupPluginConfig?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return pluginConfigRuntime?.resolveLivePluginConfigObject
    ? pluginConfigRuntime.resolveLivePluginConfigObject(
        runtimeConfigLoader,
        pluginId,
        startupPluginConfig,
      )
    : fallbackResolveLivePluginConfigObject(runtimeConfigLoader, pluginId, startupPluginConfig);
}

export function fallbackAsToolParamsRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export function asToolParamsRecord(params: unknown): Record<string, unknown> {
  return memoryCoreRuntime?.asToolParamsRecord
    ? memoryCoreRuntime.asToolParamsRecord(params)
    : fallbackAsToolParamsRecord(params);
}
