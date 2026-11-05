/** 工具链探测与配置化命令执行（默认 dry-run，绝不读取/打印私钥）。 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BAM_ROOT, resolvePath } from './config.mjs';
import { parseAddress } from './ton.mjs';

export function which(bin) {
  if (!bin) return null;
  const result = spawnSync('bash', ['-lc', 'command -v ' + bin], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const path = String(result.stdout || '').trim();
  return path || null;
}

export function versionOf(bin) {
  if (!bin || !which(bin)) return null;
  const result = spawnSync('bash', ['-lc', bin + ' --version'], { encoding: 'utf8', timeout: 15000 });
  const text = String(result.stdout || '').trim() || String(result.stderr || '').trim();
  return text.split(String.fromCharCode(10))[0] || null;
}

export function activeAdapter(params) {
  const name = params.toolchain.activeAdapter;
  const adapter = params.toolchain.adapters[name];
  if (!adapter) throw new Error('toolchain.activeAdapter 指向不存在的适配器：' + name);
  return { name, adapter };
}

export function hasCommand(params, commandName) {
  const { adapter } = activeAdapter(params);
  return Boolean(adapter.commands && adapter.commands[commandName]);
}

export function commandTemplate(params, commandName) {
  const { name, adapter } = activeAdapter(params);
  const template = adapter.commands && adapter.commands[commandName];
  if (!template) {
    throw new Error('适配器 ' + name + ' 未定义命令模板：' + commandName);
  }
  return template;
}

/** 使用 {name} 占位符替换（split/join，避免正则与 shell 展开）。 */
export function substitute(template, vars) {
  let text = String(template);
  for (const [key, value] of Object.entries(vars)) {
    text = text.split('{' + key + '}').join(String(value ?? ''));
  }
  return text;
}

export function unresolvedPlaceholders(command) {
  const parts = String(command).split('{');
  const found = [];
  for (let index = 1; index < parts.length; index++) {
    const end = parts[index].indexOf('}');
    if (end > 0) found.push('{' + parts[index].slice(0, end) + '}');
  }
  return found;
}

/**
 * 执行命令。execute=false 时只回显，不执行。
 */
export function runCommand(command, { execute = false, timeoutMs = 180000 } = {}) {
  const missing = unresolvedPlaceholders(command);
  if (missing.length) throw new Error('命令存在未替换的占位符：' + missing.join(', ') + ' -> ' + command);
  if (!execute) return { executed: false, command, status: null, stdout: '', stderr: '' };
  const result = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return {
    executed: true,
    command,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/** 从命令输出中提取第一个合法 TON 地址。 */
export function extractAddress(text) {
  const tokens = String(text || '').split(/[\s'"<>()\[\],;]+/);
  for (const token of tokens) {
    const cleaned = token.replace(/[.,:;!?]+$/, '');
    if (parseAddress(cleaned).ok) return cleaned;
    const rawMatch = cleaned.match(/0:[0-9a-fA-F]{64}/);
    if (rawMatch && parseAddress(rawMatch[0]).ok) return rawMatch[0];
  }
  return null;
}

export function toolchainStatus(params) {
  const { name, adapter } = activeAdapter(params);
  const bin = adapter.bin ? which(adapter.bin) : null;
  return {
    adapter: name,
    bin: adapter.bin,
    binPath: bin,
    available: Boolean(bin) || name === 'manual',
    version: adapter.bin ? versionOf(adapter.bin) : null,
    pinned: Boolean(params.toolchain.pinned),
    contractsDir: resolvePath(params.toolchain.contractsDir, BAM_ROOT),
    contractsDirExists: existsSync(resolvePath(params.toolchain.contractsDir, BAM_ROOT)),
    buildDir: resolvePath(params.toolchain.buildDir, BAM_ROOT),
    buildDirExists: existsSync(resolvePath(params.toolchain.buildDir, BAM_ROOT)),
    note: adapter.note || null,
  };
}
