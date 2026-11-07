// 仅供 worker 单测的类型检查：tsconfig 没有 @types/node，这里声明 tonproof.test.ts 用到的 node:sqlite 子集。
// 运行时由 Node 提供真实模块（见 package.json 的 test:auth）。
declare module 'node:sqlite' {
  interface StatementLike {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementLike;
  }
}
