import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerXMemoTools } from "./tools.js";

function registeredToolSchemas(): Array<{ name: string; parameters: unknown }> {
  const config = { plugins: { entries: { "xmemo-memory": { enabled: true, config: {} } } } };
  const captured: Array<{ name: string; parameters: unknown }> = [];
  const api = {
    config,
    logger: { warn: () => {} },
    lifecycle: { registerRuntimeLifecycle: () => {} },
    registerTool(factory: unknown) {
      const resolved = typeof factory === "function"
        ? (factory as (context: unknown) => unknown)({ config, runtimeConfig: config, getRuntimeConfig: () => config })
        : factory;
      for (const item of Array.isArray(resolved) ? resolved : [resolved]) {
        if (item && typeof item === "object" && "name" in item && "parameters" in item) {
          const tool = item as { name: string; parameters: unknown };
          captured.push({ name: tool.name, parameters: tool.parameters });
        }
      }
    },
  };
  registerXMemoTools(api as never);
  return captured;
}

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
}

describe("public documentation parity", () => {
  it("keeps the manifest, registered tools, and schema catalog in sync", () => {
    const actual = registeredToolSchemas().sort((a, b) => a.name.localeCompare(b.name));
    const manifest = JSON.parse(read("openclaw.plugin.json")) as { contracts: { tools: string[] } };
    const catalog = read("docs/TOOL-CATALOG.md");
    const snapshot = catalog.match(/<!-- BEGIN TOOL SCHEMA SNAPSHOT -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- END TOOL SCHEMA SNAPSHOT -->/)?.[1];
    const summaryRows = new Map(
      [...catalog.matchAll(/^\| `([^`]+)` \|([^\n]*)$/gm)].map(([, name, row]) => [name, row ?? ""]),
    );

    expect(actual).toHaveLength(18);
    expect(actual.map(({ name }) => name).sort()).toEqual([...manifest.contracts.tools].sort());
    expect(snapshot).toBe(JSON.stringify(actual, null, 2));
    expect(catalog).toContain("Required / 必填");
    expect(catalog).toContain("Optional parameters, constraints, and defaults / 可选参数、约束与默认值");
    for (const { name, parameters } of actual) {
      const row = summaryRows.get(name);
      expect(row, `bilingual parameter summary missing ${name}`).toBeDefined();
      const schema = parameters as { properties?: Record<string, unknown> };
      for (const [parameter, rawDefinition] of Object.entries(schema.properties ?? {})) {
        expect(row, `bilingual parameter summary for ${name} is missing ${parameter}`).toContain(`\`${parameter}\``);
        const definition = rawDefinition as { enum?: unknown[]; minimum?: number; maximum?: number; default?: unknown; description?: string };
        for (const option of definition.enum ?? []) {
          expect(row, `bilingual parameter summary for ${name}.${parameter} is missing enum ${String(option)}`).toContain(String(option));
        }
        for (const bound of [definition.minimum, definition.maximum]) {
          if (bound !== undefined) expect(row, `bilingual parameter summary for ${name}.${parameter} is missing bound ${bound}`).toContain(String(bound));
        }
        if (definition.default !== undefined) {
          expect(row, `bilingual parameter summary for ${name}.${parameter} is missing default ${String(definition.default)}`).toContain(String(definition.default));
        }
        const describedDefault = definition.description?.match(/\(default:\s*([^,)]+)/i)?.[1];
        if (describedDefault) {
          expect(row, `bilingual parameter summary for ${name}.${parameter} is missing default ${describedDefault}`).toContain(describedDefault);
        }
      }
    }
  });

  it("lists every live tool and current search/status contract in all public references", () => {
    const actualNames = registeredToolSchemas().map(({ name }) => name);
    const publicDocs = ["README.md", "README_CN.md", "PARITY.md", "docs/PRODUCT-FACTS.md"];

    for (const path of publicDocs) {
      const contents = read(path);
      for (const name of actualNames) expect(contents, `${path} is missing ${name}`).toContain(`\`${name}\``);
      expect(contents, `${path} needs a source-linked schema catalog`).toContain("TOOL-CATALOG.md");
      expect(contents, `${path} needs the 18-tool count`).toMatch(/18\s*(native|tools|个工具|插件工具)/i);
      expect(contents, `${path} needs the real minimum-score field`).toContain("minScore");
      expect(contents, `${path} needs the host search capability contract`).toContain("searchCapabilities");
      expect(contents, `${path} needs the session filter limitation`).toContain("sessionKeyFilter");
      expect(contents, `${path} needs the explicit unsupported source`).toContain("unsupportedSources");
      expect(contents, `${path} needs the status error field`).toContain("lastError");
    }

    for (const path of ["README.md", "README_CN.md", "docs/PRODUCT-FACTS.md"]) {
      const contents = read(path);
      expect(contents).toContain("configured");
      expect(contents).toContain("connected");
      expect(contents).toContain("`backend`");
      expect(contents).toContain("`builtin`");
    }

    expect(read("PARITY.md")).toContain('backend: "builtin"');
    expect(read("PARITY.md")).toContain("兼容映射");
    for (const path of ["README.md", "README_CN.md", "PARITY.md", "docs/PRODUCT-FACTS.md"]) {
      const contents = read(path);
      expect(contents, `${path} needs the scoped SearchManager fail-closed contract`).toContain("readFile");
      expect(contents, `${path} needs the trusted memory_get identity boundary`).toContain("memory_get");
      expect(contents, `${path} needs the experimental local-mode boundary`).toMatch(/experimental|实验/);
    }
  });
});
