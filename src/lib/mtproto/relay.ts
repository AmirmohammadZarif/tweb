/*
 * MTProto relay: optionally route every DC connection through a same-origin
 * reverse proxy instead of talking to *.web.telegram.org directly.
 *
 * A browser can't open raw TCP, so a real MTProxy (secret-based, like in
 * Telegram Desktop) is out of reach. What it CAN do is speak the exact same
 * obfuscated WebSocket / HTTPS framing to a different host — and the stream
 * is opaque, so any dumb reverse proxy that forwards bytes to the matching
 * Telegram endpoint works. The URL layout is what the proxy has to implement:
 *
 *   {scheme}://{host}/mtproto/ws/{dcId}{-1?}/{apiws|apiws_test|apiws_premium}
 *     → wss://kws{dcId}{-1?}.web.telegram.org/{path}
 *   {scheme}://{host}/mtproto/http/{sub}{-1?}/{apiw1|apiw_test1}
 *     → https://{sub}{-1?}.web.telegram.org/{path}   (sub = pluto|venus|…)
 *
 * The "-1" suffix is Telegram's media (download/upload) DC alias. The
 * reference proxy configs live in .docker/relay.nginx.conf (production) and
 * vite.config.ts (dev server), both generated from the same rules.
 *
 * The config is a mirror of `settings.mtprotoRelay`: the main thread owns the
 * setting, the worker receives it with the first `state` message and then via
 * `settings_updated` (see index.worker.ts / apiManager.ts), so it is known
 * before any transport is created.
 */

import type {StateSettings} from '@config/state';

export type MTProtoRelayConfig = StateSettings['mtprotoRelay'];

export const RELAY_PATH_PREFIX = '/mtproto';

let config: MTProtoRelayConfig = {enabled: false, host: ''};

export function setRelayConfig(newConfig: MTProtoRelayConfig) {
  if(!newConfig) {
    return;
  }

  config = {
    enabled: !!newConfig.enabled,
    host: normalizeRelayHost(newConfig.host)
  };
}

export function getRelayConfig(): MTProtoRelayConfig {
  return config;
}

export function isRelayEnabled() {
  return config.enabled;
}

// Accepts what a user is likely to paste: "relay.example.com",
// "https://relay.example.com/", "relay.example.com:8443". Returns host[:port].
export function normalizeRelayHost(host: string) {
  host = (host || '').trim();
  if(!host) {
    return '';
  }

  host = host.replace(/^[a-z]+:\/\//i, '');
  host = host.replace(/\/.*$/, '');
  return host.toLowerCase();
}

// Same-origin relay follows the page's own scheme (so plain-http dev works);
// a remote relay is always TLS — an https page can't open ws:// anyway.
function getRelayOrigin(secureScheme: string, plainScheme: string) {
  const ownHost = self.location.host;
  const host = config.host || ownHost;
  const secure = host !== ownHost || self.location.protocol === 'https:';
  return `${secure ? secureScheme : plainScheme}://${host}${RELAY_PATH_PREFIX}`;
}

export function constructRelayWebSocketUrl(dcId: number, suffix: string, path: string) {
  return `${getRelayOrigin('wss', 'ws')}/ws/${dcId}${suffix}/${path}`;
}

export function constructRelayHttpUrl(subdomain: string, path: string) {
  return `${getRelayOrigin('https', 'http')}/http/${subdomain}/${path}`;
}
