#!/usr/bin/env node
/**
 * monitor_watch — run monitor_check every --every seconds (default 60) with --notify, forever.
 * Run on the same host as the keeper (it reads the keeper heartbeat and price samples in ops/records).
 * Alerts are de-duplicated by monitor_check (same alert at most every --repeat-min, recovery notes on clear).
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_OPS_CHAT_ID=... OPS_PARAMS=ops/config/mainnet.params.json \
 *     node ops/scripts/monitor_watch.mjs --every 60 -- --api https://a9.lat --chain --expect-keeper 1
 * Everything after `--` is passed to monitor_check.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const pass = sep >= 0 ? argv.slice(sep + 1) : [];
const everyIdx = own.indexOf('--every');
const every = Number(everyIdx >= 0 ? own[everyIdx + 1] : 60);
const once = own.includes('--once');
const script = join(dirname(fileURLToPath(import.meta.url)), 'monitor_check.mjs');

for (;;) {
  const r = spawnSync(process.execPath, [script, ...pass, '--notify'], { encoding: 'utf8', env: process.env, timeout: 120000 });
  const tail = String(r.stdout || '').trim().split('\n').slice(-3).join(' | ');
  console.log(new Date().toISOString(), 'exit', r.status, tail.slice(0, 300));
  if (once) break;
  await new Promise((res) => setTimeout(res, every * 1000));
}
