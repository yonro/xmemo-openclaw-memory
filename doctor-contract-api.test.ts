import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function getEntryConfig(entry: unknown): Record<string, unknown> & { enabled?: boolean } {
  const record = entry as Record<string, unknown> | undefined;
  return (record?.config ?? {}) as Record<string, unknown> & { enabled?: boolean };
}

function getEntryEnabled(entry: unknown): boolean | undefined {
  const record = entry as Record<string, unknown> | undefined;
  return record?.enabled as boolean | undefined;
}

describe("xmemo-memory doctor contract", () => {
  it("flags legacy plugins.config path", () => {
    const rule = legacyConfigRules.find((r) => r.path.join(".") === "plugins.config.xmemo-memory");
    expect(rule).toBeDefined();
    expect(rule!.message).toContain("plugins.entries");
  });

  it("returns no changes when config is already canonical", () => {
    const cfg = {
      plugins: {
        entries: {
          "xmemo-memory": {
            enabled: true,
            config: { apiKey: "key" },
          },
        },
      },
    };
    const result = normalizeCompatibilityConfig({ cfg: cfg as never });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });

  it("migrates legacy plugins.config to plugins.entries and renames token", () => {
    const cfg = {
      plugins: {
        config: {
          "xmemo-memory": {
            token: "old-token",
            bucket: "openclaw",
          },
        },
        entries: {},
      },
    };
    const result = normalizeCompatibilityConfig({ cfg: cfg as never });

    const xmemoEntry = result.config.plugins?.entries?.["xmemo-memory"];
    expect(xmemoEntry).toBeDefined();
    const config = getEntryConfig(xmemoEntry!);
    expect(config.apiKey).toBe("old-token");
    expect(config.token).toBeUndefined();
    expect(getEntryEnabled(xmemoEntry!)).toBe(true);
    expect((result.config.plugins as Record<string, unknown> | undefined)?.config).toBeUndefined();
  });

  it("preserves other plugins.config keys when migrating xmemo-memory", () => {
    const cfg = {
      plugins: {
        config: {
          "xmemo-memory": {
            token: "old-token",
          },
          "other-plugin": {
            enabled: true,
          },
        },
        entries: {},
      },
    };
    const result = normalizeCompatibilityConfig({ cfg: cfg as never });
    const xmemoEntry = result.config.plugins?.entries?.["xmemo-memory"];
    expect(xmemoEntry).toBeDefined();
    expect(getEntryConfig(xmemoEntry!).apiKey).toBe("old-token");
    expect((result.config.plugins as Record<string, unknown> | undefined)?.config).toEqual({
      "other-plugin": { enabled: true },
    });
  });

  it("does not overwrite existing apiKey when migrating legacy token", () => {
    const cfg = {
      plugins: {
        config: {
          "xmemo-memory": {
            token: "old-token",
          },
        },
        entries: {
          "xmemo-memory": {
            config: {
              apiKey: "new-key",
            },
          },
        },
      },
    };
    const result = normalizeCompatibilityConfig({ cfg: cfg as never });
    const xmemoEntry = result.config.plugins?.entries?.["xmemo-memory"];
    expect(xmemoEntry).toBeDefined();
    expect(getEntryConfig(xmemoEntry!).apiKey).toBe("new-key");
  });
});
