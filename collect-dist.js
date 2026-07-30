// @ts-check

// Merges the compiled `dist/` into the served root `public/`, then prunes the
// previous build's output from it.
//
// `public/` is a tracked build-output directory: it holds the hand-maintained
// static assets (assets/, manifests, wasm, prebuilt workers) alongside the last
// build's content-hashed chunks. Copying `dist/` on top without pruning leaves
// every historical chunk behind, so the deployed root grows without bound and
// keeps serving stale bundles that should have 404'd.
//
// Extracted from build.js so `node build` and the Docker production build share
// one implementation instead of the Dockerfile reimplementing half of it.

const fs = require('fs');
const path = require('path');
const keepAsset = require('./keepAsset');

const publicPath = path.join(__dirname, 'public');
const distPath = path.join(__dirname, 'dist');

function copyFiles(source, destination) {
  if(!fs.existsSync(destination)) {
    fs.mkdirSync(destination);
  }

  const files = fs.readdirSync(source, {withFileTypes: true});
  files.forEach((file) => {
    const sourcePath = path.join(source, file.name);
    const destinationPath = path.join(destination, file.name);

    if(file.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    } else if(file.isDirectory()) {
      copyFiles(sourcePath, destinationPath);
    }
  });
}

function clearOldFiles() {
  const bundleFiles = fs.readdirSync(distPath);
  const files = fs.readdirSync(publicPath, {withFileTypes: true});
  const removed = [];
  files.forEach((file) => {
    if(file.isDirectory() ||
      bundleFiles.some((bundleFile) => bundleFile === file.name) ||
      keepAsset(file.name)) {
      return;
    }

    fs.unlinkSync(path.join(publicPath, file.name));
    removed.push(file.name);
  });

  return removed;
}

function collectDist() {
  if(!fs.existsSync(distPath)) {
    throw new Error('collect-dist: dist/ does not exist — run the build first');
  }

  copyFiles(distPath, publicPath);
  const removed = clearOldFiles();
  console.log(`collect-dist: merged dist/ into public/, pruned ${removed.length} stale file(s)`);
  return removed;
}

module.exports = {copyFiles, clearOldFiles, collectDist, publicPath, distPath};

if(require.main === module) {
  collectDist();
}
