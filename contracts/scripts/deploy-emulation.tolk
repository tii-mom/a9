// A9 Protocol — deterministic deployment order (emulation by default).
//
//   acton script scripts/deploy-emulation.tolk                 # local emulation
//   acton script scripts/deploy-emulation.tolk --net testnet   # real testnet broadcast
//
// Deployment order implemented here:
//   1. JettonMaster (A9, TEP-74) deployed with admin = admin, empty supply.
//   2. Mint 10,000,000,000 A9 exactly once to admin; mint closes permanently.
//   3. TeamVault deployed (placeholder jetton wallet, later SetJettonWallet).
//   4. RoundController deployed with the REAL JettonMaster address.
//   5. Query JettonMaster.get_wallet_address(RC / TeamVault) and wire the real
//      canonical Jetton Wallet addresses via the one-time SetJettonWallet.
//   6. TeamVault.InitController(RoundController) (one-time, immutable).
//   7. Remaining ops step (not done here): transfer 7,000,000,000 A9 to the RC
//      Jetton Wallet, 1,200,000,000 A9 to the TeamVault Jetton Wallet and seed
//      TON gas balances (RC >= 20 TON, TeamVault >= 10 TON).

import "@stdlib/strings"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/fmt"
import "@acton/fs"
import "@acton/emulation/scripts"
import "@contracts/types"
import "@contracts/jetton/storage"

const PARAM_TOTAL_SUPPLY: coins = 10000000000000000000; // 100 亿 A9 (9 decimals)
const PARAM_P0: uint128 = 116000;
const PARAM_ROUND_REWARD: uint128 = 700000000000000000;
const PARAM_TEAM_ROUND: uint128 = 120000000000000000;
const PARAM_MIN_STAKE: uint128 = 10000000000000;
const PARAM_MAX_TOTAL_STAKE: uint128 = 200000000000000000;

fun main() {
    val deployer = scripts.wallet("deployer");
    val admin = scripts.wallet("admin");
    val oracle = scripts.wallet("oracle");
    val teamWallet = scripts.wallet("team-wallet");

    println("A9 deploy params:");
    println("  totalSupplyRaw     = {}", PARAM_TOTAL_SUPPLY);
    println("  p0UsdE8            = {}", PARAM_P0);
    println("  priceMultiplier    = 2");
    println("  roundRewardRaw     = {}", PARAM_ROUND_REWARD);
    println("  teamRoundRaw       = {}", PARAM_TEAM_ROUND);
    println("  minStakeRaw        = {}", PARAM_MIN_STAKE);
    println("  maxTotalStakeRaw   = {}", PARAM_MAX_TOTAL_STAKE);

    // --- 1. JettonMaster ----------------------------------------------------
    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), "https://a9.lat/a9.json".prefixWith00());
    val masterStorage = MasterStorage {
        totalSupply: 0,
        adminAddress: admin.address,
        nextAdminAddress: null,
        metadata: metadata.toCell(),
    };
    val masterInit = ContractState { code: build("JettonMaster"), data: masterStorage.toCell() };
    val masterAddress = AutoDeployAddress { stateInit: masterInit }.calculateAddress();
    fs.writeString("deploy/jetton-master.addr", format("{}\n", masterAddress));
    net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("5"),
        dest: { stateInit: masterInit },
        body: TopUpTons {},
    })).waitForTrace();
    println("JettonMaster deployed at {}", masterAddress);

    // --- 2. Mint 100 亿 exactly once (admin is cleared by the master) -------
    val mintBody = beginCell()
        .storeUint(0x00000015, 32) // MintOnce
        .storeUint(0, 64)
        .storeAddress(admin.address)
        .storeCoins(ton("0.4")) // ton_amount forwarded to the new wallet
        .storeCoins(PARAM_TOTAL_SUPPLY) // jetton_amount
        .storeCoins(ton("0.5")) // total_ton_amount attached to mint
        .storeUint(0, 1) // forward_payload: inline empty
        .endCell();
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.55"),
        dest: masterAddress,
        body: mintBody,
    })).waitForTrace();
    println("JettonMaster minted 100e9 A9 to admin; mint is now permanently closed");

    // --- 3. TeamVault -------------------------------------------------------
    val tvStorage = TeamVaultStorage {
        config: TeamVaultConfig {
            admin: admin.address,
            controller: null,
            configVersion: 1,
        },
        params: TeamVaultParams {
            // placeholder: wired with the real wallet after the master exists
            jettonWallet: admin.address,
            teamWallet: teamWallet.address,
            jettonMaster: masterAddress,
            teamRoundRaw: PARAM_TEAM_ROUND,
        }.toCell(),
        rounds: [],
        pendingBurnIds: [],
        totalReleasedRaw: 0,
        totalBurnedRaw: 0,
        releasedCount: 0,
        burnedCount: 0,
    };
    val tvInit = ContractState { code: build("TeamVault"), data: tvStorage.toCell() };
    val tvAddress = AutoDeployAddress { stateInit: tvInit }.calculateAddress();
    fs.writeString("deploy/team-vault.addr", format("{}\n", tvAddress));
    net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("1"),
        dest: { stateInit: tvInit },
        body: TopUpTons {},
    })).waitForTrace();
    println("TeamVault deployed at {}", tvAddress);

    // --- 4. RoundController (with the real JettonMaster) --------------------
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
        previewSeconds: 43200,
        stakeDurationSeconds: 129600,
        candleSeconds: 3600,
        candleCount: 24,
        minQualifiedCandles: 16,
        observationSeconds: 86400,
        techAbortPauseSeconds: 1209600,
        techAbortObsTimeoutSeconds: 604800,
        riskDisclosureVersion: 1,
        configVersion: 1,
    };
    val cfg = ProtocolConfig {
        addresses: ProtocolAddresses {
            admin: admin.address,
            oracle: oracle.address,
            jettonMaster: masterAddress,
        }.toCell(),
        vaults: ProtocolVaults {
            // placeholder: wired right below with the real wallet address
            stakingJettonWallet: admin.address,
            teamVault: tvAddress,
        }.toCell(),
        econ: econ.toCell(),
        timing: timing.toCell(),
    };
    val rcStorage = Storage {
        config: cfg.toCell(),
        extras: emptyExtras().toCell(),
        currentRoundId: 0,
        successCount: 0,
        lastSettledAt: 0,
        pausedAt: 0,
        rounds: [],
        stakes: [],
    };
    val rcInit = ContractState { code: build("RoundController"), data: rcStorage.toCell() };
    val rcAddress = AutoDeployAddress { stateInit: rcInit }.calculateAddress();
    fs.writeString("deploy/round-controller.addr", format("{}\n", rcAddress));
    net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("5"),
        dest: { stateInit: rcInit },
        body: TopUpTons {},
    })).waitForTrace();
    println("RoundController deployed at {}", rcAddress);

    // --- 5. Resolve + wire the real Jetton Wallet addresses ----------------
    val rcJettonWallet = net.runGetMethod<address>(masterAddress, "get_wallet_address", [rcAddress]);
    val tvJettonWallet = net.runGetMethod<address>(masterAddress, "get_wallet_address", [tvAddress]);
    println("RC Jetton Wallet     = {}", rcJettonWallet);
    println("TeamVault Jetton Wallet = {}", tvJettonWallet);

    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: rcAddress,
        body: SetJettonWallet { wallet: rcJettonWallet },
    })).waitForTrace();
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: tvAddress,
        body: SetJettonWallet { wallet: tvJettonWallet },
    })).waitForTrace();
    println("SetJettonWallet wired on RoundController and TeamVault");

    // --- 6. TeamVault controller (one-time) ---------------------------------
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: tvAddress,
        body: InitController { controller: rcAddress },
    })).waitForTrace();
    println("TeamVault.InitController -> {}", rcAddress);

    println("TODO (ops): transfer 7,000,000,000 A9 to the RC Jetton Wallet and");
    println("1,200,000,000 A9 to the TeamVault Jetton Wallet; seed TON gas balances.");
    println("admin wallet now holds the 100e9 A9 supply (mint closed).");
}
