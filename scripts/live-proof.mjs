#!/usr/bin/env node
// Reproducible live proof for the xmemo-openclaw-memory plugin.
//
// Requires:
//   - Node.js >=22.19 (or the Node version used by OpenClaw)
//   - XMEMO_KEY environment variable set to a valid XMemo API key
//
// This script calls the public XMemo REST endpoints used by the plugin and
// prints a redacted summary. It does not write anything to OpenClaw state.

const BASE_URL = process.env.XMEMO_BASE_URL ?? "https://xmemo.dev";
const API_KEY = process.env.XMEMO_KEY ?? process.env.MEMORY_OS_API_KEY ?? process.env.MEMORY_OS_MCP_TOKEN;
const BUCKET = process.env.XMEMO_LIVE_BUCKET ?? "openclaw-live-proof";

function redact(value) {
  if (!value || typeof value !== "string") return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function headers() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    "X-Memory-OS-Agent-ID": "openclaw-live-proof",
    "X-Memory-OS-Agent-Instance-ID": "live-proof-instance",
  };
}

async function request(pathname, options = {}) {
  const url = `${BASE_URL}${pathname}`;
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });
  const text = await response.text().catch(() => "unknown error");
  if (!response.ok) {
    throw new Error(`XMemo ${pathname} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  if (!API_KEY) {
    console.error("Error: XMEMO_KEY (or MEMORY_OS_API_KEY) must be set.");
    process.exit(1);
  }

  console.log("XMemo OpenClaw memory plugin live proof");
  console.log(`  baseUrl: ${BASE_URL}`);
  console.log(`  bucket:  ${BUCKET}`);
  console.log(`  apiKey:  ${redact(API_KEY)}`);
  console.log();

  // 1. Token validation
  const tokenStatus = await request("/v1/auth/token/validate");
  console.log("1. token/validate:", JSON.stringify(tokenStatus, null, 2));
  console.log();

  // 2. Store a memory
  const storeContent = `OpenClaw xmemo-memory live proof at ${new Date().toISOString()}`;
  const stored = await request("/v1/remember", {
    method: "POST",
    body: JSON.stringify({
      content: storeContent,
      path: BUCKET,
      bucket: BUCKET,
      scope: "live-proof",
      memory_type: "semantic",
      importance: 0.7,
      source: "openclaw-live-proof",
    }),
  });
  console.log("2. memory_store:", JSON.stringify({ id: stored.id, status: stored.status }, null, 2));
  console.log(`   content snippet: "${storeContent.slice(0, 60)}..."`);
  console.log();

  // 3. Search for the memory
  const search = await request(`/v1/memories/search?query=OpenClaw+xmemo-memory+live+proof&bucket=${encodeURIComponent(BUCKET)}&limit=5`);
  console.log("3. memory_search results:", search.results?.length ?? 0);
  for (const result of search.results ?? []) {
    console.log(`   - id: ${result.id}, score: ${result.score ?? "n/a"}`);
  }
  console.log();

  // 4. Recall context
  const recall = await request("/v1/recall/context", {
    method: "POST",
    body: JSON.stringify({
      query: "OpenClaw xmemo-memory live proof",
      bucket: BUCKET,
      scope: "live-proof",
      max_items: 5,
      max_tokens: 1000,
      prefer_working: true,
    }),
  });
  console.log("4. recall/context items:", recall.items?.length ?? 0);
  for (const item of recall.items ?? []) {
    console.log(`   - id: ${item.id}, snippet: "${(item.snippet ?? item.content ?? "").slice(0, 60)}..."`);
  }
  console.log();

  // 5. Read the stored memory back.
  // The hosted XMemo instance does not expose a direct GET /v1/memories/<id>
  // endpoint, so the plugin falls back to search-by-id when it sees 404/405.
  // This block reproduces that fallback exactly.
  if (stored.id) {
    let memory;
    let via = "direct";
    try {
      memory = await request(`/v1/memories/${encodeURIComponent(stored.id)}`);
    } catch (error) {
      if (error instanceof Error && /\(404\)|\(405\)/.test(error.message)) {
        console.log("   direct GET /v1/memories/<id> returned 404/405; falling back to search-by-id");
        const fallback = await request(
          `/v1/memories/search?query=${encodeURIComponent(stored.id)}&limit=5`,
        );
        memory = fallback.results?.find((r) => r.id === stored.id);
        via = "search fallback";
      } else {
        throw error;
      }
    }
    if (!memory) {
      throw new Error(`memory_get could not locate stored id ${stored.id}`);
    }
    console.log(
      "5. memory_get:",
      JSON.stringify({ id: memory.id, path: memory.path, via }, null, 2),
    );
  }

  console.log();
  console.log("Live proof complete. No API key values were printed in full.");
}

main().catch((error) => {
  console.error("Live proof failed:", error.message);
  process.exit(1);
});
