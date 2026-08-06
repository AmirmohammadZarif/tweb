/*
 * Credential redaction for anything leaving the browser as diagnostics.
 *
 * A LEAF module on purpose. Both reporters need it — ./crashReporter (uploads to
 * the CRM) and ./errorTracking (uploads to GlitchTip) — and errorTracking is in
 * turn imported by apiManagerProxy to report forwarded service-worker errors.
 * Keeping redact here breaks what would otherwise be a cycle:
 *   apiManagerProxy -> errorTracking -> crashReporter -> exportLogs -> apiManagerProxy
 * (exportLogs statically imports apiManagerProxy; see ./mountLogExport for why
 * that module graph is delicate.)
 *
 * So: no imports beyond types, ever.
 */

/**
 * Strip anything credential-shaped out of a string.
 *
 * Not a general content scrubber — it cannot tell a customer's message from any
 * other prose, and does not try. Its job is the narrower one of ensuring that
 * things which grant ACCESS (auth keys, bearer tokens, OTP codes) never leave
 * with a diagnostic payload.
 */
export function redact(value: string): string {
  return value
  // NB: the char class must include `|` and `.`. CRM tokens are Sanctum's
  // `<id>|<random>` and a JWT is dot-separated — a `[\w-]` class stops at the
  // separator, matches only the short id, fails the {16,} bound, and silently
  // redacts nothing at all.
  .replace(/(bearer\s+)[A-Za-z0-9|._~+/=-]{16,}/gi, '$1<redacted>')
  .replace(/\b(auth_?key|access_?token|api_?hash|secret|password|otp|code)\b(\s*[:=]\s*)\S+/gi, '$1$2<redacted>')
  // Long hex / base64 blobs: auth keys, session ids, file references.
  .replace(/\b[0-9a-f]{32,}\b/gi, '<redacted:hex>')
  .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<redacted:b64>');
}

/** Walk a value and redact every string in it, bounded in depth. */
export function redactValue(value: any, depth = 0): any {
  if(typeof value === 'string') return redact(value);
  if(depth >= 4 || value === null || typeof value !== 'object') return value;
  if(Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));

  const out: Record<string, any> = {};
  for(const key in value) {
    out[key] = redactValue(value[key], depth + 1);
  }
  return out;
}
