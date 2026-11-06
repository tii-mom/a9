// 仅供类型检查：worker 的 tsconfig 没有 @types/node，这里声明测试用到的最小子集。
// 运行时由 Node 提供真实模块，见 test/register.mjs。
declare module 'node:test' {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
  export function describe(name: string, fn: () => unknown): void;
}

declare module 'node:assert/strict' {
  interface StrictAssert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    rejects(fn: () => Promise<unknown>, message?: string): Promise<void>;
  }
  const assert: StrictAssert;
  export default assert;
}

// initData 单测的参考 HMAC（独立于被测的 Web Crypto 实现）。
declare module 'node:crypto' {
  interface HmacLike {
    update(data: string | Uint8Array): HmacLike;
    digest(): Uint8Array;
    digest(encoding: 'hex'): string;
  }
  export function createHmac(algorithm: string, key: string | Uint8Array): HmacLike;
}
