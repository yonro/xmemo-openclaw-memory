import { XMemoClientError } from "./client.js";

export type MemorySearchScore = {
  score: number;
  scoreKnown: boolean;
};

export type MemorySearchFailureType =
  | "auth"
  | "request"
  | "timeout"
  | "cancelled"
  | "network"
  | "unavailable"
  | "unknown";

export type MemorySearchFailure = {
  errorType: MemorySearchFailureType;
  status?: number;
};

export const XMEMO_SEARCH_CAPABILITIES = {
  supportedSources: ["memory"],
  sessionKeyFilter: "unsupported",
  unsupportedSources: ["sessions"],
} as const;

type SearchCandidate = {
  status?: unknown;
  score?: unknown;
};

/** Apply the client-side search contract to recall and keyword results. */
export function filterMemorySearchItems<T extends SearchCandidate>(
  items: readonly T[],
  minScore?: number,
): Array<{ index: number; item: T } & MemorySearchScore> {
  const filtered: Array<{ index: number; item: T } & MemorySearchScore> = [];
  for (const [index, item] of items.entries()) {
    if (typeof item.status === "string" && item.status.toLowerCase() === "deleted") continue;

    const scoreKnown = typeof item.score === "number" && Number.isFinite(item.score);
    const score = scoreKnown ? item.score as number : 0;
    if (minScore !== undefined && (!scoreKnown || score < minScore)) continue;

    filtered.push({ index, item, score, scoreKnown });
  }
  return filtered;
}

/** Classify failures identically for the host manager and memory_search tool. */
export function classifyMemorySearchFailure(error: unknown): MemorySearchFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return { errorType: "cancelled" };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { errorType: "timeout" };
  }
  if (error instanceof XMemoClientError && error.status !== undefined) {
    if (error.status === 401 || error.status === 403) {
      return { errorType: "auth", status: error.status };
    }
    if (error.status === 408 || error.status === 504) {
      return { errorType: "timeout", status: error.status };
    }
    if (error.status >= 400 && error.status < 500) {
      return { errorType: "request", status: error.status };
    }
    return { errorType: "unavailable", status: error.status };
  }
  if (error instanceof Error && /ETIMEDOUT|timeout|timed out/i.test(error.message)) {
    return { errorType: "timeout" };
  }
  if (error instanceof Error && /fetch|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|UND_ERR/i.test(error.message)) {
    return { errorType: "network" };
  }
  return { errorType: "unknown" };
}
