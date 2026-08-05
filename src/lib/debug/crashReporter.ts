/*
 * Main-thread-only: on an uncaught error, upload the crash plus the tail of the
 * merged log ring buffer (window + MTProto worker + service worker) to the CRM
 * at POST /api/mobile/client-logs.
 *
 * Why this exists: tweb ships as static files, so a JS crash in an agent's
 * browser previously left no trace anywhere on our side — the ring buffer died
 * with the tab and `window.downloadLogs()` only helps if someone thinks to ask.
 *
 * Placement rules (same reasoning as ./mountLogExport, read that first): this
 * module statically imports ./exportLogs' collector via a DYNAMIC import, and is
 * itself imported only from src/index.ts. exportLogs pulls in apiManagerProxy,
 * and Vite walks the full module graph of every worker entry — a static path
 * from a worker-reachable module to exportLogs reintroduces the
 * "Circular worker imports detected" build failure.
 *
 * Hard constraint: nothing here may throw. This code runs FROM the global error
 * handler, so an error escaping it re-enters that handler and loops.
 */

import rootScope from '@lib/rootScope';
import App from '@config/app';
import {MOUNT_CLASS_TO} from '@config/debug';
import type {CrmClientLogReason} from '@lib/crm/types';
import type {LogEntry} from './logsBuffer';

// Newest-N entries only. The buffer holds up to 4000; the server caps at 500
// anyway (config('mobile.client_logs.max_entries')), so sending more is pure
// upload cost on an already-unhappy tab.
const MAX_ENTRIES = 500;

// A crash loop must not become an upload loop. The server also throttles
// (throttle:10,1), but a wedged tab shouldn't burn the agent's bandwidth
// discovering that.
const MAX_REPORTS_PER_SESSION = 5;
const MIN_GAP_MS = 30_000;

let reportsSent = 0;
let lastSentAt = 0;
let installed = false;
const seenFingerprints = new Set<string>();

/**
 * Redact things that look like credentials before they leave the browser.
 *
 * This is deliberately NOT a general content scrubber: the reports go to the
 * CRM, which already stores every ticket message, so conversation text is not
 * newly exposed by this upload. What must never leave are the things the CRM
 * does NOT already hold — MTProto auth keys, bearer tokens, OTP codes — because
 * those would turn a debugging aid into a credential leak.
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

/** Walk an entry's args and redact every string, bounded in depth. */
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

function fingerprintOf(message: string, stack: string) {
  // Only used for in-session dedupe; the server computes the real one. Numbers
  // are stripped so the same crash on different message ids counts as one.
  return (message + '|' + stack.split('\n')[1]).replace(/\d+/g, '#');
}

function normalizeError(error: any): {message: string, stack?: string} {
  if(error instanceof Error) {
    return {message: error.message || String(error), stack: error.stack};
  }

  if(typeof error === 'string') return {message: error};

  try {
    return {message: JSON.stringify(error)?.slice(0, 2048) || String(error)};
  } catch{
    return {message: String(error)};
  }
}

/**
 * Collect + upload one report. Resolves to the server's report id, or undefined
 * when the report was throttled, deduped, or the CRM is unreachable/logged out.
 */
export async function reportCrash(reason: CrmClientLogReason, error: any): Promise<number | undefined> {
  try {
    const now = Date.now();
    if(reportsSent >= MAX_REPORTS_PER_SESSION) return;
    if(reason !== 'manual' && now - lastSentAt < MIN_GAP_MS) return;

    const {message, stack} = normalizeError(error);
    const fingerprint = fingerprintOf(message, stack || '');
    if(reason !== 'manual' && seenFingerprints.has(fingerprint)) return;

    // Claim the slot BEFORE the awaits below — collectLogs round-trips to two
    // workers, and a crash loop would otherwise fire dozens of concurrent
    // uploads through the same unclaimed slot.
    reportsSent++;
    lastSentAt = now;
    seenFingerprints.add(fingerprint);

    const {collectLogs} = await import('./exportLogs');
    let entries: LogEntry[] = [];
    try {
      entries = await collectLogs();
    } catch{
      // Workers unreachable (often the very thing that crashed) — the error and
      // its stack are still worth uploading on their own.
    }

    const trimmed = entries.slice(-MAX_ENTRIES).map((entry) => ({
      ...entry,
      args: redactValue(entry.args),
      prefix: redact(entry.prefix || '')
    }));

    const result = await rootScope.managers.appCrmManager.postClientLogs({
      reason,
      message: redact(message).slice(0, 4096),
      stack: stack ? redact(stack).slice(0, 65535) : undefined,
      url: redact(location.href).slice(0, 2048),
      app_version: App.versionFull,
      app_build: App.build,
      entries: trimmed
    });

    return result?.id;
  } catch{
    // Swallow everything: see the header note about re-entering the handler.
    return undefined;
  }
}

/**
 * Install the global handlers. Idempotent; safe to call before the agent has
 * connected the CRM (postClientLogs no-ops until isConnected()).
 */
export function installCrashReporter() {
  if(installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    // Resource load failures (<img>, <script>) also fire 'error' on window and
    // carry no `error` object — they are not crashes and would drown the signal.
    if(!event.error) return;
    reportCrash('error', event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportCrash('unhandledrejection', event.reason);
  });

  if(MOUNT_CLASS_TO) {
    // window.reportCrash('why I am filing this') — forces an upload without
    // waiting for a real crash. 'manual' bypasses the dedupe/gap throttles so
    // it works on demand, but still counts against MAX_REPORTS_PER_SESSION.
    MOUNT_CLASS_TO.reportCrash = (note?: string) => reportCrash('manual', new Error(note || 'manual report'));
  }
}
