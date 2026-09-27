import { describe, expect, it } from "vitest";
import { XMemoClientError } from "./client.js";
import { classifyMemorySearchFailure, filterMemorySearchItems } from "./search-policy.js";

describe("shared memory search policy", () => {
  it("filters deleted and below-threshold items and marks absent scores unknown", () => {
    const items = [
      { id: "deleted", status: "deleted", score: 0.99 },
      { id: "below", status: "active", score: 0.2 },
      { id: "above", status: "active", score: 0.95 },
      { id: "unknown", status: "active" },
    ];

    expect(filterMemorySearchItems(items, 0.9)).toMatchObject([
      { index: 2, item: { id: "above" }, score: 0.95, scoreKnown: true },
    ]);
    expect(filterMemorySearchItems(items)).toMatchObject([
      { index: 1, item: { id: "below" }, score: 0.2, scoreKnown: true },
      { index: 2, item: { id: "above" }, score: 0.95, scoreKnown: true },
      { index: 3, item: { id: "unknown" }, score: 0, scoreKnown: false },
    ]);
  });

  it.each([
    [new XMemoClientError("unauthorized", 401), { errorType: "auth", status: 401 }],
    [new XMemoClientError("forbidden", 403), { errorType: "auth", status: 403 }],
    [new XMemoClientError("request timed out", 504), { errorType: "timeout", status: 504 }],
    [Object.assign(new Error("request aborted"), { name: "AbortError" }), { errorType: "cancelled" }],
    [Object.assign(new Error("socket timed out"), { name: "TimeoutError" }), { errorType: "timeout" }],
  ])("classifies search failures consistently (%o)", (error, expected) => {
    expect(classifyMemorySearchFailure(error)).toEqual(expected);
  });
});
