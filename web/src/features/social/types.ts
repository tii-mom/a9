/**
 * 社交层前端类型。契约以 @shared/types 为准（即 worker/src/social 的请求 / 响应形状），
 * 本文件只做再导出与前端别名，不再自行推定字段。
 */
import type { SocialGateResponse, SocialMeResponse, SocialRoundPhase, SocialLeaderboardType, SocialLeaderboardScope, SocialSquadBrief } from '@shared/types';

export type {
  SocialBindRequest,
  SocialBindResponse,
  SocialGateResponse,
  SocialLeaderboardResponse,
  SocialLeaderboardRow,
  SocialMeResponse,
  SocialSquadBrief,
  SocialSquadCreateRequest,
  SocialSquadDetail,
  SocialSquadJoinRequest,
  SocialSquadResponse,
  SocialSource,
} from '@shared/types';

/** 破城进度所处阶段：集结 / 攻城 / 守城 / 已结算（后端 SocialRoundPhase）。 */
export type GatePhase = SocialRoundPhase;

/** 榜单类型：战队榜 / 战力榜 / 带兵榜。 */
export type LeaderboardType = SocialLeaderboardType;

/** 榜单范围：本城 / 赛季。 */
export type LeaderboardScope = SocialLeaderboardScope;

/** 可分享的时刻：上车成功 / 成团 / 破城 / 阵亡（纯前端文案用，不进契约）。 */
export type ShareMoment = 'join' | 'squad' | 'breach' | 'fallen' | 'claim';

/** 战队摘要（后端 SocialSquadBrief：level 与 memberCount 直接展示，不在前端重算）。 */
export type SquadInfo = SocialSquadBrief;

/** 个人统计（后端 SocialMeResponse.stats；power 为 A9 raw 字符串）。 */
export type SocialStats = SocialMeResponse['stats'];

/** GET /api/social/me 响应。 */
export type SocialMe = SocialMeResponse;

/** GET /api/social/gate 响应（破城进度条数据）。 */
export type GateState = SocialGateResponse;
