/**
 * 社交层单测用的最小 Node 类型声明：worker 的 tsconfig 不包含 @types/node。
 * 只声明测试实际用到的表面；运行时由 Node 提供真实实现（见 junxiang-db.test.ts）。
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}

interface ImportMeta {
  readonly url: string;
}
