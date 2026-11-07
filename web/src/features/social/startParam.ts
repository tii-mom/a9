/**
 * 启动参数解析与待绑定码的本地持久化。
 * start_param 形如 r_<邀请码>_s_<战队码>（也可只带其中一段）；普通网页用 ?ref=&squad=&src=x。
 */
import type { SocialSource } from './types';

/** 邀请码 / 战队码：字母数字，2–32 位。 */
const CODE_PATTERN = /^[A-Za-z0-9]{2,32}$/;
const REF_PATTERN = /(?:^|_)r_([A-Za-z0-9]+)/;
const SQUAD_PATTERN = /(?:^|_)s_([A-Za-z0-9]+)/;

/** localStorage key。 */
export const PENDING_KEY = 'a9.social.pending';

export interface LaunchCodes {
  ref?: string;
  squad?: string;
  source: SocialSource;
}

export interface PendingCodes {
  ref?: string;
  squad?: string;
  source: SocialSource;
}

/** 从 start_param 取出邀请码与战队码（不合法的段直接忽略）。 */
export function parseStartParam(raw: string | null | undefined): { ref?: string; squad?: string } {
  const out: { ref?: string; squad?: string } = {};
  if (!raw) return out;
  const ref = REF_PATTERN.exec(raw);
  const squad = SQUAD_PATTERN.exec(raw);
  if (ref && CODE_PATTERN.test(ref[1])) out.ref = ref[1];
  if (squad && CODE_PATTERN.test(squad[1])) out.squad = squad[1];
  return out;
}

function validCode(value: string | null): string | undefined {
  return value && CODE_PATTERN.test(value) ? value : undefined;
}

/**
 * 综合 start_param 与 URL 查询参数得到本次启动的码。start_param 优先。
 * 来源：?src=x 为 x；在 Telegram 内为 tg；其余为 web。
 */
export function parseLaunchCodes(input: { startParam?: string | null; search?: string; inTelegram: boolean }): LaunchCodes {
  const fromParam = parseStartParam(input.startParam);
  const params = new URLSearchParams(input.search ?? '');
  const src = params.get('src');
  const source: SocialSource = src === 'x' ? 'x' : input.inTelegram ? 'tg' : 'web';
  return {
    ref: fromParam.ref ?? validCode(params.get('ref')),
    squad: fromParam.squad ?? validCode(params.get('squad')),
    source,
  };
}

/** 默认取 window.localStorage；不可用（隐私模式 / 非浏览器）时返回 null。 */
export function defaultStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isSource(value: unknown): value is SocialSource {
  return value === 'tg' || value === 'x' || value === 'web';
}

/** 读取待绑定码；损坏或不可用时返回 null。 */
export function readPending(storage: Storage | null = defaultStorage()): PendingCodes | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingCodes> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const ref = validCode(typeof parsed.ref === 'string' ? parsed.ref : null);
    const squad = validCode(typeof parsed.squad === 'string' ? parsed.squad : null);
    if (!ref && !squad) return null;
    return { ref, squad, source: isSource(parsed.source) ? parsed.source : 'web' };
  } catch {
    return null;
  }
}

/**
 * 合并新到的码：已存的 ref / squad 优先保留（与服务端「首次绑定为准」一致）；
 * 只补充之前为空的字段。两者都没有时返回原值。
 */
export function mergePending(previous: PendingCodes | null, incoming: LaunchCodes): PendingCodes | null {
  const ref = previous?.ref ?? incoming.ref;
  const squad = previous?.squad ?? incoming.squad;
  if (!ref && !squad) return previous;
  return { ref, squad, source: previous?.source ?? incoming.source };
}

/** 写入待绑定码；失败静默。 */
export function writePending(value: PendingCodes, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    /* 隐私模式或配额不足：放弃本地持久化 */
  }
}

/** 清除待绑定码；失败静默。 */
export function clearPending(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/** 把本次启动的码合并进本地待绑定记录（首次出现的码优先）。无码时不写。 */
export function persistLaunchCodes(codes: LaunchCodes, storage: Storage | null = defaultStorage()): PendingCodes | null {
  const merged = mergePending(readPending(storage), codes);
  if (merged) writePending(merged, storage);
  return merged;
}
