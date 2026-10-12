// * Jolly Cobra's schedulers
import {NoneToVoidFunction} from '@types';

/*
export function throttleWithTickEnd<F extends AnyToVoidFunction>(fn: F) {
  return throttleWith(onTickEnd, fn);
}

export function throttleWithNow<F extends AnyToVoidFunction>(fn: F) {
  return throttleWith(runNow, fn);
}

export function onTickEnd(cb: NoneToVoidFunction) {
  Promise.resolve().then(cb);
}

function runNow(fn: NoneToVoidFunction) {
  fn();
} */

// iOS Safari pauses (and can outright drop) requestAnimationFrame while the tab
// is backgrounded — e.g. the user switches to the Telegram app to scan the
// login QR. Boot leans on rAF heavily (#main-columns fade-in, doubleRaf gating
// large parts of startup), so a paused rAF leaves the page stuck blank over the
// chat background. Race rAF against a timeout fallback: when the tab is visible
// rAF fires first (unchanged behaviour); when it's paused/dropped the timeout
// still runs the frame so boot completes.
function scheduleFrame(callback: NoneToVoidFunction) {
  let done = false;
  const run = () => {
    if(done) return;
    done = true;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(run, 1000 / 60 * 3);
  requestAnimationFrame(run);
}

/**
 * Callbacks batched into one frame are unrelated to each other, so one of them throwing must not
 * cancel the rest: `fastRafPromise` resolves from a callback queued in here, and dropping that
 * resolve leaves its cached promise pending forever — every later `fastRafPromise()` then returns
 * the same dead promise and silently parks whatever awaits it for the lifetime of the tab.
 */
function runFastRafCallback(callback: NoneToVoidFunction) {
  try {
    callback();
  } catch(err) {
    console.error('fastRaf callback error:', err);
  }
}

let fastRafCallbacks: NoneToVoidFunction[] | undefined;
export function fastRaf(callback: NoneToVoidFunction) {
  if(!fastRafCallbacks) {
    fastRafCallbacks = [callback];

    scheduleFrame(() => {
      const currentCallbacks = fastRafCallbacks!;
      fastRafCallbacks = undefined;
      currentCallbacks.forEach(runFastRafCallback);
    });
  } else {
    fastRafCallbacks.push(callback);
  }
}

let fastRafConventionalCallbacks: NoneToVoidFunction[] | undefined, processing = false;
export function fastRafConventional(callback: NoneToVoidFunction) {
  if(!fastRafConventionalCallbacks) {
    fastRafConventionalCallbacks = [callback];

    scheduleFrame(() => {
      processing = true;
      // same reasoning as above, plus a throw escaping here would leave the queue non-empty and
      // `processing` stuck true, degrading every later call to synchronous execution for good
      for(let i = 0; i < fastRafConventionalCallbacks.length; ++i) {
        runFastRafCallback(fastRafConventionalCallbacks[i]);
      }

      fastRafConventionalCallbacks = undefined;
      processing = false;
    });
  } else if(processing) {
    callback();
  } else {
    fastRafConventionalCallbacks.push(callback);
  }
}

let rafPromise: Promise<void>;
export function fastRafPromise() {
  if(rafPromise) return rafPromise;

  rafPromise = new Promise<void>((resolve) => fastRaf(() => resolve()));
  rafPromise.then(() => {
    rafPromise = undefined;
  });

  return rafPromise;
}

export function doubleRaf() {
  return new Promise<void>((resolve) => {
    fastRaf(() => {
      fastRaf(resolve);
    });
  });
}
