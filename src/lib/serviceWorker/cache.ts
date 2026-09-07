import pause from '@helpers/schedulers/pause';
import {logger} from '@lib/logger';

const ctx = self as any as ServiceWorkerGlobalScope;
export const CACHE_ASSETS_NAME = 'cachedAssets';

const log = logger('SW-CACHE');

/**
 * `cache.put` reads the response body itself, so it rejects whenever the body
 * fails to arrive in full (truncated upstream response, connection reset) —
 * with a bare `NetworkError` and no clue which asset it was. Nothing awaits it
 * here on purpose: the response is already on its way to the page, and a failed
 * cache write must not turn into an uncaught rejection per asset.
 */
function putInCache(cache: Cache, request: Request, response: Response) {
  cache.put(request, response).catch((err) => {
    log.warn('failed to cache', request.url, err);
  });
}

function isCorrectResponse(response: Response) {
  return response.ok && response.status === 200;
}

function timeoutRace<T extends Promise<any>>(promise: T) {
  return Promise.race([
    promise,
    pause(10000).then(() => Promise.reject())
  ]);
}

export async function requestCache(event: FetchEvent) {
  try {
    // const cache = await ctx.caches.open(CACHE_ASSETS_NAME);
    const cache = await timeoutRace(ctx.caches.open(CACHE_ASSETS_NAME));
    const file = await timeoutRace(cache.match(event.request, {ignoreVary: true}));

    if(file && isCorrectResponse(file)) {
      return file;
    }

    const headers: HeadersInit = {'Vary': '*'};
    let response = await fetch(event.request, {headers});
    if(isCorrectResponse(response)) {
      putInCache(cache, event.request, response.clone());
    } else if(response.status === 304) { // possible fix for 304 in Safari
      const url = event.request.url.replace(/\?.+$/, '') + '?' + (Math.random() * 100000 | 0);
      response = await fetch(url, {headers});
      if(isCorrectResponse(response)) {
        putInCache(cache, event.request, response.clone());
      }
    }

    return response;
  } catch(err) {
    return fetch(event.request);
  }
}
