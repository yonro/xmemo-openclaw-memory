import { describe, it, expect } from "vitest";
import {
  tokenizeQuery,
  extractRetrievalHints,
  dedupeAndRank,
} from "./retrieval-strategy.js";

describe("retrieval-strategy", () => {

  describe("tokenizeQuery", () => {
    it("should tokenize mixed Chinese and English queries", () => {
      const tokens = tokenizeQuery("Projects/Xmemo/功能改造");
      expect(tokens).toContain("Projects");
      expect(tokens).toContain("Xmemo");
      expect(tokens).toContain("功能改造");
    });

    it("should tokenize English words with dashes and underscores", () => {
      const tokens = tokenizeQuery("my-cool_project version1");
      expect(tokens).toContain("my-cool_project");
      expect(tokens).toContain("version1");
    });
  });

  describe("extractRetrievalHints", () => {
    it("should extract path-like hints containing slashes", () => {
      const hints = extractRetrievalHints("I want to find Projects/Xmemo/功能改造");
      expect(hints.pathHint).toBe("Projects/Xmemo/功能改造");
    });

    it("should extract known agent names", () => {
      const hints1 = extractRetrievalHints("created by chatgpt agent");
      expect(hints1.agentHint).toBe("chatgpt");

      const hints2 = extractRetrievalHints("using openclaw memory provider");
      expect(hints2.agentHint).toBe("openclaw");

      const hints3 = extractRetrievalHints("written by Codex");
      expect(hints3.agentHint).toBe("codex");
    });

    it("should return undefined if no hints are present", () => {
      const hints = extractRetrievalHints("just a normal query");
      expect(hints.pathHint).toBeUndefined();
      expect(hints.agentHint).toBeUndefined();
    });
  });

  describe("dedupeAndRank", () => {
    it("should deduplicate items by id, keeping the one retrieved by the original query", () => {
      const items = [
        { id: "1", score: 0.5, retrievedByQuery: "免注册", snippet: "match 1" },
        { id: "1", score: 0.9, retrievedByQuery: "自注册", snippet: "match 2" },
      ];
      const ranked = dedupeAndRank(items, "免注册");
      expect(ranked).toHaveLength(1);
      expect(ranked[0].retrievedByQuery).toBe("免注册");
    });

    it("should prefer original-query matches first", () => {
      const items = [
        { id: "2", score: 0.9, retrievedByQuery: "自注册", snippet: "non-orig" },
        { id: "1", score: 0.4, retrievedByQuery: "免注册", snippet: "orig" },
      ];
      const ranked = dedupeAndRank(items, "免注册");
      expect(ranked[0].id).toBe("1");
    });

    it("should prefer path-hint matches when original-query matching status is identical", () => {
      const items = [
        { id: "1", score: 0.8, retrievedByQuery: "自注册", path: "other/path" },
        { id: "2", score: 0.8, retrievedByQuery: "自注册", path: "Projects/Xmemo/功能改造" },
      ];
      const ranked = dedupeAndRank(items, "免注册", "Projects/Xmemo/功能改造");
      expect(ranked[0].id).toBe("2");
    });

    it("should fallback to score when original query and path matching status are identical", () => {
      const items = [
        { id: "1", score: 0.5, retrievedByQuery: "自注册" },
        { id: "2", score: 0.9, retrievedByQuery: "自注册" },
      ];
      const ranked = dedupeAndRank(items, "免注册");
      expect(ranked[0].id).toBe("2");
    });
  });
});
