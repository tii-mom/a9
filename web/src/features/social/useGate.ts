import { socialApi, useQuery } from '../../lib/api';

/** 破城进度轮询间隔。useQuery 在标签页隐藏时自动暂停。 */
export const GATE_POLL_MS = 15_000;

/** 当前城的破城进度（GET /api/social/gate，每 15 秒刷新）。 */
export function useGate() {
  return useQuery(() => socialApi.gate(), [], { intervalMs: GATE_POLL_MS });
}
