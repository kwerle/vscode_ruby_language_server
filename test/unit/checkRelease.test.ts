import * as assert from 'assert';
import * as path from 'path';

interface Result { problems: string[]; notes: string }
type CheckRelease = (input: { tag: string; version: string; changelog: string }) => Result;

// A plain CommonJS build script; this file runs from out/test/unit.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkRelease }: { checkRelease: CheckRelease } = require(path.join(__dirname, '../../../scripts/check-release.js'));

const CHANGELOG = `# Change Log

#### 0.2.0 Sun Nov 15 12:00:00 PST 2026

* Wait for Docker to start (#28)
* Add a Restart command,
  shown in the status bar

#### 0.1.2 Tue Oct 25 19:53:55 PDT 2022

* Update node files
`;

describe('checkRelease', () => {
  it('passes when the tag, version and changelog agree, and returns the section as notes', () => {
    const { problems, notes } = checkRelease({ tag: '0.2.0', version: '0.2.0', changelog: CHANGELOG });
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(notes, '* Wait for Docker to start (#28)\n* Add a Restart command,\n  shown in the status bar\n');
  });

  it('fails when the tag differs from package.json', () => {
    const { problems } = checkRelease({ tag: '0.2.1', version: '0.2.0', changelog: CHANGELOG });
    assert.deepStrictEqual(problems, ["Tag 0.2.1 doesn't match package.json's version (0.2.0)."]);
  });

  it('rejects a v-prefixed tag, with a hint', () => {
    const { problems } = checkRelease({ tag: 'v0.2.0', version: '0.2.0', changelog: CHANGELOG });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /use 0\.2\.0/);
  });

  it('fails when the changelog has no section for the version', () => {
    const { problems } = checkRelease({ tag: '0.3.0', version: '0.3.0', changelog: CHANGELOG });
    assert.deepStrictEqual(problems, ['CHANGELOG.md has no "#### 0.3.0" section.']);
  });

  it('fails when the version section has no entries', () => {
    const changelog = '#### 0.3.0 today\n\n#### 0.2.0\n\n* Something\n';
    const { problems } = checkRelease({ tag: '0.3.0', version: '0.3.0', changelog });
    assert.deepStrictEqual(problems, ["CHANGELOG.md's 0.3.0 section has no entries."]);
  });

  it('fails while Unreleased still has entries', () => {
    const changelog = '#### Unreleased\n\n* Not shipped yet\n\n' + CHANGELOG;
    const { problems } = checkRelease({ tag: '0.2.0', version: '0.2.0', changelog });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /Unreleased/);
  });

  it('allows an empty Unreleased heading', () => {
    const changelog = '#### Unreleased\n\n' + CHANGELOG;
    assert.deepStrictEqual(checkRelease({ tag: '0.2.0', version: '0.2.0', changelog }).problems, []);
  });

  it('matches a heading with no date', () => {
    const changelog = '#### 0.2.0\n\n* Something\n';
    assert.deepStrictEqual(checkRelease({ tag: '0.2.0', version: '0.2.0', changelog }).problems, []);
  });
});
