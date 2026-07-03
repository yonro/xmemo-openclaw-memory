export type RetrievalTrace = {
  originalQuery: string;
  pathHint?: string;
  agentHint?: string;
  strategies: Array<{
    name: string;
    query?: string;
    path?: string;
    count: number;
    fromCache?: boolean;
    error?: string;
  }>;
};

/**
 * Split query into alphanumeric words and Chinese character blocks.
 */
export function tokenizeQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const regex = /[\u4e00-\u9fa5]+|[a-zA-Z0-9_-]+/g;
  const matches = trimmed.match(regex);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Extract path and agent hints from the query.
 */
export function extractRetrievalHints(query: string): {
  pathHint?: string;
  agentHint?: string;
} {
  const trimmed = query.trim();
  let pathHint: string | undefined;
  let agentHint: string | undefined;

  // Extract path hint: look for slash-separated segments.
  const pathRegex = /[a-zA-Z0-9_.\u4e00-\u9fa5]+(?:\/[a-zA-Z0-9_.\u4e00-\u9fa5]+)+/g;
  const pathMatches = trimmed.match(pathRegex);
  if (pathMatches && pathMatches.length > 0) {
    pathHint = pathMatches[0];
  }

  // Extract agent hint: look for known agent names.
  const agentNames = ["chatgpt", "openclaw", "codex", "gemini", "claude"];
  const lowerQuery = trimmed.toLowerCase();
  for (const name of agentNames) {
    if (new RegExp(`\\b${name}\\b`, "i").test(trimmed) || lowerQuery.includes(name)) {
      agentHint = name;
      break;
    }
  }

  return { pathHint, agentHint };
}

/**
 * Deduplicate search results by id and rank them.
 * Prefers original-query results, then path-hint matches, then higher score.
 */
export function dedupeAndRank(
  items: Array<any>,
  originalQuery: string,
  pathHint?: string
): Array<any> {
  const seen = new Set<string>();
  const uniqueItems: Array<any> = [];

  for (const item of items) {
    const id = item.id;
    if (!id) continue;
    if (!seen.has(id)) {
      seen.add(id);
      uniqueItems.push(item);
    } else {
      const existingIndex = uniqueItems.findIndex(x => x.id === id);
      if (existingIndex !== -1) {
        const existing = uniqueItems[existingIndex];
        const newIsOriginal = item.retrievedByQuery === originalQuery;
        const oldIsOriginal = existing.retrievedByQuery === originalQuery;
        if (
          (newIsOriginal && !oldIsOriginal) ||
          (newIsOriginal === oldIsOriginal && (item.score || 0) > (existing.score || 0))
        ) {
          uniqueItems[existingIndex] = item;
        }
      }
    }
  }

  uniqueItems.sort((a, b) => {
    const aIsOriginal = a.retrievedByQuery === originalQuery;
    const bIsOriginal = b.retrievedByQuery === originalQuery;

    if (aIsOriginal && !bIsOriginal) return -1;
    if (!aIsOriginal && bIsOriginal) return 1;

    if (pathHint) {
      const aPathMatches = a.path && a.path.toLowerCase().includes(pathHint.toLowerCase());
      const bPathMatches = b.path && b.path.toLowerCase().includes(pathHint.toLowerCase());
      if (aPathMatches && !bPathMatches) return -1;
      if (!aPathMatches && bPathMatches) return 1;
    }

    const aScore = typeof a.score === "number" ? a.score : 0;
    const bScore = typeof b.score === "number" ? b.score : 0;
    return bScore - aScore;
  });

  return uniqueItems;
}
