import {readFileSync} from 'fs';
import {resolve} from 'path';

type WebManifest = {
  id: string,
  start_url: string,
  scope: string,
  scope_extensions: Array<{
    type: string,
    origin: string
  }>
};

const manifests = [
  'site.webmanifest',
  'site_apple.webmanifest'
].map((fileName) => ({
  fileName,
  manifest: JSON.parse(readFileSync(resolve(__dirname, '../../public', fileName), 'utf8')) as WebManifest
}));

// Andropay fork: the app is served as Androgram from its own origin, so it neither claims
// web.telegram.org's `/k/` PWA identity nor asks to capture t.me links (scope_extensions only
// work for an origin t.me's association file names, which ours is not).
describe('PWA web manifests', () => {
  test.each(manifests)('$fileName starts in place and claims no Telegram identity', ({manifest}) => {
    expect(manifest.start_url).toBe('./');
    expect(manifest.id).toBeUndefined();
    expect(manifest.scope_extensions).toBeUndefined();
  });
});
