/*
 * Main-thread-only: report uncaught errors to the self-hosted GlitchTip
 * (Sentry protocol) at VITE_GLITCHTIP_DSN.
 *
 * Relationship to ./crashReporter — they are complementary, not duplicates:
 *
 *   crashReporter -> the CRM. Uploads the FULL merged log tail from all three
 *                    contexts (window + MTProto worker + service worker). Deep
 *                    context, no grouping UI, agent-authenticated.
 *   errorTracking -> GlitchTip. Grouping, release tracking, symbolicated
 *                    stacks, alerting. Main thread only (see the note below).
 *
 * Worker coverage: the Sentry browser SDK installs window-level handlers, so it
 * sees main-thread errors only. A crash inside the MTProto SharedWorker or the
 * service worker does NOT reach GlitchTip — it reaches the CRM via
 * crashReporter, which pulls those buffers over the message ports. That gap is
 * deliberate for now; closing it means a Sentry client inside each worker.
 *
 * Everything here is a no-op when the DSN is unset, which is the default in dev.
 */

import App from '@config/app';
import {redact} from './redact';
import type {ErrorEvent, EventHint} from '@sentry/browser';

let installed = false;
// Kept so worker-forwarded errors can be captured later. Undefined until init
// resolves, and forever when there is no DSN.
let sentry: typeof import('@sentry/browser') | undefined;

/**
 * Strip credentials from every free-text field of an outbound event.
 *
 * This matters more here than for the CRM upload: GlitchTip stores events
 * outside the CRM's trust boundary, and unlike the CRM it does NOT already hold
 * your ticket conversations. So this scrubs the message, the stack frames, the
 * breadcrumbs and the request URL — reusing the same tested redactor as
 * crashReporter (see src/tests/crashReporterRedact.test.ts).
 */
function scrub<T extends ErrorEvent>(event: T): T {
  if(event.message) event.message = redact(event.message);

  event.exception?.values?.forEach((value) => {
    if(value.value) value.value = redact(value.value);
    value.stacktrace?.frames?.forEach((frame) => {
      if(frame.filename) frame.filename = redact(frame.filename);
    });
  });

  event.breadcrumbs?.forEach((crumb) => {
    if(crumb.message) crumb.message = redact(crumb.message);
    if(crumb.data) {
      for(const key in crumb.data) {
        if(typeof crumb.data[key] === 'string') crumb.data[key] = redact(crumb.data[key]);
      }
    }
  });

  if(event.request?.url) event.request.url = redact(event.request.url);

  // The agent's Telegram/CRM identity is PII we have no reason to ship here —
  // the CRM-side report already ties a crash to an agent when that matters.
  delete event.user;

  return event;
}

/**
 * Initialise error tracking. Safe to call unconditionally: without a DSN it
 * returns immediately and the SDK is never even imported.
 */
export async function installErrorTracking() {
  const dsn = import.meta.env.VITE_GLITCHTIP_DSN;
  if(installed || !dsn) return;
  installed = true;

  try {
    // Dynamic import so the ~30KB SDK stays out of the boot path (and out of
    // the bundle entirely for builds with no DSN configured).
    const Sentry = sentry = await import('@sentry/browser');

    Sentry.init({
      dsn,
      release: App.versionFull,
      environment: import.meta.env.DEV ? 'development' : 'production',
      // GlitchTip bills/stores by event; tweb is chatty and this is a support
      // tool, not a perf lab. Errors only.
      tracesSampleRate: 0,
      // Never attach IP / cookies / headers automatically.
      sendDefaultPii: false,
      // Breadcrumbs are the main leak vector (they capture console output and
      // fetch URLs), so keep the window short and scrub what survives.
      maxBreadcrumbs: 30,
      ignoreErrors: [
        // Benign and extremely noisy: fired by ResizeObserver loops in Chrome
        // and by extensions injecting into the page.
        'ResizeObserver loop completed with undelivered notifications',
        'ResizeObserver loop limit exceeded'
      ],
      denyUrls: [
        // Browser-extension frames throwing inside our page are not our bugs.
        /^chrome-extension:\/\//,
        /^moz-extension:\/\//,
        /^safari-extension:\/\//
      ],
      beforeSend: (event: ErrorEvent, _hint: EventHint) => scrub(event)
    });

    Sentry.setTag('app_build', String(App.build));
  } catch(err) {
    // A failed error-reporter must never break boot.
    console.error('[errorTracking] init failed:', err);
  }
}

/**
 * Report an uncaught error that happened in ANOTHER context (currently only the
 * service worker — see ServiceErrorPayload / index.service.ts).
 *
 * Those contexts have no `window`, so the SDK's global handlers can never see
 * them; they are forwarded over the message port and re-raised here. The
 * `source` tag is what tells you, in GlitchTip, that a stack belongs to the SW
 * and not to this thread — without it these are extremely confusing to triage.
 *
 * The reconstructed Error carries the ORIGINAL stack string, so it symbolicates
 * against the same uploaded maps as any main-thread error.
 */
export function captureForeignError(source: 'sw', payload: {
  kind: string,
  message: string,
  stack?: string,
  filename?: string,
  lineno?: number,
  colno?: number
}) {
  if(!sentry) return;

  try {
    const error = new Error(payload.message);
    error.name = source.toUpperCase() + ' ' + payload.kind;
    if(payload.stack) error.stack = payload.stack;

    sentry.withScope((scope) => {
      scope.setTag('source', source);
      scope.setTag('error_kind', payload.kind);
      scope.setLevel('error');
      if(payload.filename) {
        scope.setContext('location', {
          filename: payload.filename,
          lineno: payload.lineno,
          colno: payload.colno
        });
      }
      sentry.captureException(error);
    });
  } catch{
    // Reporting must never throw.
  }
}
