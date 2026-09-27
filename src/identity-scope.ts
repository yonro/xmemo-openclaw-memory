import { createHash } from "node:crypto";
import type { XMemoMemoryConfig } from "./config.js";

export type TrustedIdentityContext = {
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  requesterSenderId?: string | null;
  senderId?: string | null;
};

function normalizedIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function trustedAgentId(
  context: TrustedIdentityContext | undefined,
  configuredAgentId: string,
): string {
  return normalizedIdentity(context?.agentId) ?? configuredAgentId;
}

function opaqueIdentityHash(kind: "session" | "sender", value: string): string {
  return createHash("sha256")
    .update(`xmemo-identity\0${kind}\0${value}`)
    .digest("hex");
}

/** Identity provenance only; these hashes never participate in access filters. */
export function trustedIdentityMetadata(
  context: TrustedIdentityContext | undefined,
  configuredAgentId: string,
): Record<string, string> {
  const sessionId = normalizedIdentity(context?.sessionId) ?? normalizedIdentity(context?.sessionKey);
  const senderId = normalizedIdentity(context?.requesterSenderId) ?? normalizedIdentity(context?.senderId);
  return {
    source_agent: trustedAgentId(context, configuredAgentId),
    ...(sessionId ? { source_session_hash: opaqueIdentityHash("session", sessionId) } : {}),
    ...(senderId ? { source_sender_hash: opaqueIdentityHash("sender", senderId) } : {}),
  };
}

/** Remove caller-supplied identity and scope fields before adding trusted provenance. */
export function sanitizeUntrustedMemoryMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const restrictedIdentityKey = (key: string) => {
    const normalizedKey = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    return /(^|_)(agent|sender|session|project|team|bucket|scope|owner|user)(_|$)/.test(normalizedKey);
  };
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, nestedValue]) =>
        restrictedIdentityKey(key) ? [] : [[key, sanitize(nestedValue)]],
      ),
    );
  };
  return sanitize(metadata) as Record<string, unknown>;
}

export function hasRestrictedReadScope(
  config: Pick<XMemoMemoryConfig, "readBucket" | "readScope" | "teamId">,
): boolean {
  return config.readBucket !== "%" || Boolean(config.readScope) || Boolean(config.teamId);
}
