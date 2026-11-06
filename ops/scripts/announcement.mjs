#!/usr/bin/env node
/** announcement — 从 ops/templates/announcements.json 渲染公告（默认只打印，--post-telegram 才发送）。 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, str } from './lib/cli.mjs';
import { BAM_ROOT, RECORDS_DIR, asBigInt, formatTokens, loadAndValidate } from './lib/config.mjs';
import { loadRegistry } from './lib/registry.mjs';
import { section, kv, ok, fail, warn, info, detail, summary } from './lib/log.mjs';

const OPS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name) return args[i + 1];
    if (args[i].startsWith('--' + name + '=')) return args[i].slice(name.length + 3);
  }
  return fallback;
};

const type = getArg('type');
const lang = getArg('lang', 'zh');
const apiBase = getArg('api', process.env.OPS_WORKER_BASE_URL || null);
const outPath = getArg('out');
const dataPath = getArg('data');
const postTelegram = args.includes('--post-telegram');

const templatesFile = join(OPS_ROOT, 'templates', 'announcements.json');
const templates = JSON.parse(readFileSync(templatesFile, 'utf8'));
const { params, errors, digest } = loadAndValidate();
if (errors.length) { for (const message of errors) fail(message); process.exit(1); }
const registry = loadRegistry();

section('公告渲染');
kv('模板库', templatesFile);
kv('类型', type || '（未指定）');
kv('语言', lang);
kv('配置哈希', digest);

if (!type) {
  fail('缺少 --type；可用：' + Object.keys(templates.templates).join(', '));
  process.exit(summary() || 1);
}
const template = templates.templates[type];
if (!template) {
  if (type === 'stake-close' || type === 'open') {
    fail('未知公告类型：' + type + '；可用：' + Object.keys(templates.templates).join(', '));
  } else {
    fail('未知公告类型：' + type + '；可用：' + Object.keys(templates.templates).join(', '));
  }
  process.exit(summary() || 1);
}

function loadData() {
  if (dataPath) return JSON.parse(readFileSync(dataPath, 'utf8'));
  return {};
}

async function apiGet(path) {
  const response = await fetch(apiBase.replace(/\/$/, '') + path, { signal: AbortSignal.timeout(10000) });
  const json = await response.json();
  if (!json || json.ok !== true) throw new Error('API 返回错误：' + path);
  return json.data;
}

const data = loadData();
const roundId = Number(getArg('round', data.roundId || 1));

if (apiBase && data.auto !== false) {
  try {
    const [config, round] = await Promise.all([apiGet('/api/config'), apiGet('/api/rounds/' + roundId)]);
    data.config = data.config || config;
    data.round = data.round || round;
  } catch (error) {
    warn('未能从 API 读取轮次数据（继续使用 --data/默认值）：' + String(error.message || error));
  }
}

const round = data.round || {};
const config = data.config || {};
const targetUsdE8 = data.targetUsdE8 || round.targetPriceUsdE8 || params.price.ladderRefUsdE8[String(data.tier || roundId)] || params.price.p0UsdE8;
const fmtUsd = (usdE8) => {
  if (usdE8 === undefined || usdE8 === null || usdE8 === '') return '—';
  const value = BigInt(String(usdE8));
  const whole = value / 100000000n;
  const frac = (value % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return '$' + whole + (frac ? '.' + frac : '');
};
const fmtTime = (value) => {
  if (value === undefined || value === null || value === '') return '待定';
  const ms = Number(value) > 1e12 ? Number(value) : Number(value) * 1000;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};
const tokens = (raw) => {
  if (raw === undefined || raw === null || raw === '') return '—';
  try { return formatTokens(String(raw), 9); } catch { return String(raw); }
};

const stakeTotalRaw = data.stakeTotalRaw || round.totalAcceptedStakeRaw || '0';
const stakerCount = data.stakerCount !== undefined ? data.stakerCount : (round.stakerCount !== undefined ? round.stakerCount : 0);
const qualified = data.qualified !== undefined ? data.qualified : (round.qualifiedCandles !== undefined ? round.qualifiedCandles : 0);
const burnedRewardRaw = data.burnedRewardRaw || params.rounds.roundRewardRaw;
const burnedTeamRaw = data.burnedTeamRaw || params.rounds.teamRoundRaw;
const burnedPrincipalRaw = data.burnedPrincipalRaw || (type === 'fail' ? stakeTotalRaw : '0');
const burnedTotalRaw = data.burnedTotalRaw || (asBigInt(burnedRewardRaw) + asBigInt(burnedTeamRaw) + asBigInt(burnedPrincipalRaw)).toString();

const values = {
  roundId: String(roundId),
  tier: String(data.tier || round.priceMultiplier ? (data.tier || Math.round(Math.log2(Number(round.priceMultiplier || 2)))) : roundId),
  targetUsd: fmtUsd(targetUsdE8),
  p0Usd: params.price.p0Usd,
  previewEnd: fmtTime(data.previewEnd || round.previewEnd),
  stakeOpenAt: fmtTime(data.stakeOpenAt || round.stakeOpenAt),
  stakeCloseAt: fmtTime(data.stakeCloseAt || round.stakeCloseAt),
  observationStart: fmtTime(data.observationStart || round.observationStart),
  observationEnd: fmtTime(data.observationEnd || round.observationEnd),
  stakeTotal: tokens(stakeTotalRaw),
  stakerCount: String(stakerCount),
  qualified: String(qualified),
  candleCount: String(params.timeline.candleCount),
  rewardTokens: tokens(params.rounds.roundRewardRaw),
  teamTokens: tokens(params.rounds.teamRoundRaw),
  burnedTotal: tokens(burnedTotalRaw),
  burnedReward: tokens(burnedRewardRaw),
  burnedTeam: tokens(burnedTeamRaw),
  burnedPrincipal: tokens(burnedPrincipalRaw),
  closeReason: data.closeReason || '36 小时报名窗口到期正常关闭',
  abortReason: data.abortReason || '观察应结束后 7 天仍未判定，或预告结束后 7 天仍未开轮',
  nextRoundId: String(data.nextRoundId || Math.min(roundId + 1, 10)),
  claimNote: data.claimNote || '本金 + 全额奖励一次领取（Claim / ClaimAll，用户自付 gas）',
  siteUrl: data.siteUrl || 'https://a9.lat',
};

const missing = new Set();
function renderLine(line) {
  return String(line).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (values[key] === undefined) { missing.add(key); return match; }
    return values[key];
  });
}

const languages = lang === 'both' ? ['zh', 'en'] : [lang];
const blocks = [];
for (const language of languages) {
  if (!['zh', 'en'].includes(language)) { fail('--lang 只支持 zh / en / both'); process.exit(summary() || 1); }
  const lines = (template[language] || []).map(renderLine);
  if (missing.size) {
    fail('模板占位符缺少取值：' + [...missing].join(', '));
    process.exit(summary() || 1);
  }
  lines.push('');
  lines.push(...(templates.mandatoryDisclaimers[language] || []).map((line) => '> ' + line));
  lines.push('');
  lines.push((language === 'zh' ? '官网：' : 'Official site: ') + values.siteUrl);
  blocks.push('## ' + template.label + '（' + language.toUpperCase() + '）' + String.fromCharCode(10) + String.fromCharCode(10) + lines.join(String.fromCharCode(10)));
}

const output = '# A9 公告 · ' + template.label + String.fromCharCode(10) + String.fromCharCode(10) + blocks.join(String.fromCharCode(10, 10));
console.log(String.fromCharCode(10) + output);

if (outPath) {
  const file = outPath.startsWith('/') ? outPath : join(BAM_ROOT, outPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, output, 'utf8');
  ok('公告已写入：' + file);
}

if (postTelegram) {
  if (process.env.OPS_CONFIRM !== 'YES') {
    fail('发送公告需要 OPS_CONFIRM=YES（人工确认文案后再发）');
    process.exit(summary() || 1);
  }
  const token = process.env[params.notifications.telegram.botTokenEnv];
  const chatId = process.env[params.notifications.telegram.chatIdEnv];
  if (!token || !chatId) {
    fail('缺少 ' + params.notifications.telegram.botTokenEnv + ' / ' + params.notifications.telegram.chatIdEnv);
    process.exit(summary() || 1);
  }
  for (const block of blocks) {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: block.slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) warn('Telegram 发送失败：HTTP ' + response.status);
    else ok('已发送一段公告到 Telegram');
  }
} else {
  info('未发送：确认文案后加 --post-telegram 并设置 OPS_CONFIRM=YES。');
}

const outputFile = outPath || join(RECORDS_DIR, 'announcement-' + type + '-r' + roundId + '.md');
process.exit(summary({ 类型: type, 轮次: roundId, 输出: outPath ? '已写入' : '未落盘（加 --out 保存）' }));
