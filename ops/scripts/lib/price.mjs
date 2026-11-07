/**
 * price.mjs — production price source for the keeper (v11).
 *
 * Source of truth: the official STON.fi v2 A9/USDT pool's on-chain reserves (docs/35 §2: "数据只取官方 STON.fi 池链上储备").
 *   spot priceUsdE8 = usdtReserve × 10^(8 + a9Decimals − quoteDecimals) / a9Reserve
 * The keeper samples spot every `intervalSec` into an append-only JSONL file; candles use the
 * time-weighted average (TWAP) of those samples, and the on-chain dataDigest is sha256 of the
 * exact samples used, so anyone holding the evidence file can recompute both.
 *
 * Pure functions (twapOf, digestOf, priceFromReserves) are unit-tested in ops/tests/price.test.mjs.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runGetMethod, stackItemToBigInt, addressFromStackItem, parseAddress } from './ton.mjs';

/** spot price in USD×1e8 from raw reserves (integer math, floor). */
export function priceFromReserves(a9Raw, quoteRaw, a9Decimals = 9, quoteDecimals = 6) {
  if (a9Raw <= 0n || quoteRaw <= 0n) return 0n;
  const shift = 8 + a9Decimals - quoteDecimals;
  return shift >= 0 ? (quoteRaw * 10n ** BigInt(shift)) / a9Raw : quoteRaw / (a9Raw * 10n ** BigInt(-shift));
}

/**
 * Time-weighted average over [from, to) of a step function built from samples (each sample's
 * price holds until the next sample, at most `maxHoldSec`). The last sample at or before `from`
 * anchors the start. Returns { twapE8, coverage (0..1), used (samples), n }.
 */
export function twapOf(samples, from, to, maxHoldSec = 300) {
  const sorted = samples.filter((s) => s.priceE8 > 0n).sort((a, b) => a.t - b.t);
  let anchorIdx = -1;
  for (let i = 0; i < sorted.length && sorted[i].t <= from; i++) anchorIdx = i;
  const used = sorted.filter((s, i) => i === anchorIdx || (s.t > from && s.t < to));
  let weighted = 0n;
  let covered = 0;
  for (let i = 0; i < used.length; i++) {
    const start = Math.max(used[i].t, from);
    const next = i + 1 < used.length ? used[i + 1].t : to;
    const end = Math.min(next, to, used[i].t + maxHoldSec);
    if (end > start) {
      weighted += used[i].priceE8 * BigInt(end - start);
      covered += end - start;
    }
  }
  const twapE8 = covered > 0 ? weighted / BigInt(covered) : 0n;
  return { twapE8, coverage: covered / (to - from), used, n: used.length };
}

/** sha256 over canonical "t,priceE8\n" lines of the samples used → uint256 (as BigInt) + hex. */
export function digestOf(used) {
  const text = used.map((s) => `${s.t},${s.priceE8}`).join('\n');
  const hex = createHash('sha256').update(text).digest('hex');
  return { hex, value: BigInt('0x' + hex) };
}

export function loadSamples(file, sinceSec = 0) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.t >= sinceSec) out.push({ t: r.t, priceE8: BigInt(r.priceE8) });
    } catch { /* skip a torn last line */ }
  }
  return out;
}

/** On-chain pool reader. Identifies which reserve is A9 by matching the pool's A9 jetton wallet. */
export function poolSource(params, { pool, a9Master, a9Decimals = 9, quoteDecimals = 6 }) {
  let a9Side = null; // 0 | 1
  return {
    name: 'stonfi-pool',
    async spot() {
      const r = await runGetMethod(params, pool, 'get_pool_data');
      if (r.exit_code !== 0 && r.exit_code !== undefined) throw new Error('get_pool_data exit ' + r.exit_code);
      const s = r.stack;
      const reserve0 = stackItemToBigInt(s[3]);
      const reserve1 = stackItemToBigInt(s[4]);
      if (a9Side === null) {
        const raw = (item) => { const a = addressFromStackItem(item); return a ? a.wc + ':' + a.hashHex : null; };
        const w0 = raw(s[5]);
        const w1 = raw(s[6]);
        // Ask each pool token wallet for its jetton master (on-chain; the v3 index may not list pool wallets).
        const masterOf = async (w) => { const d = await runGetMethod(params, w, 'get_wallet_data'); return raw(d.stack[2]); };
        const want = parseAddress(a9Master).raw;
        if ((await masterOf(w0)) === want) a9Side = 0;
        else if ((await masterOf(w1)) === want) a9Side = 1;
        else throw new Error('pool does not hold the A9 jetton (master ' + want + ')');
      }
      const a9Raw = a9Side === 0 ? reserve0 : reserve1;
      const quoteRaw = a9Side === 0 ? reserve1 : reserve0;
      return { priceE8: priceFromReserves(a9Raw, quoteRaw, a9Decimals, quoteDecimals), a9Raw, quoteRaw };
    },
  };
}

/** Testnet stand-in (no STON.fi pool on testnet): price from a JSON file {"priceE8": "..."} or a fixed value. */
export function mockSource({ file, fixedE8 }) {
  return {
    name: 'mock',
    async spot() {
      if (file && existsSync(file)) return { priceE8: BigInt(JSON.parse(readFileSync(file, 'utf8')).priceE8) };
      return { priceE8: BigInt(fixedE8 || '116000') };
    },
  };
}

/** Sample once and append to the samples file; returns the sample (or null on read error). */
export async function sampleOnce(source, file, log) {
  try {
    const r = await source.spot();
    const t = Math.floor(Date.now() / 1000);
    if (r.priceE8 <= 0n) throw new Error('non-positive price');
    appendFileSync(file, JSON.stringify({ t, priceE8: r.priceE8.toString(), a9Raw: r.a9Raw?.toString(), quoteRaw: r.quoteRaw?.toString() }) + '\n');
    return { t, priceE8: r.priceE8 };
  } catch (error) {
    log?.({ event: 'price-sample-failed', source: source.name, error: String(error?.message || error).slice(0, 200) });
    return null;
  }
}
