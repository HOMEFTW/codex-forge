'use strict';
function parts(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) throw Error('无效版本：' + value);
  const result = value.split('.').map(Number);
  if (result.some(n => !Number.isSafeInteger(n))) throw Error('版本数值过大');
  return result;
}
function compare(a, b) { const left = parts(a), right = parts(b); for (let i = 0; i < Math.max(left.length, right.length); i++) { const d = (left[i] || 0) - (right[i] || 0); if (d) return Math.sign(d); } return 0; }
function satisfies(version, range) {
  parts(version);
  if (typeof range !== 'string' || !range.trim() || range.length > 200) throw Error('无效版本范围');
  return range.split('||').map(group => group.trim().split(/\s+/).map(token => {
    const match = token.match(/^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+(?:\.\d+)?)$/);
    if (!match) throw Error('版本范围仅支持精确版本、比较运算、^、~ 和 ||：' + token);
    const [, operator = '=', target] = match, result = compare(version, target);
    if (operator === '=') return result === 0;
    if (operator === '>=') return result >= 0; if (operator === '<=') return result <= 0;
    if (operator === '>') return result > 0; if (operator === '<') return result < 0;
    const bound = parts(target);
    const index = operator === '~' ? 1 : Math.max(0, bound.findIndex(n => n !== 0));
    bound[index]++; for (let i = index + 1; i < bound.length; i++) bound[i] = 0;
    return result >= 0 && compare(version, bound.join('.')) < 0;
  }).every(Boolean)).some(Boolean);
}
function ranges(value) { if (!Array.isArray(value) || !value.length || value.length > 20) throw Error('兼容版本必须为非空数组'); for (const range of value) satisfies('0.0.0', range); return value; }
function compatibility(manifest, versions) {
  const reasons = [];
  if (manifest.apiVersion !== versions.apiVersion) reasons.push(`需要 Forge API ${manifest.apiVersion}，当前 ${versions.apiVersion}`);
  for (const key of ['codex', 'forge']) if (!ranges(manifest.compatibility?.[key]).some(range => satisfies(versions[key], range))) reasons.push(`${key} ${versions[key]} 不在声明兼容范围内`);
  return { compatible: reasons.length === 0, reasons };
}
module.exports = { parts, compare, satisfies, ranges, compatibility };
