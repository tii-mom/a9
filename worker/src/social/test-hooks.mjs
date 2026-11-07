/**
 * 社交层单测的解析钩子：Node 直接运行 .ts 时，把无扩展名的相对导入（'./power'）解析为同名 .ts 文件。
 * 仅用于 worker/src/social 的单测，不参与 Worker 打包。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
    const candidate = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
}
