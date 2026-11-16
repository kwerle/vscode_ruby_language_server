// Check that a release tag, package.json and CHANGELOG.md agree.
//
//   npm run release:check -- 0.2.0
//   node scripts/check-release.js 0.2.0 [--notes-file notes.md]
//
// The release workflow (.github/workflows/release.yml) runs this before it
// publishes anything. With --notes-file, it writes the version's changelog
// entries there, for the GitHub release notes.
const fs = require('fs');
const path = require('path');

// A changelog section starts with a "#### <version> <date>" heading.
const HEADING = /^####\s+(\S+)/;
const ENTRY = /^\s*[*-]\s+\S/;

// Changelog sections, keyed by the first word of their heading.
function sections(changelog) {
  const found = new Map();
  let current;
  for (const line of changelog.split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      current = [];
      found.set(heading[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return found;
}

function checkRelease({ tag, version, changelog }) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(tag)) {
    const hint = /^v\d/.test(tag) ? ` Release tags have no "v": use ${tag.slice(1)}.` : '';
    problems.push(`Tag "${tag}" isn't a release version (X.Y.Z).${hint}`);
  } else if (tag !== version) {
    problems.push(`Tag ${tag} doesn't match package.json's version (${version}).`);
  }

  const all = sections(changelog);
  const section = all.get(version) || [];
  const entries = section.filter(line => ENTRY.test(line));
  if (!all.has(version)) {
    problems.push(`CHANGELOG.md has no "#### ${version}" section.`);
  } else if (entries.length === 0) {
    problems.push(`CHANGELOG.md's ${version} section has no entries.`);
  }
  const unreleased = (all.get('Unreleased') || []).filter(line => ENTRY.test(line));
  if (unreleased.length > 0) {
    problems.push(`CHANGELOG.md still has Unreleased entries: rename that heading to "#### ${version} <date>".`);
  }

  return { problems, notes: section.join('\n').trim() + '\n' };
}

module.exports = { checkRelease };

if (require.main === module) {
  const args = process.argv.slice(2);
  const notesAt = args.indexOf('--notes-file');
  const notesFile = notesAt >= 0 ? args.splice(notesAt, 2)[1] : undefined;
  const [tag] = args;
  if (!tag || (notesAt >= 0 && !notesFile)) {
    console.error('Usage: node scripts/check-release.js <version> [--notes-file <path>]');
    process.exit(2);
  }

  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const { problems, notes } = checkRelease({ tag, version, changelog });
  if (problems.length) {
    problems.forEach(problem => console.error(problem));
    process.exit(1);
  }
  if (notesFile) {
    fs.writeFileSync(notesFile, notes);
  }
  console.log(`Release ${tag}: package.json and CHANGELOG.md agree.`);
}
