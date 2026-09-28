const SENSITIVE_METADATA_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|secret|sender(?:[_-]?(?:id|ref|hash))?|session(?:[_-]?(?:id|ref|hash))?|actor[_-]?ref|room[_-]?ref|owner[_-]?ref|collection[_-]?ref|agent[_-]?id|binding[_-]?id|barrier)/i;
const IDENTITY_SCOPE_KEY = /(^|_)(agent|sender|session|project|team|bucket|scope|owner|user)(_|$)/;
const CREDENTIAL_TEXT_TEST = /\b(?:bearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]{8,})/i;
const RAW_ID_TEXT_TEST = /\b(?:session[_-]?(?:id|key|ref)|sender[_-]?(?:id|ref))\s*[:=]\s*[^\s,;]{4,}/i;
const SENSITIVE_TEXT_REPLACE = /\b(?:bearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|session[_-]?(?:id|key|ref)|sender[_-]?(?:id|ref))\s*[:=]\s*[^\s,;]{4,})/gi;

export function isPrivateTransferKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return SENSITIVE_METADATA_KEY.test(key) || IDENTITY_SCOPE_KEY.test(normalized);
}

export function sanitizeTransferText(value: string): string {
  return value.replace(SENSITIVE_TEXT_REPLACE, "[REDACTED]");
}

export function sanitizeTransferValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTransferValue);
  if (typeof value === "string") return sanitizeTransferText(value);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isPrivateTransferKey(key)) continue;
    result[key] = sanitizeTransferValue(nested);
  }
  return result;
}

export function containsCredential(value: unknown): boolean {
  if (typeof value === "string") return CREDENTIAL_TEXT_TEST.test(value);
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|secret)/i.test(key)
      || containsCredential(nested));
}

export function containsRawIdentity(value: unknown): boolean {
  if (typeof value === "string") return RAW_ID_TEXT_TEST.test(value);
  if (Array.isArray(value)) return value.some(containsRawIdentity);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const rawIdentityKey = /(^|_)(sender|session)(_(id|ref|key))?(_|$)/.test(normalized)
      && !normalized.endsWith("_hash");
    return rawIdentityKey || containsRawIdentity(nested);
  });
}
