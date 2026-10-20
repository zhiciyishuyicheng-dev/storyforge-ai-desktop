'use strict';

const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

// Keep the requested public release string in source, packed metadata and UI.
// The bundled builder otherwise rejects two-part versions before loading config.
// Adapt only this project's metadata validation, never a dependency or disk file.
function installShortReleaseVersionCompatibility(projectDir = path.resolve(__dirname, '..')) {
  const metadata = require('app-builder-lib/out/util/packageMetadata');
  const normalizer = require('app-builder-lib/out/util/normalizePackageData');
  const originalRead = metadata.readPackageJson;
  const originalNormalize = normalizer.normalizePackageData;
  const scope = new AsyncLocalStorage();
  const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const projectPackage = pathKey(path.join(projectDir, 'package.json'));
  const scopedRead = function (file, ...args) {
    return scope.run(pathKey(file), () => originalRead.call(this, file, ...args));
  };
  const scopedNormalize = function (data, ...args) {
    if (scope.getStore() !== projectPackage || data.version !== '1.0') {
      return originalNormalize.call(this, data, ...args);
    }
    data.version = '1.0.0';
    try { return originalNormalize.call(this, data, ...args); }
    finally { data.version = '1.0'; }
  };
  metadata.readPackageJson = scopedRead;
  normalizer.normalizePackageData = scopedNormalize;
  return () => {
    if (metadata.readPackageJson === scopedRead) metadata.readPackageJson = originalRead;
    if (normalizer.normalizePackageData === scopedNormalize) normalizer.normalizePackageData = originalNormalize;
    scope.disable();
  };
}

async function runDesktopPack(argv = process.argv.slice(2), { projectDir = path.resolve(__dirname, '..'), buildTask, wrapTask } = {}) {
  const restore = installShortReleaseVersionCompatibility(projectDir);
  try {
    const builder = require('electron-builder/out/builder');
    const wrap = wrapTask || require('electron-builder/out/cli/cli-util').wrap;
    await builder.createYargs()
      .command(['build', '*'], 'Build', builder.configureBuildCommand, wrap(buildTask || builder.build))
      .help()
      .strict()
      .recommendCommands()
      .exitProcess(false)
      .fail((message, error) => { throw error || new Error(message); })
      .parseAsync(argv);
  } finally { restore(); }
}

if (require.main === module) {
  runDesktopPack().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { installShortReleaseVersionCompatibility, runDesktopPack };
