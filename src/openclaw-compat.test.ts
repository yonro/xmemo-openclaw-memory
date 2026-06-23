import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  asToolParamsRecord,
  fallbackAsToolParamsRecord,
  fallbackResolveLivePluginConfigObject,
  fallbackResolvePluginConfigObject,
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
} from "./openclaw-compat.js";

const pluginConfig = { apiKey: "test-key", autoCapture: true };
const config = {
  plugins: {
    entries: {
      "xmemo-memory": {
        enabled: true,
        config: pluginConfig,
      },
    },
  },
} as OpenClawConfig;

describe("OpenClaw compatibility helpers", () => {
  it("keeps the fallback config resolver behavior aligned with the host helper", () => {
    expect(fallbackResolvePluginConfigObject(config, "xmemo-memory")).toEqual(pluginConfig);
    expect(resolvePluginConfigObject(config, "xmemo-memory")).toEqual(pluginConfig);
  });

  it("rejects malformed plugin config containers", () => {
    expect(fallbackResolvePluginConfigObject(undefined, "xmemo-memory")).toBeUndefined();
    expect(
      fallbackResolvePluginConfigObject(
        { plugins: { entries: { "xmemo-memory": { config: [] } } } } as unknown as OpenClawConfig,
        "xmemo-memory",
      ),
    ).toBeUndefined();
  });

  it("uses startup config only when no runtime loader is available", () => {
    const startup = { apiKey: "startup" };
    expect(
      fallbackResolveLivePluginConfigObject(undefined, "xmemo-memory", startup),
    ).toEqual(startup);
    expect(resolveLivePluginConfigObject(undefined, "xmemo-memory", startup)).toEqual(startup);
  });

  it("prefers live config when a runtime loader is available", () => {
    const startup = { apiKey: "startup" };
    expect(
      fallbackResolveLivePluginConfigObject(() => config, "xmemo-memory", startup),
    ).toEqual(pluginConfig);
    expect(resolveLivePluginConfigObject(() => config, "xmemo-memory", startup)).toEqual(
      pluginConfig,
    );
  });

  it("keeps tool parameter normalization identical for native and fallback paths", () => {
    const params = { query: "project context" };
    expect(fallbackAsToolParamsRecord(params)).toEqual(params);
    expect(asToolParamsRecord(params)).toEqual(params);

    for (const invalid of [undefined, null, "query", 42, []]) {
      expect(fallbackAsToolParamsRecord(invalid)).toEqual({});
      expect(asToolParamsRecord(invalid)).toEqual({});
    }
  });
});
