// @ts-check

// Stamps an explicit build number into .env (VITE_BUILD / VITE_VERSION_FULL)
// and public/version.
//
// change_version.js increments whatever number is committed in .env, which only
// works when the bump is committed back afterwards. A container build starts
// from a clean checkout every time, so it would emit the same number forever —
// and App.build is exactly what singleInstance.ts and loadState.ts compare to
// decide "a new version shipped, deactivate this tab and reload". A frozen
// number means already-open tabs are never told a deploy happened.
//
// Usage: node src/scripts/set_build.js [buildNumber]
// Defaults to unix seconds, which is monotonic across independent builds.

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');
const envPath = path.join(rootDir, '.env');
const versionPath = path.join(rootDir, 'public', 'version');

const build = +process.argv[2] || Math.floor(Date.now() / 1000);

const env = {};
const order = [];
fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
  if(!line) return;
  // split on the FIRST '=' only — values may legitimately contain '=' (base64
  // padding in the push key, for one), and String.split(sep, limit) would drop
  // everything after the second separator rather than keeping it in the value.
  const i = line.indexOf('=');
  if(i === -1) return;
  const key = line.slice(0, i);
  env[key] = line.slice(i + 1);
  order.push(key);
});

env.VITE_BUILD = '' + build;
env.VITE_VERSION_FULL = `${env.VITE_VERSION} (${build})`;

fs.writeFileSync(envPath, order.map((key) => `${key}=${env[key]}`).join('\n') + '\n', 'utf-8');
fs.writeFileSync(versionPath, env.VITE_VERSION_FULL, 'utf-8');

console.log('set-build:', env.VITE_VERSION_FULL);
