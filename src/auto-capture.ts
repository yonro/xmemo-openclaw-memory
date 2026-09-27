// Auto-capture lifecycle hooks for XMemo.
//
// After a successful agent run, inspect user messages for high-signal snippets
// (preferences, decisions, facts, contact info) and store them in XMemo. XMemo
// handles embeddings remotely, so no local vector store is required.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createHash } from "node:crypto";
import { XMemoClient, XMemoClientError } from "./client.js";
import { resolveXMemoMemoryConfig, type XMemoMemoryConfig } from "./config.js";
import { trustedAgentId, trustedIdentityMetadata } from "./identity-scope.js";
import { resolveLivePluginConfigObject } from "./openclaw-compat.js";

type AutoCaptureCursor = {
  nextIndex: number;
  lastMessageFingerprint?: string;
  lastMessageId?: string;
  lastMessageOccurrence?: number;
  nextTextIndex?: number;
};

type AutoCapturePosition = {
  messageIndex: number;
  textIndex: number;
  messageOccurrence: number;
};

const CURSORS = new Map<string, AutoCaptureCursor>();
let terminalCaptureSkipCount = 0;

const LEADING_TIMESTAMP_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const MEDIA_ATTACHED_RE = /\[media attached(?:\s+\d+\/\d+)?:[^\]]*\]/gi;
const ACTIVE_MEMORY_RE = /<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/g;
const UNTRUSTED_CONTEXT_RE = /^Untrusted context \(metadata[\s\S]*$/m;
const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/g;
const SECRET_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxmemo_[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
];

const MEMORY_TRIGGERS = [
  /\b(remember|recall|save this|keep in mind|don't forget|note that)\b/i,
  /\b(prefer|preference|like|love|hate|want|need)\b/i,
  /\b(decided|decision|we will use|let's use|going forward|from now on)\b/i,
  /\b(my name is|i am|my email|my phone|my address|contact me at)\b/i,
  /\b(always|never|important|crucial|critical)\b/i,
  /(记住|记下|保存|不要忘记|注意|喜欢|偏好|讨厌|想要|决定|以后|重要|默认使用)/i,
  /(覚えて|記憶して|忘れないで|好み|いつも|絶対|重要|今後|これから)/i,
  /(기억해|기억해줘|잊지 마|좋아|싫어|항상|절대|중요|앞으로|선호)/i,
];

const NEGATED_CAPTURE_RE =
  /\b(?:don't|do not|please don't)\s+(?:remember|save|store|keep this)\b|(?:不要(?:再)?(?:保存|记录|記錄|记住|記下)|别(?:保存|记录|記錄|记|記)|請勿(?:保存|記錄|記)|请勿(?:保存|记录|记))|(?:保存|記錄|記録|記憶)しないで(?:ください)?|覚えないで(?:ください)?|(?:기억|저장|기록)하지\s*마(?:세요)?|잊어\s*(?:줘|버려)/iu;
const TEMPORARY_REQUEST_RE =
  /\b(?:temporary|temporarily|for now|just for now|only today|for today)\b|(?:今天|今日).{0,12}(?:临时|暫時|暂时)|(?:临时|暫時|暂时).{0,12}(?:需要|要用|要|使用)|(?:今日だけ|一時的に|とりあえず|오늘만|임시로|일시적으로)/iu;
const QUOTED_TEXT_RE = /"[^"\n]*"|'[^'\n]*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》/gu;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function messageFingerprint(message: unknown): string {
  const obj = asRecord(message);
  if (!obj) {
    return `${typeof message}:${String(message)}`;
  }
  try {
    return JSON.stringify({ role: obj.role, content: obj.content });
  } catch {
    return `${String(obj.role)}:${String(obj.content)}`;
  }
}

function messageId(message: unknown): string | undefined {
  const obj = asRecord(message);
  if (!obj) {
    return undefined;
  }
  for (const key of ["id", "messageId", "message_id"]) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return key + ":" + value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return key + ":" + value;
    }
  }
  return undefined;
}

function messageOccurrence(
  messages: unknown[],
  index: number,
  fingerprint = messageFingerprint(messages[index]),
): number {
  let occurrence = 0;
  for (let previous = 0; previous < index; previous += 1) {
    if (messageFingerprint(messages[previous]) === fingerprint) {
      occurrence += 1;
    }
  }
  return occurrence;
}

function findCursorMessageIndex(messages: unknown[], cursor: AutoCaptureCursor): number {
  if (cursor.lastMessageId) {
    const byId = messages.findIndex((message) => messageId(message) === cursor.lastMessageId);
    if (byId >= 0) {
      return byId;
    }
  }
  if (!cursor.lastMessageFingerprint) {
    return -1;
  }

  const matches: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messageFingerprint(messages[index]) === cursor.lastMessageFingerprint) {
      matches.push(index);
    }
  }
  if (matches.length === 0) {
    return -1;
  }
  if (cursor.lastMessageOccurrence !== undefined) {
    if (matches[cursor.lastMessageOccurrence] !== undefined) {
      return matches[cursor.lastMessageOccurrence];
    }
    // History compaction can remove earlier duplicate messages. For a pending
    // candidate, prefer the surviving matching message so the write is retried.
    if (cursor.nextTextIndex !== undefined) {
      return matches[matches.length - 1];
    }
  }
  if (cursor.nextTextIndex === undefined && cursor.nextIndex > 0) {
    const previous = cursor.nextIndex - 1;
    if (messageFingerprint(messages[previous]) === cursor.lastMessageFingerprint) {
      return previous;
    }
  }
  return matches[matches.length - 1];
}

function extractUserTextContent(message: unknown): string[] {
  const obj = asRecord(message);
  if (!obj || obj.role !== "user") {
    return [];
  }

  const content = obj.content;
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const texts: string[] = [];
  for (const block of content) {
    const blockObj = asRecord(block);
    if (blockObj?.type === "text" && typeof blockObj.text === "string") {
      texts.push(blockObj.text);
    }
  }
  return texts;
}

function resolveStartPosition(
  messages: unknown[],
  cursor: AutoCaptureCursor | undefined,
): AutoCapturePosition {
  if (!cursor) {
    return { messageIndex: 0, textIndex: 0, messageOccurrence: 0 };
  }
  if (cursor.lastMessageFingerprint && cursor.nextIndex > 0) {
    const index = findCursorMessageIndex(messages, cursor);
    if (index >= 0) {
      const pending = cursor.nextTextIndex !== undefined;
      return {
        messageIndex: pending ? index : index + 1,
        textIndex: pending ? cursor.nextTextIndex ?? 0 : 0,
        messageOccurrence:
          pending
            ? cursor.lastMessageOccurrence ?? messageOccurrence(messages, index)
            : messageOccurrence(messages, index + 1),
      };
    }
    return { messageIndex: 0, textIndex: 0, messageOccurrence: 0 };
  }
  if (cursor.nextIndex <= messages.length) {
    return {
      messageIndex: cursor.nextIndex,
      textIndex: 0,
      messageOccurrence: messageOccurrence(messages, cursor.nextIndex),
    };
  }
  return { messageIndex: 0, textIndex: 0, messageOccurrence: 0 };
}

function sanitizeForCapture(text: string): string {
  let cleaned = text.length > 10_000 ? text.slice(0, 10_000) : text;
  cleaned = cleaned.replace(LEADING_TIMESTAMP_RE, "");
  cleaned = cleaned.replace(MEDIA_ATTACHED_RE, "");
  cleaned = cleaned.replace(ACTIVE_MEMORY_RE, "");
  cleaned = cleaned.replace(RELEVANT_MEMORIES_RE, "");
  const untrustedMatch = UNTRUSTED_CONTEXT_RE.exec(cleaned);
  if (untrustedMatch?.index !== undefined) {
    cleaned = cleaned.slice(0, untrustedMatch.index);
  }
  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return cleaned;
}

function matchesCustomTrigger(text: string, customTriggers?: string[]): boolean {
  if (!customTriggers || customTriggers.length === 0) {
    return false;
  }
  const lower = text.toLocaleLowerCase();
  return customTriggers.some((trigger) => lower.includes(trigger.toLocaleLowerCase()));
}

function removeQuotedText(text: string): string {
  return text.replace(QUOTED_TEXT_RE, " ");
}

function looksLikeEnvelopeSludge(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    /^Untrusted context \(metadata/m.test(text) ||
    text.includes("(untrusted metadata):") ||
    /\[media attached/i.test(text) ||
    /<active_memory_plugin>/i.test(text) ||
    /<relevant-memories>/i.test(text) ||
    /^\[Channel /m.test(text) ||
    /^Conversation info /m.test(text)
  );
}

function looksLikePromptInjection(text: string): boolean {
  return /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i.test(text);
}

function containsLikelySecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function shouldCapture(
  text: string,
  options: { maxChars: number; customTriggers?: string[] },
): boolean {
  if (looksLikeEnvelopeSludge(text)) {
    return false;
  }
  if (text.length > options.maxChars) {
    return false;
  }
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  if (looksLikePromptInjection(text)) {
    return false;
  }
  if (containsLikelySecret(text)) {
    return false;
  }
  const triggerText = removeQuotedText(text);
  if (NEGATED_CAPTURE_RE.test(triggerText) || TEMPORARY_REQUEST_RE.test(triggerText)) {
    return false;
  }
  const hasTrigger =
    MEMORY_TRIGGERS.some((r) => r.test(triggerText)) ||
    matchesCustomTrigger(triggerText, options.customTriggers);
  if (!hasTrigger) {
    return false;
  }
  if (text.length < 10) {
    return false;
  }
  return true;
}

function captureIdempotencyKey(
  agentId: string,
  agentInstanceId: string,
  cursorKey: string | undefined,
  message: unknown,
  occurrence: number,
  textIndex: number,
  senderId: string | undefined,
): string {
  const stableId = messageId(message);
  const identity = stableId
    ? "id:" + stableId
    : "fingerprint:" + messageFingerprint(message) + "\0" + occurrence;
  return createHash("sha256")
    .update("openclaw-auto-capture\0")
    .update(agentId)
    .update("\0")
    .update(agentInstanceId)
    .update("\0")
    .update(cursorKey ?? "")
    .update("\0")
    .update(identity)
    .update(`\0${textIndex}`)
    .update("\0sender:")
    .update(senderId ?? "")
    .digest("hex");
}

type CaptureFailure =
  | { kind: "permanent"; status: number }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "retryable"; status?: number };

function classifyCaptureFailure(error: unknown): CaptureFailure {
  const status = error instanceof XMemoClientError ? error.status : undefined;
  if (status === 401 || status === 403) {
    return { kind: "auth", status };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { kind: "permanent", status };
  }
  return { kind: "retryable", status };
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (
    /prefer|like|love|hate|want|need|偏好|喜欢|喜歡|讨厌|討厭|愛|好き|嫌い|좋아|싫어|원해|필요/.test(
      lower,
    )
  ) {
    return "preference";
  }
  if (
    /decided|decision|will use|going forward|决定|決定|以后都用|以後都用|これから|앞으로/.test(
      lower,
    )
  ) {
    return "decision";
  }
  if (/my name|email|phone|address|contact|is called|\+\d{10,}|@[\w.-]+\.\w+/.test(lower)) {
    return "entity";
  }
  if (/\b(is|are|has|have|je|má|jsou)\b/i.test(lower)) {
    return "fact";
  }
  return "other";
}

function resolveCurrentConfig(
  api: OpenClawPluginApi,
  startupConfig: XMemoMemoryConfig,
): XMemoMemoryConfig {
  const runtimeLoader = api.runtime?.config?.current
    ? () => api.runtime.config.current() as OpenClawConfig
    : undefined;
  const live = resolveLivePluginConfigObject(runtimeLoader, "xmemo-memory", api.pluginConfig);
  if (!live) {
    return startupConfig;
  }
  return {
    ...startupConfig,
    autoCapture: (live.autoCapture as boolean | undefined) ?? startupConfig.autoCapture,
    captureMaxChars: (live.captureMaxChars as number | undefined) ?? startupConfig.captureMaxChars,
    customTriggers: Array.isArray(live.customTriggers)
      ? (live.customTriggers as string[])
      : startupConfig.customTriggers,
  };
}

function buildClient(cfg: XMemoMemoryConfig, agentId = cfg.agentId): XMemoClient | null {
  if (!cfg.apiKey) {
    return null;
  }
  return new XMemoClient(cfg.baseUrl, cfg.apiKey, agentId, cfg.agentInstanceId, cfg.authMode);
}

export function registerXMemoAutoCapture(api: OpenClawPluginApi): void {
  const startupConfig = resolveXMemoMemoryConfig(api.config);

  api.on("agent_end", async (event, ctx) => {
    const cfg = resolveCurrentConfig(api, startupConfig);
    if (!cfg.autoCapture) {
      return;
    }
    if (!event.success || !event.messages || event.messages.length === 0) {
      return;
    }

    const agentId = trustedAgentId(ctx, cfg.agentId);
    const sessionIdentity =
      (typeof ctx.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : undefined) ??
      (typeof ctx.sessionId === "string" && ctx.sessionId.trim() ? ctx.sessionId.trim() : undefined);
    const cursorKey = sessionIdentity ? `${agentId}\0${sessionIdentity}` : undefined;
    const client = buildClient(cfg);
    if (!client) {
      return;
    }

    const startPosition = resolveStartPosition(
      event.messages,
      cursorKey ? CURSORS.get(cursorKey) : undefined,
    );

    let stored = 0;
    let capturableSeen = 0;

    let stoppedAtPendingCapture = false;
    for (let index = startPosition.messageIndex; index < event.messages.length; index += 1) {
      const message = event.messages[index];
      const fingerprint = messageFingerprint(message);
      const occurrence =
        index === startPosition.messageIndex
          ? startPosition.messageOccurrence
          : messageOccurrence(event.messages, index, fingerprint);
      const stableId = messageId(message);
      const textBlocks = extractUserTextContent(message);
      const firstTextIndex = index === startPosition.messageIndex ? startPosition.textIndex : 0;

      for (let textIndex = firstTextIndex; textIndex < textBlocks.length; textIndex += 1) {
        const sanitized = sanitizeForCapture(textBlocks[textIndex]);
        if (
          !sanitized ||
          !shouldCapture(sanitized, {
            maxChars: cfg.captureMaxChars,
            customTriggers: cfg.customTriggers,
          })
        ) {
          continue;
        }

        if (capturableSeen >= 3) {
          if (cursorKey) {
            CURSORS.set(cursorKey, {
              nextIndex: index,
              lastMessageFingerprint: fingerprint,
              lastMessageId: stableId,
              lastMessageOccurrence: occurrence,
              nextTextIndex: textIndex,
            });
          }
          stoppedAtPendingCapture = true;
          break;
        }
        capturableSeen += 1;

        const category = detectCategory(sanitized);
        const idempotencyKey = captureIdempotencyKey(
          agentId,
          cfg.agentInstanceId,
          cursorKey,
          message,
          occurrence,
          textIndex,
          typeof ctx.senderId === "string" && ctx.senderId.trim() ? ctx.senderId.trim() : undefined,
        );
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          await client.replayWrite(
            "/v1/remember",
            "POST",
            {
              content: sanitized,
              path: cfg.bucket,
              bucket: cfg.bucket,
              scope: cfg.scope ?? null,
              team_id: cfg.teamId ?? null,
              memory_type: "auto",
              importance: 0.7,
              source: "openclaw-auto-capture",
              metadata: {
                category,
                ...trustedIdentityMetadata(ctx, cfg.agentId),
              },
            },
            idempotencyKey,
            controller.signal,
          );
          stored += 1;
        } catch (err) {
          const failure = classifyCaptureFailure(err);
          if (failure.kind === "permanent") {
            terminalCaptureSkipCount += 1;
            api.logger.warn(
              JSON.stringify({
                event: "xmemo_auto_capture_terminal_skip",
                status: failure.status,
                idempotency_key: idempotencyKey,
                terminal_skip_count: terminalCaptureSkipCount,
              }),
            );
            continue;
          }
          api.logger.warn(
            JSON.stringify({
              event:
                failure.kind === "auth"
                  ? "xmemo_auto_capture_auth_blocked"
                  : "xmemo_auto_capture_retry_deferred",
              status: failure.status ?? null,
              idempotency_key: idempotencyKey,
              retryable: true,
            }),
          );
          if (cursorKey) {
            CURSORS.set(cursorKey, {
              nextIndex: index,
              lastMessageFingerprint: fingerprint,
              lastMessageId: stableId,
              lastMessageOccurrence: occurrence,
              nextTextIndex: textIndex,
            });
          }
          stoppedAtPendingCapture = true;
          break;
        } finally {
          clearTimeout(timeout);
        }
      }

      if (!stoppedAtPendingCapture && cursorKey) {
        CURSORS.set(cursorKey, {
          nextIndex: index + 1,
          lastMessageFingerprint: fingerprint,
          lastMessageId: stableId,
          lastMessageOccurrence: occurrence,
        });
      }
      if (stoppedAtPendingCapture) break;
    }

    if (stored > 0) {
      api.logger.info(`xmemo-memory: auto-captured ${stored} memories`);
    }
  });

  api.on("session_end", (_event, ctx) => {
    const cfg = resolveCurrentConfig(api, startupConfig);
    const agentId = trustedAgentId(ctx, cfg.agentId);
    const sessionIdentity =
      (typeof ctx.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : undefined) ??
      (typeof ctx.sessionId === "string" && ctx.sessionId.trim() ? ctx.sessionId.trim() : undefined);
    const cursorKey = sessionIdentity ? `${agentId}\0${sessionIdentity}` : undefined;
    if (cursorKey) {
      CURSORS.delete(cursorKey);
    }
  });
}
