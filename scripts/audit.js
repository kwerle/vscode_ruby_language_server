// Fail if the runtime dependencies (what's inlined into the shipped bundle)
// have advisories at or above a severity.
//
//   node scripts/audit.js [--level high] [--groups dependencies]
//
// Needs yarn (CI and the build image have it). Reads `yarn audit --json`
// rather than trusting its exit code, which doesn't follow --level reliably,
// and fails if the audit produced no summary at all.
const { spawnSync } = require('child_process');

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const level = option('level', 'high');
const groups = option('groups', 'dependencies');
if (!SEVERITIES.includes(level)) {
  console.error(`--level must be one of: ${SEVERITIES.join(', ')}`);
  process.exit(2);
}

const result = spawnSync('yarn', ['audit', '--groups', groups, '--json'], { encoding: 'utf8' });
const messages = (result.stdout || '').split('\n').filter(Boolean).map(line => {
  try {
    return JSON.parse(line);
  } catch (error) {
    return null;
  }
}).filter(message => message);

const summary = messages.find(message => message.type === 'auditSummary');
if (!summary) {
  console.error(`yarn audit produced no summary, so nothing was checked.\n${(result.stderr || result.error || '').toString().trim()}`);
  process.exit(1);
}

const counts = summary.data.vulnerabilities;
const advisories = messages.filter(message => message.type === 'auditAdvisory').map(message => message.data.advisory);
console.log(`yarn audit --groups ${groups}: ${summary.data.totalDependencies} packages, ` +
  SEVERITIES.map(severity => `${counts[severity]} ${severity}`).join(', '));
for (const advisory of advisories) {
  console.log(`  ${advisory.severity}: ${advisory.module_name} ${advisory.vulnerable_versions}: ${advisory.title} (${advisory.url})`);
}

const failing = SEVERITIES.slice(SEVERITIES.indexOf(level)).reduce((total, severity) => total + counts[severity], 0);
if (failing > 0) {
  console.error(`${failing} ${groups} vulnerabilities at ${level} or above.`);
  process.exit(1);
}
