// Check that the packaged .vsix contains exactly the files we mean to ship.
//
//   npm run package && node scripts/check-package.js [path/to/file.vsix]
//
// Without an argument it checks <name>-<version>.vsix, the name `vsce package`
// gives it. Fails when a file is missing or anything else is in the package:
// new files are kept out by .vscodeignore, and this catches it if that slips.
const { execFileSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

// Paths inside the package's extension/ folder. vsce lowercases the readme
// and changelog names, so compare case-insensitively.
const EXPECTED = [
  'package.json',
  'readme.md',
  'changelog.md',
  'license.md',
  'dist/extension.js',
];
// Added by vsce itself, outside extension/.
const VSCE_FILES = ['extension.vsixmanifest', '[Content_Types].xml'];
// The bundle is about 370 KB minified (mostly vscode-languageclient 9); a big
// jump means something new got bundled.
const MAX_BUNDLE_BYTES = 600 * 1024;

const vsix = process.argv[2] || `${pkg.name}-${pkg.version}.vsix`;
let listing;
try {
  listing = execFileSync('unzip', ['-Z', '-l', vsix], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  console.error(`Can't read ${vsix}. Build it first with \`npm run package\`.`);
  process.exit(1);
}

// `unzip -Z -l` lines end with: <size> ... <name>
const entries = listing.split('\n')
  .map(line => line.match(/^\S{10}\s+\S+\s+\S+\s+(\d+)\s.*\s(\S+)$/))
  .filter(match => match)
  .map(match => ({ size: Number(match[1]), name: match[2] }))
  .filter(entry => !VSCE_FILES.includes(entry.name));

const shipped = entries.map(entry => entry.name.replace(/^extension\//, '').toLowerCase());
const missing = EXPECTED.filter(name => !shipped.includes(name));
const unexpected = shipped.filter(name => !EXPECTED.includes(name));
const bundle = entries.find(entry => entry.name === 'extension/dist/extension.js');

const problems = [];
if (missing.length) {
  problems.push(`missing: ${missing.join(', ')}`);
}
if (unexpected.length) {
  problems.push(`not on the allowlist: ${unexpected.join(', ')}`);
}
if (bundle && bundle.size > MAX_BUNDLE_BYTES) {
  problems.push(`dist/extension.js is ${bundle.size} bytes (limit ${MAX_BUNDLE_BYTES})`);
}

if (problems.length) {
  console.error(`${path.basename(vsix)} doesn't match the allowlist in scripts/check-package.js:`);
  problems.forEach(problem => console.error(`  ${problem}`));
  console.error('Ship new files only on purpose: add them to .vscodeignore and to EXPECTED here.');
  process.exit(1);
}
console.log(`${path.basename(vsix)}: ${shipped.length} files, as expected (bundle ${bundle.size} bytes).`);
