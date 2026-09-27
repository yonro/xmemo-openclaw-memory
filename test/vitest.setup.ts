import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const testRoot = mkdtempSync(join(tmpdir(), "xmemo-vitest-"));
const testHome = join(testRoot, "home");
const testConfigHome = join(testRoot, "config");
const testXdgConfigHome = join(testRoot, "xdg-config");
const testXdgDataHome = join(testRoot, "xdg-data");
const testOpenClawDataDir = join(testRoot, "openclaw-data");

for (const directory of [
  testHome,
  testConfigHome,
  testXdgConfigHome,
  testXdgDataHome,
  testOpenClawDataDir,
]) {
  mkdirSync(directory, { recursive: true });
}

const credentialEnvironmentVariables = [
  "XMEMO_KEY",
  "MEMORY_OS_API_KEY",
  "MEMORY_OS_MCP_TOKEN",
];

const otherXMemoEnvironmentVariables = [
  "XMEMO_BASE_URL",
  "XMEMO_URL",
  "MEMORY_OS_BASE_URL",
  "MEMORY_OS_URL",
  "XMEMO_AGENT_ID",
  "MEMORY_OS_AGENT_ID",
  "XMEMO_AGENT_INSTANCE_ID",
  "MEMORY_OS_AGENT_INSTANCE_ID",
];

const denyUnmockedNetwork: typeof fetch = async () => {
  throw new Error("Unexpected network request in test; mock fetch explicitly.");
};

function isolateTestEnvironment(): void {
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.LOCALAPPDATA = join(testRoot, "local-app-data");
  process.env.XDG_CONFIG_HOME = testXdgConfigHome;
  process.env.XDG_DATA_HOME = testXdgDataHome;
  process.env.OPENCLAW_DATA_DIR = testOpenClawDataDir;
  process.env.XMEMO_CONFIG_HOME = testConfigHome;

  for (const name of [...credentialEnvironmentVariables, ...otherXMemoEnvironmentVariables]) {
    delete process.env[name];
  }

  // Existing tests replace fetch with explicit mocks where network behavior is under test.
  // Reset this guard before each test so a mock from an earlier test cannot leak forward.
  globalThis.fetch = denyUnmockedNetwork;
}

isolateTestEnvironment();
beforeEach(isolateTestEnvironment);
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));
