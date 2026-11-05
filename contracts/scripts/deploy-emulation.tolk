// A9 Protocol — deterministic deployment order demo (emulation by default).
//
//   acton script scripts/deploy-emulation.tolk              # local emulation
//   acton script scripts/deploy-emulation.tolk --net testnet # real testnet broadcast
//
// Real deployment checklist (see contracts/README §Deployment):
//   1. Jetton Master already deployed, mint 100% supply, mint authority closed.
//   2. TeamVault deployed (placeholder jetton wallet, later SetJettonWallet).
//   3. RoundController deployed with teamVault address (placeholder staking wallet).
//   4. Query the Jetton Master get_wallet_address(roundController) to obtain the
//      canonical RC Jetton Wallet, then admin -> SetJettonWallet.
//   5. Query get_wallet_address(teamVault), admin -> TeamVault.SetJettonWallet.
//   6. admin -> TeamVault.InitController(roundController)  (one-time, immutable).
//   7. Fund the RC Jetton Wallet with 7,000,000,000 A9 (reward pool) and the
//      TeamVault Jetton Wallet with 1,200,000,000 A9 (team pool).
//   8. Seed TON gas balances: >= 20 TON on RoundController, >= 10 TON on TeamVault.

import "@acton/build"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/emulation/scripts"
import "@contracts/types"

const PARAM_P0: uint128 = 116000;
const PARAM_ROUND_REWARD: uint128 = 700000000000000000;
const PARAM_TEAM_ROUND: uint128 = 120000000000000000;
const PARAM_MIN_STAKE: uint128 = 10000000000000;
const PARAM_MAX_TOTAL_STAKE: uint128 = 200000000000000000;

fun main() {
    val deployer = scripts.wallet("deployer");
    val admin = scripts.wallet("admin");
    val oracle = scripts.wallet("oracle");
    val jettonMaster = scripts.wallet("jetton-master");
    val teamWallet = scripts.wallet("team-wallet");

    println("A9 deploy params:");
    println("  p0UsdE8            = {}", PARAM_P0);
    println("  priceMultiplier    = 2");
    println("  roundRewardRaw     = {}", PARAM_ROUND_REWARD);
    println("  teamRoundRaw       = {}", PARAM_TEAM_ROUND);
    println("  minStakeRaw        = {}", PARAM_MIN_STAKE);
    println("  maxTotalStakeRaw   = {}", PARAM_MAX_TOTAL_STAKE);

    // --- 1. TeamVault -------------------------------------------------------
    val tvStorage = TeamVaultStorage {
        config: TeamVaultConfig {
            admin: admin.address,
            controller: null,
            configVersion: 1,
        },
        params: TeamVaultParams {
            // placeholder: wired once with TeamVault.SetJettonWallet after step 5
            jettonWallet: admin.address,
            teamWallet: teamWallet.address,
            teamRoundRaw: PARAM_TEAM_ROUND,
        }.toCell(),
        rounds: [],
        totalReleasedRaw: 0,
        totalBurnedRaw: 0,
        releasedCount: 0,
        burnedCount: 0,
    };
    val tvInit = ContractState { code: build("TeamVault"), data: tvStorage.toCell() };
    val tvAddress = AutoDeployAddress { stateInit: tvInit }.calculateAddress();
    net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("1"),
        dest: { stateInit: tvInit },
        body: TopUpTons {},
    })).waitForTrace();
    println("TeamVault deployed at {}", tvAddress);

    // --- 2. RoundController -------------------------------------------------
    val econ = ProtocolEcon {
        p0UsdE8: PARAM_P0,
        priceMultiplier: 2,
        roundRewardRaw: PARAM_ROUND_REWARD,
        teamRoundRaw: PARAM_TEAM_ROUND,
        minStakeRaw: PARAM_MIN_STAKE,
        maxStakePerAddressBps: 1000,
        maxTotalStakeRaw: PARAM_MAX_TOTAL_STAKE,
    };
    val timing = ProtocolTiming {
        previewSeconds: 86400,
        stakeDurationSeconds: 259200,
        candleSeconds: 14400,
        candleCount: 18,
        minQualifiedCandles: 12,
        observationSeconds: 259200,
        techAbortPauseSeconds: 1209600,
        techAbortObsTimeoutSeconds: 604800,
        riskDisclosureVersion: 1,
        configVersion: 1,
    };
    val cfg = ProtocolConfig {
        addresses: ProtocolAddresses {
            admin: admin.address,
            oracle: oracle.address,
            jettonMaster: jettonMaster.address,
        }.toCell(),
        vaults: ProtocolVaults {
            // placeholder: wired once via RoundController.SetJettonWallet (step 4)
            stakingJettonWallet: admin.address,
            teamVault: tvAddress,
        }.toCell(),
        econ: econ.toCell(),
        timing: timing.toCell(),
    };
    val rcStorage = Storage {
        config: cfg.toCell(),
        currentRoundId: 0,
        successCount: 0,
        lastSettledAt: 0,
        pausedAt: 0,
        rounds: [],
        stakes: [],
    };
    val rcInit = ContractState { code: build("RoundController"), data: rcStorage.toCell() };
    val rcAddress = AutoDeployAddress { stateInit: rcInit }.calculateAddress();
    net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("5"),
        dest: { stateInit: rcInit },
        body: TopUpTons {},
    })).waitForTrace();
    println("RoundController deployed at {}", rcAddress);

    // --- 3. Wire TeamVault controller (one-time) ----------------------------
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: tvAddress,
        body: InitController { controller: rcAddress },
    })).waitForTrace();
    println("TeamVault.InitController -> {}", rcAddress);
    println("TODO after Jetton Master exists: SetJettonWallet on both contracts and fund the");
    println("two Jetton wallets (7,000,000,000 A9 to RC / 1,200,000,000 A9 to TeamVault).");
}
