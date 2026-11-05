// Shared test fixtures / helpers for A9 contracts.

import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"
import "@acton/types/transaction"

import "@contracts/constants"
import "@contracts/types"
import "@contracts/mocks/MockJettonWallet"

// 1.2e8 A9 with 9 decimals
const TEAM_ROUND_RAW: uint128 = 120000000000000000;
// 7e8 A9 with 9 decimals
const ROUND_REWARD_RAW: uint128 = 700000000000000000;
// 10,000 A9
const MIN_STAKE_RAW: uint128 = 10000000000000;
// 200,000,000 A9
const MAX_TOTAL_STAKE_RAW: uint128 = 200000000000000000;

const P0_USD_E8: uint128 = 116000;
const CANDLE_SECONDS: uint32 = 3600;
const CANDLE_COUNT: uint8 = 24;
const MIN_QUALIFIED_CANDLES: uint8 = 16;
const PREVIEW_SECONDS: uint32 = 43200;
const STAKE_DURATION_SECONDS: uint32 = 129600;
const OBSERVATION_SECONDS: uint32 = 86400;
const TECH_ABORT_PAUSE_SECONDS: uint32 = 1209600;
const TECH_ABORT_OBS_TIMEOUT_SECONDS: uint32 = 604800;
const RISK_DISCLOSURE_VERSION: uint16 = 1;

// ---------------------------------------------------------------------------
// Mock Jetton Wallet
// ---------------------------------------------------------------------------

struct MockWalletHandle {
    address: address
}

fun deployMockWallet(owner: address, balance: coins): MockWalletHandle {
    val deployer = testing.treasury("mock-wallet-deployer");
    val storage = MockWalletStorage {
        owner,
        balance,
        transferCount: 0,
        lastTransferDest: null,
        lastTransferAmount: 0,
        burnCount: 0,
        lastBurnAmount: 0,
        autoAck: true,
    };
    val init = ContractState { code: build("MockJettonWallet"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    val res = net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("1"),
        dest: { stateInit: init },
        body: TopUpTons {},
    }));
    expect(res).toHaveSuccessfulDeploy({ to: addr });
    return { address: addr };
}

fun mockState(wallet: MockWalletHandle): MockWalletState {
    return net.runGetMethod<MockWalletState>(wallet.address, "get_mock_state");
}

// ---------------------------------------------------------------------------
// TeamVault
// ---------------------------------------------------------------------------

struct TeamVaultHandle {
    address: address
}

fun deployTeamVault(admin: address, teamWallet: address, jettonMaster: address): TeamVaultHandle {
    val deployer = testing.treasury("team-vault-deployer");
    val storage = TeamVaultStorage {
        config: TeamVaultConfig {
            admin,
            controller: null,
            configVersion: 1,
        },
        // placeholder; set once via SetJettonWallet after the owner contract is deployed
        params: TeamVaultParams {
            jettonWallet: admin,
            teamWallet,
            jettonMaster,
            teamRoundRaw: TEAM_ROUND_RAW,
        }.toCell(),
        rounds: [],
        pendingBurnIds: [],
        totalReleasedRaw: 0,
        totalBurnedRaw: 0,
        releasedCount: 0,
        burnedCount: 0,
    };
    val init = ContractState { code: build("TeamVault"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    val res = net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("2"),
        dest: { stateInit: init },
        body: TopUpTons {},
    }));
    expect(res).toHaveSuccessfulDeploy({ to: addr });
    return { address: addr };
}

fun setTeamVaultWallet(vault: TeamVaultHandle, from: address, wallet: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: vault.address,
        body: SetJettonWallet { wallet },
    }));
}

struct TeamVaultFixture {
    admin: address
    rc: address
    teamWallet: address
    jettonMaster: address
    vault: TeamVaultHandle
    wallet: MockWalletHandle
}

// Full-fidelity fixture: TeamVault deployed, its Jetton Wallet deployed with
// owner = TeamVault, wallet address wired, controller initialized to "rc".
fun setupTeamVault(fundedBalance: coins): TeamVaultFixture {
    val admin = testing.treasury("admin");
    val rc = testing.treasury("rc");
    val teamWallet = testing.treasury("team-wallet");
    val jettonMaster = testing.treasury("jetton-master");
    val vault = deployTeamVault(admin.address, teamWallet.address, jettonMaster.address);
    val wallet = deployMockWallet(vault.address, fundedBalance);
    expect(setTeamVaultWallet(vault, admin.address, wallet.address)).toHaveSuccessfulTx<SetJettonWallet>({
        from: admin.address,
        to: vault.address,
    });
    expect(sendInitController(vault, admin.address, rc.address)).toHaveSuccessfulTx<InitController>({
        from: admin.address,
        to: vault.address,
    });
    return {
        admin: admin.address,
        rc: rc.address,
        teamWallet: teamWallet.address,
        jettonMaster: jettonMaster.address,
        vault,
        wallet,
    };
}

fun teamVaultState(vault: TeamVaultHandle): TeamVaultState {
    return net.runGetMethod<TeamVaultState>(vault.address, "get_team_vault_state");
}

fun teamRoundState(vault: TeamVaultHandle, roundId: uint8): TeamRoundState {
    return net.runGetMethod<TeamRoundState>(vault.address, "get_round_state", [roundId]);
}

fun sendInitController(vault: TeamVaultHandle, from: address, controller: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: vault.address,
        body: InitController { controller },
    }));
}

fun sendRelease(vault: TeamVaultHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: vault.address,
        body: ReleaseTeamQuota { queryId: 1, roundId },
    }));
}

fun sendBurn(vault: TeamVaultHandle, from: address, roundId: uint8, burnId: uint256): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: vault.address,
        body: BurnTeamQuota { queryId: 2, roundId, burnId },
    }));
}

// ---------------------------------------------------------------------------
// Generic help
// ---------------------------------------------------------------------------

fun findResult(res: SendResultList, account: address): SendResult? {
    var i = 0;
    while (i < res.size()) {
        val item = res.at(i);
        if (item.tx.load().getAccountAddress() == account) {
            return item;
        }
        i += 1;
    }
    return null;
}


// ---------------------------------------------------------------------------
// RoundController
// ---------------------------------------------------------------------------

struct RoundControllerHandle {
    address: address
}

fun deployRoundController(
    admin: address,
    oracle: address,
    jettonMaster: address,
    teamVault: address,
): RoundControllerHandle {
    val deployer = testing.treasury("rc-deployer");
    val econ = ProtocolEcon {
        p0UsdE8: P0_USD_E8,
        priceMultiplier: 2,
        roundRewardRaw: ROUND_REWARD_RAW,
        teamRoundRaw: TEAM_ROUND_RAW,
        minStakeRaw: MIN_STAKE_RAW,
        maxStakePerAddressBps: 1000,
        maxTotalStakeRaw: MAX_TOTAL_STAKE_RAW,
    };
    val timing = ProtocolTiming {
        previewSeconds: PREVIEW_SECONDS,
        stakeDurationSeconds: STAKE_DURATION_SECONDS,
        candleSeconds: CANDLE_SECONDS,
        candleCount: CANDLE_COUNT,
        minQualifiedCandles: MIN_QUALIFIED_CANDLES,
        observationSeconds: OBSERVATION_SECONDS,
        techAbortPauseSeconds: TECH_ABORT_PAUSE_SECONDS,
        techAbortObsTimeoutSeconds: TECH_ABORT_OBS_TIMEOUT_SECONDS,
        riskDisclosureVersion: RISK_DISCLOSURE_VERSION,
        configVersion: 1,
    };
    val cfg = ProtocolConfig {
        addresses: ProtocolAddresses { admin, oracle, jettonMaster }.toCell(),
        // placeholder; wired once via SetJettonWallet after this contract is deployed
        vaults: ProtocolVaults { stakingJettonWallet: admin, teamVault }.toCell(),
        econ: econ.toCell(),
        timing: timing.toCell(),
    };
    val storage = Storage {
        config: cfg.toCell(),
        extras: emptyExtras().toCell(),
        currentRoundId: 0,
        successCount: 0,
        lastSettledAt: 0,
        pausedAt: 0,
        rounds: [],
        stakes: [],
    };
    val init = ContractState { code: build("RoundController"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    val res = net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("5"),
        dest: { stateInit: init },
        body: TopUpTons {},
    }));
    expect(res).toHaveSuccessfulDeploy({ to: addr });
    return { address: addr };
}

fun rcConfig(rc: RoundControllerHandle): ProtocolConfigView {
    return net.runGetMethod<ProtocolConfigView>(rc.address, "get_protocol_config");
}

fun rcRound(rc: RoundControllerHandle, roundId: uint8): RoundView {
    return net.runGetMethod<RoundView>(rc.address, "get_round", [roundId]);
}

fun rcStatus(rc: RoundControllerHandle, roundId: uint8): uint8 {
    return net.runGetMethod<uint8>(rc.address, "get_round_status", [roundId]);
}

fun rcClaimable(rc: RoundControllerHandle, owner: address): Claimable {
    return net.runGetMethod<Claimable>(rc.address, "get_claimable_all", [owner]);
}

fun rcUserStake(rc: RoundControllerHandle, roundId: uint8, owner: address): StakePosition {
    return net.runGetMethod<StakePosition>(rc.address, "get_user_stake", [roundId, owner]);
}

fun setRcWallet(rc: RoundControllerHandle, from: address, wallet: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: SetJettonWallet { wallet },
    }));
}

fun advance(seconds: int) {
    testing.setNow(((testing.getNow() as int) + seconds) as uint32);
}

fun openRound(rc: RoundControllerHandle, from: address, twap24h: uint128): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: rc.address,
        body: OpenRound { queryId: 0, twap24hUsdE8: twap24h },
    }));
}

fun closeStaking(rc: RoundControllerHandle, from: address, twap1h: uint128): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: CloseStaking { queryId: 0, twap1hUsdE8: twap1h },
    }));
}

fun startObservation(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: StartObservation { queryId: 0, roundId },
    }));
}

fun buildStakePayload(roundId: uint8, nonce: uint64, riskVersion: uint16, accept: uint8): cell {
    return beginCell()
        .storeUint(OP_STAKE_DEPOSIT, 32)
        .storeUint(1, 8)
        .storeUint(roundId, 8)
        .storeUint(nonce, 64)
        .storeUint(riskVersion, 16)
        .storeUint(accept, 8)
        .endCell();
}

fun sendStake(
    rc: RoundControllerHandle,
    walletSender: address,
    owner: address,
    amount: coins,
    payload: cell,
): SendResultList {
    val body = beginCell()
        .storeUint(OP_JETTON_TRANSFER_NOTIFICATION, 32)
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(owner)
        .storeUint(1, 1)
        .storeRef(payload)
        .endCell();
    return net.send(walletSender, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body,
    }));
}

fun submitCandle(
    rc: RoundControllerHandle,
    from: address,
    roundId: uint8,
    candleIndex: uint8,
    price: uint128,
): SendResultList {
    val rd = rcRound(rc, roundId);
    val start: uint64 = rd.observationStart + (candleIndex as uint64) * (CANDLE_SECONDS as uint64);
    val periodEnd: uint64 = start + (CANDLE_SECONDS as uint64);
    testing.setNow(periodEnd as uint32);
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: SubmitCandle {
            queryId: 0,
            roundId,
            candleIndex,
            periodStart: start as uint32,
            periodEnd: periodEnd as uint32,
            twapPriceUsdE8: price,
            dataDigest: candleIndex as uint256,
        },
    }));
}

fun submitAllCandles(
    rc: RoundControllerHandle,
    from: address,
    roundId: uint8,
    qualifiedCount: uint8,
    target: uint128,
) {
    var i: uint8 = 0;
    while (i < CANDLE_COUNT) {
        val price: uint128 = i < qualifiedCount ? target : target - 1;
        expect(submitCandle(rc, from, roundId, i, price)).toHaveSuccessfulTx<SubmitCandle>({
            from,
            to: rc.address,
        });
        i += 1;
    }
}

struct ProtocolFixture {
    admin: address
    oracle: address
    keeper: Treasury
    jettonMaster: address
    teamWallet: address
    rc: RoundControllerHandle
    tv: TeamVaultHandle
    rcWallet: MockWalletHandle
    tvWallet: MockWalletHandle
}

fun setupProtocol(): ProtocolFixture {
    val admin = testing.treasury("admin");
    // P0-1: candle submission / early close is admin-or-oracle only. A single
    // keeper treasury is created here and doubles as the oracle so tests do not
    // try to redeploy it later.
    val keeper = testing.treasury("keeper");
    val oracle = keeper;
    val jettonMaster = testing.treasury("jetton-master");
    val teamWallet = testing.treasury("team-wallet");

    // IMPORTANT: set emulated time before deploying, otherwise the first post-deploy
    // transaction pays storage rent for the whole jump from t=0 and fails (-669).
    testing.setNow(1000000);

    val tv = deployTeamVault(admin.address, teamWallet.address, jettonMaster.address);
    val rc = deployRoundController(admin.address, oracle.address, jettonMaster.address, tv.address);

    val rcWallet = deployMockWallet(rc.address, (ROUND_REWARD_RAW * 12) as coins);
    expect(setRcWallet(rc, admin.address, rcWallet.address)).toHaveSuccessfulTx<SetJettonWallet>({
        from: admin.address,
        to: rc.address,
    });

    val tvWallet = deployMockWallet(tv.address, (TEAM_ROUND_RAW * 10) as coins);
    expect(setTeamVaultWallet(tv, admin.address, tvWallet.address)).toHaveSuccessfulTx<SetJettonWallet>({
        from: admin.address,
        to: tv.address,
    });
    expect(sendInitController(tv, admin.address, rc.address)).toHaveSuccessfulTx<InitController>({
        from: admin.address,
        to: tv.address,
    });

    net.registerAddress(rc.address, "RoundController");
    net.registerAddress(tv.address, "TeamVault");
    net.registerAddress(rcWallet.address, "RC-JettonWallet");
    net.registerAddress(tvWallet.address, "TV-JettonWallet");
    return {
        admin: admin.address,
        oracle: oracle.address,
        keeper,
        jettonMaster: jettonMaster.address,
        teamWallet: teamWallet.address,
        rc,
        tv,
        rcWallet,
        tvWallet,
    };
}


// ---------------------------------------------------------------------------
// Round action helpers
// ---------------------------------------------------------------------------

fun finalizeRound(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: FinalizeRound { queryId: 0, roundId },
    }));
}

fun claimAll(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: ClaimAll { queryId: 0, roundId },
    }));
}

fun claimPrincipal(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: ClaimPrincipal { queryId: 0, roundId },
    }));
}

fun claimReward(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: ClaimReward { queryId: 0, roundId },
    }));
}

fun sendBurnAck(
    rc: RoundControllerHandle,
    from: address,
    roundId: uint8,
    kind: uint8,
    amountRaw: uint128,
    burnId: uint256,
): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: BurnAck { roundId, kind, amountRaw, burnId },
    }));
}

fun pauseOracle(rc: RoundControllerHandle, from: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: PauseOracle { queryId: 0, reason: 1 },
    }));
}

fun resumeOracle(rc: RoundControllerHandle, from: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: ResumeOracle { queryId: 0 },
    }));
}

fun abortTechnical(rc: RoundControllerHandle, from: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: AbortTechnical { queryId: 0 },
    }));
}

fun stakeOk(f: ProtocolFixture, roundId: uint8, owner: address, amount: coins, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, amount, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({
            from: f.rcWallet.address,
            to: f.rc.address,
        });
}

// open R1, stake nothing, advance to the end of the staking window and close it
fun openAndCloseFirstRound(f: ProtocolFixture, twap24h: uint128): uint128 {
    expect(openRound(f.rc, f.admin, twap24h)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    return rcRound(f.rc, 1).targetPriceUsdE8;
}

fun burnStatus(rc: RoundControllerHandle, roundId: uint8): RoundBurnStatus {
    return net.runGetMethod<RoundBurnStatus>(rc.address, "get_round_burn_status", [roundId]);
}


fun retryPendingActions(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: RetryPendingActions { queryId: 0, roundId },
    }));
}

// Runs one complete successful round for a single staker (open -> stake ->
// close -> observe 16/24 -> finalize) and leaves the clock at settlement time.
fun runSuccessRound(
    f: ProtocolFixture,
    roundId: uint8,
    staker: address,
    keeper: address,
    stakeAmount: coins,
) {
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    val target = rcRound(f.rc, roundId).targetPriceUsdE8;
    stakeOk(f, roundId, staker, stakeAmount, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(startObservation(f.rc, keeper, roundId)).toHaveSuccessfulTx<StartObservation>({
        from: keeper,
        to: f.rc.address,
    });
    submitAllCandles(f.rc, keeper, roundId, MIN_QUALIFIED_CANDLES, target);
    expect(finalizeRound(f.rc, keeper, roundId)).toHaveSuccessfulTx<FinalizeRound>({
        from: keeper,
        to: f.rc.address,
    });
}


// ---------------------------------------------------------------------------
// V8 reward-state helpers
// ---------------------------------------------------------------------------

fun setReferrer(rc: RoundControllerHandle, from: address, referrer: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: SetReferrer { referrer },
    }));
}

fun rollReward(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: RollReward { queryId: 0, roundId },
    }));
}

fun claimRewardEarly(rc: RoundControllerHandle, from: address, roundId: uint8): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: ClaimRewardEarly { queryId: 0, roundId },
    }));
}

fun claimUnlocked(rc: RoundControllerHandle, from: address): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rc.address,
        body: ClaimUnlocked { queryId: 0 },
    }));
}

fun rcRewardState(rc: RoundControllerHandle, owner: address, roundId: uint8): RewardStateInfo {
    return net.runGetMethod<RewardStateInfo>(rc.address, "get_reward_state", [owner, roundId]);
}

fun rcUnlockInfo(rc: RoundControllerHandle, owner: address): UnlockInfo {
    return net.runGetMethod<UnlockInfo>(rc.address, "get_unlock_info", [owner]);
}

fun rcReferral(rc: RoundControllerHandle, owner: address): ReferralInfo {
    return net.runGetMethod<ReferralInfo>(rc.address, "get_referral", [owner]);
}

fun rcStreak(rc: RoundControllerHandle, owner: address): StreakInfo {
    return net.runGetMethod<StreakInfo>(rc.address, "get_streak", [owner]);
}

fun rcUserWeight(rc: RoundControllerHandle, roundId: uint8, owner: address): uint128 {
    return net.runGetMethod<uint128>(rc.address, "get_user_weight", [roundId, owner]);
}

fun rcTotalWeight(rc: RoundControllerHandle, roundId: uint8): uint128 {
    return net.runGetMethod<uint128>(rc.address, "get_total_weight", [roundId]);
}

// Top up all A9 contracts before a large testing.setNow() jump (storage rent).
fun topUpForTimeJump(f: ProtocolFixture, amount: coins) {
    testing.topUp(f.rc.address, amount);
    testing.topUp(f.rcWallet.address, amount);
    testing.topUp(f.tv.address, amount);
    testing.topUp(f.tvWallet.address, amount);
}


fun sendBurnConfirm(vault: TeamVaultHandle, fromMaster: address, roundId: uint8): SendResultList {
    val q: uint64 = ((roundId as uint64) << 16) | ((BURN_QUERY_TEAM as uint64) << 8);
    return net.send(fromMaster, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: vault.address,
        body: ReturnExcessesBack { queryId: q },
    }));
}

// Simulates the team burn transfer bouncing back from TeamVault's Jetton Wallet.
fun bounceTeamBurn(vault: TeamVaultHandle, wallet: address, roundId: uint8) {
    val q: uint64 = ((roundId as uint64) << 16) | ((BURN_QUERY_TEAM as uint64) << 8);
    val body = beginCell()
        .storeUint(0xFFFFFFFF, 32)
        .storeUint(OP_JETTON_BURN, 32)
        .storeUint(q, 64)
        .endCell();
    val msg = createMessage({
        bounce: false,
        value: ton("0.1"),
        dest: vault.address,
        body,
    }).bounced();
    testing.processSingleTraceStep(wallet, msg);
}


// P0-2 closure: the Jetton Master confirms TeamVault's burn, which then acks RC.
fun confirmTeamBurn(f: ProtocolFixture, roundId: uint8) {
    val q: uint64 = ((roundId as uint64) << 16) | ((BURN_QUERY_TEAM as uint64) << 8);
    expect(net.send(f.jettonMaster, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: f.tv.address,
        body: ReturnExcessesBack { queryId: q },
    }))).toHaveSuccessfulTx<ReturnExcessesBack>({ from: f.jettonMaster, to: f.tv.address });
}


fun setMockAutoAck(wallet: MockWalletHandle, enabled: bool) {
    expect(net.send(wallet.address, createMessage({
        bounce: false,
        value: ton("0.02"),
        dest: wallet.address,
        body: SetMockAutoAck { autoAck: enabled },
    }))).toHaveSuccessfulTx<SetMockAutoAck>({ from: wallet.address, to: wallet.address });
}


fun bounceTeamRelease(vault: TeamVaultHandle, wallet: address, roundId: uint8) {
    val q: uint64 = ((roundId as uint64) << 16) | ((RELEASE_QUERY_TEAM as uint64) << 8);
    val body = beginCell()
        .storeUint(0xFFFFFFFF, 32)
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(q, 64)
        .endCell();
    val msg = createMessage({ bounce: false, value: ton("0.1"), dest: vault.address, body }).bounced();
    testing.processSingleTraceStep(wallet, msg);
}
