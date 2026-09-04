// Runs automatically after `npm install` (see package.json "postinstall").
//
// The renderer loads three.js straight as native ES modules (no bundler),
// so we copy the built three.js files out of node_modules into
// renderer/vendor/ where index.html's <script type="importmap"> and
// meshyViewer.js expect to find them. This only affects the optional
// "generate a 3D model" path that uses your own Meshy AI key - the
// built-in procedural 3D generator never touches this and always works.
//
// If this fails (e.g. a future three.js release reorganizes its files),
// the app still runs fine; only real AI-generated model viewing degrades
// to "save the file and open it elsewhere" until this script is updated.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const destDir = path.join(root, 'renderer', 'vendor');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  const threeBuild = path.join(root, 'node_modules', 'three', 'build');
  const threeJsm = path.join(root, 'node_modules', 'three', 'examples', 'jsm');

  if (!fs.existsSync(threeBuild) || !fs.existsSync(threeJsm)) {
    console.warn('[prepare-vendor] three.js not found in node_modules (npm install may have skipped optional deps).');
    console.warn('[prepare-vendor] The app still works - only the optional Meshy AI 3D viewer needs this.');
    return;
  }

  try {
    fs.rmSync(destDir, { recursive: true, force: true });
    copyDir(threeBuild, path.join(destDir, 'build'));
    copyDir(threeJsm, path.join(destDir, 'jsm'));
    fs.writeFileSync(path.join(destDir, '.gitkeep'), '');
    console.log('[prepare-vendor] three.js vendored into renderer/vendor/ successfully.');
  } catch (err) {
    console.warn('[prepare-vendor] could not vendor three.js:', err.message);
    console.warn('[prepare-vendor] The app still works - only the optional Meshy AI 3D viewer needs this.');
  }
}

main();
