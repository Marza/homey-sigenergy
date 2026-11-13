const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectVersion } = require('../scripts/release-version');
test('first release increments the manifest patch', () =>
  assert.equal(selectVersion('0.17.0', []), '0.17.1'));
test('patch versions use numerical ordering and ignore unrelated/prerelease tags', () =>
  assert.equal(
    selectVersion('0.17.0', ['v0.17.9', 'v0.17.10', 'foo', 'v9.0.0-beta.1']),
    '0.17.11',
  ));
test('explicit minor/major manifest versions take precedence', () => {
  assert.equal(selectVersion('0.18.0', ['v0.17.9']), '0.18.0');
  assert.equal(selectVersion('1.0.0', ['v0.17.9']), '1.0.0');
});
test('rerunning the same commit reuses its tag', () =>
  assert.equal(selectVersion('0.17.0', ['v0.17.1', 'v0.17.2'], ['v0.17.1']), '0.17.1'));
test('ambiguous tags and invalid stable versions fail', () => {
  assert.throws(() => selectVersion('0.17.0', [], ['v0.17.1', 'v0.17.2']));
  for (const version of ['01.2.3', '1.2', '1.0.0-beta.1', '9999999999999999999.0.0'])
    assert.throws(() => selectVersion(version, []));
});
