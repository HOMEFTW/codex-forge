'use strict';
// Ikaleio/lm-detector (MIT). Original sources and hashes: vendor/lm-detector.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { analyzeSharedOutputs, supportsSharedDetector, decodeDetector, parseNumbers } = require('./information-detector.cjs');
const provenance = require('./information-provenance.json');
const references = require('./information-reference.json');
const challenges = require('./information-challenges.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bankBytes = fs.readFileSync(path.join(__dirname, 'information-bank.json'));
const detectorBytes = fs.readFileSync(path.join(__dirname, 'information-detector.bin'));
if (hash(bankBytes) !== provenance.bankSHA256 || hash(detectorBytes) !== provenance.detectorSHA256
  || hash(fs.readFileSync(path.join(__dirname, 'information-challenges.json'))) !== provenance.challengeSHA256
  || hash(fs.readFileSync(path.join(__dirname, 'information-reference.json'))) !== provenance.referenceProfileSHA256) {
  throw new Error('指纹库、挑战或评分器摘要不匹配，请重新安装完整的 Forge 文件');
}
const bank = JSON.parse(bankBytes);
const detector = decodeDetector(detectorBytes);
if (!supportsSharedDetector(bank, detector) || detector.source_reference_sha256 !== bank.reference_sha256) {
  throw new Error('指纹库与离线评分器不匹配');
}
const ENGINE_VERSION = 'lm-detector:' + provenance.commit + ':' + provenance.detectorSHA256 + ':' + provenance.challengeSHA256 + ':' + provenance.referenceProfileSHA256;
const normalize = value => String(value || '').trim().toLowerCase().replace(/^.*\//, '').replace(/[_ ]/g, '-').replace(/^gpt(\d)/, 'gpt-$1');
function aliases(model) {
  if (model.id === 'gpt-6-astra') return ['gpt-6-astra', 'gpt-6.1-sol'];
  if (model.id === 'claude-haiku-4.5') return [model.id, 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'];
  return [...new Set([model.id, ...(model.id.startsWith('claude-') ? [model.id.replaceAll('.', '-')] : [])])];
}
function modelClass(name) { return bank.models.find(model => aliases(model).some(alias => normalize(alias) === normalize(name))); }

function analyzeGlobalOutputs(outputs, selectedBank = bank) {
  const analysis = analyzeSharedOutputs(outputs, selectedBank, detector, { allowPartial: true });
  if (!analysis.used_outputs) throw new Error('没有可用回答：请粘贴完整数字序列；拒答或严重截断的回答不会计入。');
  const results = analysis.results.map(result => ({ ...result,
    aliases: aliases(bank.models.find(model => model.id === result.model)),
  }));
  return { ...analysis, results, engineVersion: ENGINE_VERSION };
}

function samplingContext(analysis, model, effort, standardChallenge) {
  const declared = modelClass(model);
  const efforts = references[declared?.id]?.efforts || [];
  const compatible = Boolean(effort && efforts.includes(effort) && standardChallenge);
  const reason = !standardChallenge ? '外部样本的挑战条件未确认，仅显示候选排名。'
    : !effort || !efforts.includes(effort) ? '当前思考强度 ' + (effort || '未知') + '；参考数据为 ' + (efforts.join(' / ') || '未记录') + '，仅显示候选排名。'
      : '沿用当前思考强度；概率仅在参考库内比较，不能认证真实模型身份。';
  return { ...analysis, sampling: { effort: effort || '', referenceEfforts: efforts, compatible, standardChallenge, reason },
    probability: compatible ? analysis.probability : null,
    calibration: compatible ? analysis.calibration : null,
    probability_status: compatible ? analysis.probability_status : 'sampling_conditions_differ',
    results: analysis.results.map(item => ({ ...item, probability: compatible ? item.probability : null })),
  };
}
module.exports = { analyzeGlobalOutputs, parseNumbers, modelClass, aliases, samplingContext, ENGINE_VERSION, challenges, bank, provenance };
