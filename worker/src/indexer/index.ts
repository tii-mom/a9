/** 索引器唯一出口：backend-dev 在 worker/src/index.ts 只 import 这里。 */
export { tick, reconcile } from './sync';
export type { IndexerTickResult } from './sync';
