// Bundle the extension into dist/extension.js, the only code that ships in the .vsix.
//
//   node scripts/bundle.js               development build, with a source map
//   node scripts/bundle.js --production  minified, no source map (used when packaging)
//   node scripts/bundle.js --watch       rebuild on change (for the "npm: watch" task)
//
// Uses esbuild-wasm rather than esbuild: node_modules is shared between the Linux
// build image and the host, and esbuild's native binary only works on the
// platform that installed it.
const fs = require('fs');
const esbuild = require('esbuild-wasm');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  // VS Code 1.82 (the minimum in package.json) runs extensions on Node 18.
  target: 'node18',
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  plugins: [{
    name: 'report',
    setup(build) {
      build.onStart(() => {
        if (watch) {
          console.log('[watch] build started');
        }
      });
      build.onEnd(result => {
        // One line per problem, in a form the "npm: watch" task's problem matcher understands.
        for (const message of [...result.errors, ...result.warnings]) {
          const severity = result.errors.includes(message) ? 'error' : 'warning';
          const where = message.location
            ? `${message.location.file}:${message.location.line}:${message.location.column + 1}`
            : 'scripts/bundle.js:1:1';
          console.error(`${where}: ${severity}: ${message.text}`);
        }
        if (watch) {
          console.log('[watch] build finished');
        }
      });
    },
  }],
};

async function main() {
  // Start clean so a production build doesn't ship next to a stale source map.
  fs.rmSync('dist', { recursive: true, force: true });
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }
  const result = await esbuild.build(options);
  if (result.errors.length > 0) {
    process.exit(1);
  }
}

main().catch(() => process.exit(1));
