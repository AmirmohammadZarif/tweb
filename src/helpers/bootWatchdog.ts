/**
 * Boot watchdog + one-shot guarded recovery.
 *
 * The installed PWA can relaunch into a permanent white screen: the app shell
 * (`#page-chats`) stays `display: none` until very late in boot, and several
 * boot-critical `await`s (SharedWorker `invoke('isLocked')` / `sendAllStates`,
 * the `bootstrapIm` dynamic import) have no timeout or fallback. A wedged
 * SharedWorker that survived the previous session, or a stale `index.html`
 * pointing at a hashed bundle that no longer exists, leaves those promises
 * pending forever and the UI never mounts.
 *
 * This watchdog fires when boot makes no progress for a while (or throws) and
 * performs a graduated, loop-guarded recovery instead of leaving the user on a
 * blank page:
 *   attempt 0 → clear CacheStorage + unregister service workers, then reload
 *               (fixes stale HTML/JS and a broken/uncontrolled service worker)
 *   attempt 1 → reload with `?noSharedWorker=1` (bypasses a wedged SharedWorker)
 *   attempt ≥2 → show a minimal, self-contained error screen with manual
 *               recovery actions (never auto-loop forever)
 *
 * The attempt counter lives in `window.sessionStorage` so it survives the
 * recovery reloads but resets on a fresh app launch; `bootSucceeded()` also
 * resets it so a transient stall that recovers doesn't poison later boots.
 */

const DEFAULT_TIMEOUT = 30000;
const ATTEMPTS_KEY = 'boot_recovery_attempts';
const MAX_AUTO_RECOVERIES = 2;
const RECOVERY_HARD_TIMEOUT = 5000;

let timeout: ReturnType<typeof setTimeout>;
let timeoutMs = DEFAULT_TIMEOUT;
let finished = false;

function getAttempts(): number {
  try {
    return parseInt(window.sessionStorage.getItem(ATTEMPTS_KEY)) || 0;
  } catch(err) {
    return 0;
  }
}

function setAttempts(n: number) {
  try {
    if(n) window.sessionStorage.setItem(ATTEMPTS_KEY, '' + n);
    else window.sessionStorage.removeItem(ATTEMPTS_KEY);
  } catch(err) {}
}

export function startBootWatchdog(ms = DEFAULT_TIMEOUT) {
  timeoutMs = ms;
  finished = false;
  arm();
}

function arm() {
  clearTimeout(timeout);
  timeout = setTimeout(() => onBootStall('timeout'), timeoutMs);
}

/**
 * Push the deadline forward — call after each boot milestone so a slow but
 * progressing boot (e.g. first install on a slow network) is never mistaken
 * for a hang; only a genuinely stuck phase trips the watchdog.
 */
export function bootProgress() {
  if(finished) return;
  arm();
}

export function bootSucceeded() {
  if(finished) return;
  finished = true;
  clearTimeout(timeout);
  setAttempts(0);
}

export function onBootStall(reason: string) {
  if(finished) return;
  finished = true;
  clearTimeout(timeout);
  recover(reason);
}

function withHardTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  ]);
}

async function clearCachesAndServiceWorkers() {
  const jobs: Promise<any>[] = [];

  try {
    if('caches' in window) {
      jobs.push(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
    }
  } catch(err) {}

  try {
    if('serviceWorker' in navigator) {
      jobs.push(
        navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
      );
    }
  } catch(err) {}

  await withHardTimeout(Promise.allSettled(jobs), RECOVERY_HARD_TIMEOUT);
}

function reload() {
  // bypass the HTTP cache so a stale index.html is not re-served
  location.reload();
}

function reloadWithNoSharedWorker() {
  try {
    const url = new URL(location.href);
    url.searchParams.set('noSharedWorker', '1');
    location.replace(url.toString());
  } catch(err) {
    reload();
  }
}

async function recover(reason: string) {
  console.error('[bootWatchdog] boot stalled, recovering. reason:', reason);

  const attempts = getAttempts();
  if(attempts >= MAX_AUTO_RECOVERIES) {
    showBootErrorScreen(reason);
    return;
  }

  setAttempts(attempts + 1);

  try {
    if(attempts === 0) {
      await clearCachesAndServiceWorkers();
      reload();
    } else {
      reloadWithNoSharedWorker();
    }
  } catch(err) {
    reload();
  }
}

function showBootErrorScreen(reason: string) {
  console.error('[bootWatchdog] auto-recovery exhausted, showing manual recovery UI. reason:', reason);

  try {
    const existing = document.getElementById('boot-error-screen');
    if(existing) return;

    const root = document.createElement('div');
    root.id = 'boot-error-screen';
    root.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center',
      'gap:16px', 'padding:24px', 'box-sizing:border-box',
      'text-align:center', 'background:#ffffff', 'color:#1f1f1f',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
    ].join(';'));

    const title = document.createElement('div');
    title.setAttribute('style', 'font-size:18px;font-weight:600;');
    title.textContent = 'Telegram failed to load';

    const subtitle = document.createElement('div');
    subtitle.setAttribute('style', 'font-size:14px;opacity:.7;max-width:340px;line-height:1.4;');
    subtitle.textContent = 'Something got stuck while starting up. Try reloading, or reset the cached app data.';

    const buttonStyle = [
      'appearance:none', 'border:none', 'cursor:pointer',
      'font-size:15px', 'font-weight:500', 'border-radius:10px',
      'padding:10px 20px', 'min-width:200px'
    ].join(';');

    const reloadButton = document.createElement('button');
    reloadButton.setAttribute('style', buttonStyle + ';background:#3390ec;color:#ffffff;');
    reloadButton.textContent = 'Reload';
    reloadButton.onclick = () => {
      setAttempts(0);
      reload();
    };

    const resetButton = document.createElement('button');
    resetButton.setAttribute('style', buttonStyle + ';background:rgba(0,0,0,.06);color:#1f1f1f;');
    resetButton.textContent = 'Reset app data & reload';
    resetButton.onclick = async() => {
      resetButton.disabled = true;
      resetButton.textContent = 'Resetting…';
      await clearCachesAndServiceWorkers();
      setAttempts(0);
      reload();
    };

    root.append(title, subtitle, reloadButton, resetButton);
    (document.body || document.documentElement).append(root);
  } catch(err) {
    console.error('[bootWatchdog] failed to render error screen', err);
  }
}
