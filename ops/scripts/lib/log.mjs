/** 统一日志：层级、颜色、dry-run 标记；绝不打印任何密钥内容。 */

const ESC = String.fromCharCode(27);
const NL = String.fromCharCode(10);
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (COLOR ? ESC + '[' + code + 'm' + s + ESC + '[0m' : s);
const dim = wrap('2');
const red = wrap('31');
const green = wrap('32');
const yellow = wrap('33');
const cyan = wrap('36');
const bold = wrap('1');

const counters = { checks: 0, pass: 0, fail: 0, warn: 0 };

export function section(title) {
  console.log(NL + bold('== ' + title + ' =='));
}

export function step(id, title) {
  console.log(NL + cyan('[' + id + ']') + ' ' + bold(title));
}

export function info(msg) { console.log('  ' + msg); }
export function detail(msg) { console.log('  ' + dim(msg)); }
export function bullet(msg) { console.log('  - ' + msg); }
export function kv(key, value) { console.log('  ' + dim(String(key).padEnd(28)) + ' ' + value); }

export function ok(msg) { counters.checks++; counters.pass++; console.log('  ' + green('[PASS]') + ' ' + msg); }
export function fail(msg) { counters.checks++; counters.fail++; console.log('  ' + red('[FAIL]') + ' ' + msg); }
export function warn(msg) { counters.warn++; console.log('  ' + yellow('[WARN]') + ' ' + msg); }
export function err(msg) { console.log('  ' + red('[ERROR]') + ' ' + msg); }
export function skip(msg) { counters.checks++; console.log('  ' + dim('[SKIP]') + ' ' + msg); }

export function dryRunBanner(execute) {
  if (execute) {
    console.log(yellow('  [EXECUTE] 真实网络操作已开启：请再次确认参数、地址与密钥来源。'));
  } else {
    console.log(dim('  [DRY-RUN] 仅校验与打印计划，不发任何链上消息。设置 OPS_EXECUTE=1 才执行。'));
  }
}

export function summary(extra = {}) {
  const total = counters.checks;
  const parts = [
    total + ' checks',
    counters.pass + ' pass',
    counters.fail ? red(counters.fail + ' fail') : '0 fail',
    counters.warn ? yellow(counters.warn + ' warn') : '0 warn',
  ];
  console.log(NL + bold('SUMMARY') + ' ' + parts.join(' / '));
  for (const [key, value] of Object.entries(extra)) console.log('  ' + dim(String(key).padEnd(28)) + ' ' + value);
  return counters.fail > 0 ? 1 : 0;
}

export function resetCounters() {
  counters.checks = 0;
  counters.pass = 0;
  counters.fail = 0;
  counters.warn = 0;
}

/** 表格输出（中文按 2 列宽近似，便于值班日志阅读）。 */
export function table(headers, rows) {
  const width = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((row) => width(row[i] ?? ''))));
  const line = (cells) => cells.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log('  ' + dim(line(headers)));
  console.log('  ' + dim(widths.map((w) => '-'.repeat(w)).join('  ')));
  for (const row of rows) console.log('  ' + line(row));
}
