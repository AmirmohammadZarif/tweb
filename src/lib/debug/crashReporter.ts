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
import {redact, redactValue} from './redact';
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
