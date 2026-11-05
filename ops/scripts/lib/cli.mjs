/** 极简 CLI 参数解析与执行开关。 */

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  const isFlag = (value) => typeof value === 'string' && value.startsWith('--');
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (isFlag(token)) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        args[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (argv[i + 1] && !isFlag(argv[i + 1])) {
        args[body] = argv[++i];
      } else {
        args[body] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

export function flag(args, name) {
  const value = args[name];
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

export function str(args, name, fallback = undefined) {
  const value = args[name];
  if (value === undefined || value === true) return fallback;
  return String(value);
}

/** 默认 dry-run；--execute 或 OPS_EXECUTE=1 才执行真实操作。 */
export function isExecute(args) {
  return flag(args, 'execute') || process.env.OPS_EXECUTE === '1';
}

export function requireConfirm(actionName) {
  if (process.env.OPS_CONFIRM === 'YES') return true;
  throw new Error('拒绝执行「' + actionName + '」：需要显式确认。请在命令前加 OPS_CONFIRM=YES。');
}

export function requireEnv(name, hint = '') {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error('缺少环境变量 ' + name + (hint ? '（' + hint + '）' : ''));
  }
  return value.trim();
}

export function optionalEnv(name, fallback = null) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}
