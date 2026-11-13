'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function parse(version) {
  if (!pattern.test(version)) throw new Error(`Expected a stable SemVer version: ${version}`);
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version exceeds safe integer range');
  return parts;
}
function compare(a, b) {
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function selectVersion(base, tags, currentTags = []) {
  parse(base);
  const versions = tags.filter(t => t.startsWith('v') && pattern.test(t.slice(1))).map(t => t.slice(1));
  const current = currentTags.filter(t => t.startsWith('v') && pattern.test(t.slice(1)));
  if (current.length > 1) throw new Error('Multiple release tags point to this commit');
  if (current.length) return current[0].slice(1);
  const latest = versions.sort(compare).at(-1) || base;
  if (compare(base, latest) > 0) return base;
  const parts = parse(latest); parts[2]++;
  const result = parts.join('.'); parse(result); return result;
}
if (require.main === module) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const app = JSON.parse(fs.readFileSync('app.json'));
  const version = selectVersion(app.version, git('tag', '--list'), git('tag', '--points-at', 'HEAD'));
  for (const path of ['app.json', 'package.json', 'package-lock.json']) {
    const data = JSON.parse(fs.readFileSync(path)); data.version = version;
    if (path === 'package-lock.json') data.packages[''].version = version;
    fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
  console.log(`Release version: v${version}`);
}
module.exports = { selectVersion };
