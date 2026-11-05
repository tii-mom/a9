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
import "@acton/env"
import "@acton/testing/assert"
import "@acton/types/transaction"
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

// Deployment TON budget, overridable for low-balance testnet runs. Values are TON.
fun tonCoins(amountTon: int): coins {
    return (amountTon * 1000000000) as coins;
}

// Parse a TON decimal string ("5", "0.6", "1.25") into nanotons. Invalid => fail.
fun parseTonString(raw: string, envName: string): coins {
    var s = raw.beginParse();
    var nano: int = 0;
    var fracDigits: int = 0;
    var seenDot: bool = false;
    var digits: int = 0;
    while (s.remainingBitsCount() >= 8) {
        val ch = s.loadUint(8);
        if (ch == 46) {
            if (seenDot) {
                Assert.fail(format("invalid {}={}: multiple decimal points", envName, raw));
            }
            seenDot = true;
        } else if (ch >= 48 && ch <= 57) {
            val d = ch - 48;
            if (!seenDot) {
                nano = nano * 10 + d;
            } else {
                if (fracDigits >= 9) {
                    Assert.fail(format("invalid {}={}: more than 9 decimal places", envName, raw));
                }
                nano = nano * 10 + d;
                fracDigits += 1;
            }
            digits += 1;
        } else {
            Assert.fail(format("invalid {}={}: expected decimal TON amount", envName, raw));
        }
    }
    if (digits == 0) {
        Assert.fail(format("invalid {}={}: empty amount", envName, raw));
    }
    if (seenDot) {
        while (fracDigits < 9) {
            nano = nano * 10;
            fracDigits += 1;
        }
    } else {
        nano = nano * 1000000000;
    }
    if (nano <= 0) {
        Assert.fail(format("invalid {}={}: amount must be > 0", envName, raw));
    }
    return nano as coins;
}

fun deployTon(envName: string, defaultTon: int): coins {
    val raw = env<string>(envName);
    if (raw == null) {
        return tonCoins(defaultTon);
    }
    return parseTonString(raw!, envName);
}

fun tonSource(envName: string): string {
    return env<string>(envName) == null ? "default" : "env";
}

fun parseEnvIntStrict(raw: string, envName: string): int {
    var s = raw.beginParse();
    var value: int = 0;
    var digits: int = 0;
    while (s.remainingBitsCount() >= 8) {
        val ch = s.loadUint(8);
        if (ch < 48 || ch > 57) {
            Assert.fail(format("invalid {}={}: expected integer", envName, raw));
        }
        value = value * 10 + (ch - 48);
        digits += 1;
    }
    if (digits == 0) {
        Assert.fail(format("invalid {}={}: empty integer", envName, raw));
    }
    return value;
}

fun intSetting(envName: string, defaultVal: int): int {
    val raw = env<string>(envName);
    if (raw == null) {
        return defaultVal;
    }
    return parseEnvIntStrict(raw!, envName);
}

fun intSource(envName: string): string {
    return env<string>(envName) == null ? "default" : "env";
}

fun coinRawSetting(envName: string, defaultVal: uint128): uint128 {
    val raw = env<string>(envName);
    if (raw == null) {
        return defaultVal;
    }
    val v = parseEnvIntStrict(raw!, envName);
    if (v <= 0) {
        Assert.fail(format("invalid {}={}: must be > 0", envName, raw!));
    }
    return v as uint128;
}

fun requireActive(addr: address, name: string, expectedCode: cell, needed: coins) {
    if (!scripts.isContractDeployed(addr)) {
        Assert.fail(
            format(
                "{} not active after deploy (addr={}, deployer balance={} nano, needed={} nano)",
                name, addr, scripts.fetchAccountBalance(scripts.wallet("deployer").address), needed,
            ),
        );
    }
    val acct = scripts.fetchAccountState(addr);
    if (acct == null) {
        Assert.fail(format("{} state missing after deploy (addr={})", name, addr));
    }
    var codeHash: uint256? = null;
    match (acct!.storage.state) {
        TlbAccountStateActive => {
            val init = acct!.storage.state.stateInit;
            if (init.code != null) {
                codeHash = init.code!.hash();
            }
        }
        TlbAccountStateUninit => {}
        TlbAccountStateFrozen => {}
    }
    if (codeHash == null || codeHash! != expectedCode.hash()) {
        Assert.fail(format("{} code hash mismatch after deploy (addr={})", name, addr));
    }
}

fun main() {
    val masterTon = deployTon("A9_DEPLOY_TON_JETTON_MASTER", 5);
    val adapterTon = deployTon("A9_DEPLOY_TON_ORACLE_ADAPTER", 5);
    val tvTon = deployTon("A9_DEPLOY_TON_TEAM_VAULT", 1);
    val rcTon = deployTon("A9_DEPLOY_TON_ROUND_CONTROLLER", 5);
    println(
        "Deploy TON: JettonMaster={} nano [{}] OracleAdapter={} nano [{}]",
        masterTon, tonSource("A9_DEPLOY_TON_JETTON_MASTER"),
        adapterTon, tonSource("A9_DEPLOY_TON_ORACLE_ADAPTER"),
    );
    println(
        "Deploy TON: TeamVault={} nano [{}] RoundController={} nano [{}]",
        tvTon, tonSource("A9_DEPLOY_TON_TEAM_VAULT"),
        rcTon, tonSource("A9_DEPLOY_TON_ROUND_CONTROLLER"),
    );
    val previewSeconds = intSetting("A9_TIMING_PREVIEW_SECONDS", 43200);
    val stakeSeconds = intSetting("A9_TIMING_STAKE_SECONDS", 129600);
    val candleSeconds = intSetting("A9_TIMING_CANDLE_SECONDS", 3600);
    val candleCount = intSetting("A9_TIMING_CANDLE_COUNT", 24);
    val minQualified = intSetting("A9_TIMING_MIN_QUALIFIED", 16);
    val observationSeconds = intSetting("A9_TIMING_OBSERVATION_SECONDS", 86400);
    val roundRewardRaw = coinRawSetting("A9_DEPLOY_ROUND_REWARD_RAW", PARAM_ROUND_REWARD);
    val teamRoundRaw = coinRawSetting("A9_DEPLOY_TEAM_ROUND_RAW", PARAM_TEAM_ROUND);

    if (previewSeconds <= 0 || stakeSeconds <= 0 || candleSeconds <= 0 || candleCount <= 0 || observationSeconds <= 0) {
        Assert.fail("timing values must all be > 0");
    }
    if (observationSeconds != candleSeconds * candleCount) {
        Assert.fail("invalid timing: observationSeconds must equal candleSeconds * candleCount");
    }
    if (minQualified > candleCount || minQualified * 2 <= candleCount) {
        Assert.fail("invalid timing: minQualified must be <= candleCount and > candleCount/2");
    }
    println(
        "Timing: preview={} [{}] stake={} [{}]",
        previewSeconds, intSource("A9_TIMING_PREVIEW_SECONDS"),
        stakeSeconds, intSource("A9_TIMING_STAKE_SECONDS"),
    );
    println(
        "Timing: candle={} [{}] count={} [{}]",
        candleSeconds, intSource("A9_TIMING_CANDLE_SECONDS"),
        candleCount, intSource("A9_TIMING_CANDLE_COUNT"),
    );
    println(
        "Timing: minQ={} [{}] obs={} [{}]",
        minQualified, intSource("A9_TIMING_MIN_QUALIFIED"),
        observationSeconds, intSource("A9_TIMING_OBSERVATION_SECONDS"),
    );
    val deployer = scripts.wallet("deployer");
    val admin = scripts.wallet("admin");
    val teamWallet = scripts.wallet("team-wallet");

    println("A9 deploy params:");
    println("  totalSupplyRaw     = {}", PARAM_TOTAL_SUPPLY);
    println("  p0UsdE8            = {}", PARAM_P0);
    println("  priceMultiplier    = 2");
    println("  roundRewardRaw     = {} [{}]", roundRewardRaw, intSource("A9_DEPLOY_ROUND_REWARD_RAW"));
    println("  teamRoundRaw       = {} [{}]", teamRoundRaw, intSource("A9_DEPLOY_TEAM_ROUND_RAW"));
    println("  minStakeRaw        = {}", PARAM_MIN_STAKE);
    println("  maxTotalStakeRaw   = {}", PARAM_MAX_TOTAL_STAKE);

    // Resume mode (env): reuse an already-deployed JettonMaster and only deploy
    // OracleAdapter + TeamVault + RoundController + wiring. Never deploy/mint again.
    val resumeMaster = env<address>("A9_RESUME_JETTON_MASTER_ADDRESS");
    var masterAddress: address;
    if (resumeMaster == null) {
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
    masterAddress = AutoDeployAddress { stateInit: masterInit }.calculateAddress();
    fs.writeString("deploy/jetton-master.addr", format("{}\n", masterAddress));
    net.send(deployer.address, createMessage({
        bounce: false,
        value: masterTon,
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
    requireActive(masterAddress, "JettonMaster", build("JettonMaster"), masterTon);
    } else {
        masterAddress = resumeMaster!;
        println("reusing JettonMaster at {}", masterAddress);
        requireActive(masterAddress, "JettonMaster(resume)", build("JettonMaster"), 0 as coins);
        fs.writeString("deploy/jetton-master.addr", format("{}\n", masterAddress));
        val masterData = net.runGetMethod<JettonDataReply>(masterAddress, "get_jetton_data");
        if (masterData.totalSupply != PARAM_TOTAL_SUPPLY) {
            Assert.fail("resume master totalSupply mismatch: expected 100e9 A9 already minted");
        }
    }

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
            teamRoundRaw,
        }.toCell(),
        extra: TeamVaultExtra { teamWalletJettonWallet: admin.address }.toCell(),
        rounds: [],
        pendingBurnIds: [],
        totalReleasedRaw: 0,
        totalBurnedRaw: 0,
        releasedCount: 0,
        burnedCount: 0,
    };
    // OracleAdapter (mainnet M-2): deploy first, then RC is configured with it as oracle.
    val zeroTail = OracleSignersTail { s3: 0 as uint256, s4: 0 as uint256 }.toCell();
    val zeroSigners = OracleSignersPacked {
        s0: 0 as uint256,
        s1: 0 as uint256,
        s2: 0 as uint256,
        threshold: 3,
        tail: zeroTail,
    }.toCell();
    val adapterCfg = OracleAdapterConfig {
        admin: admin.address,
        controller: null,
        chainId: 1,
        configVersion: 1,
        signers: zeroSigners,
    };
    val adapterStorage = OracleAdapterStorage {
        config: adapterCfg.toCell(),
        usedMask: [],
        lastCandle: [],
        pending: [],
    };
    val adapterInit = ContractState { code: build("OracleAdapter"), data: adapterStorage.toCell() };
    val adapterAddress = AutoDeployAddress { stateInit: adapterInit }.calculateAddress();
    fs.writeString("deploy/oracle-adapter.addr", format("{}\n", adapterAddress));
    net.send(deployer.address, createMessage({
        bounce: false,
        value: adapterTon,
        dest: { stateInit: adapterInit },
        body: TopUpTons {},
    })).waitForTrace();
    requireActive(adapterAddress, "OracleAdapter", build("OracleAdapter"), adapterTon);
    println("OracleAdapter deployed at {} (RC oracle will point here)", adapterAddress);

    val tvInit = ContractState { code: build("TeamVault"), data: tvStorage.toCell() };
    val tvAddress = AutoDeployAddress { stateInit: tvInit }.calculateAddress();
    fs.writeString("deploy/team-vault.addr", format("{}\n", tvAddress));
    net.send(deployer.address, createMessage({
        bounce: false,
        value: tvTon,
        dest: { stateInit: tvInit },
        body: TopUpTons {},
    })).waitForTrace();
    requireActive(tvAddress, "TeamVault", build("TeamVault"), tvTon);
    println("TeamVault deployed at {}", tvAddress);

    // --- 4. RoundController (with the real JettonMaster) --------------------
    val econ = ProtocolEcon {
        p0UsdE8: PARAM_P0,
        priceMultiplier: 2,
        roundRewardRaw,
        teamRoundRaw,
        minStakeRaw: PARAM_MIN_STAKE,
        maxStakePerAddressBps: 1000,
        maxTotalStakeRaw: PARAM_MAX_TOTAL_STAKE,
    };
    val timing = ProtocolTiming {
        previewSeconds: previewSeconds as uint32,
        stakeDurationSeconds: stakeSeconds as uint32,
        candleSeconds: candleSeconds as uint32,
        candleCount: candleCount as uint8,
        minQualifiedCandles: minQualified as uint8,
        observationSeconds: observationSeconds as uint32,
        techAbortPauseSeconds: 1209600,
        techAbortObsTimeoutSeconds: 604800,
        riskDisclosureVersion: 1,
        configVersion: 1,
    };
    val cfg = ProtocolConfig {
        addresses: ProtocolAddresses {
            admin: admin.address,
            oracle: adapterAddress,
            jettonMaster: masterAddress,
        }.toCell(),
        vaults: ProtocolVaults {
            // placeholder: wired right below with the real wallet address
            stakingJettonWallet: admin.address,
            teamVault: tvAddress,
            jettonWalletCode: build("JettonWallet"),
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
        value: rcTon,
        dest: { stateInit: rcInit },
        body: TopUpTons {},
    })).waitForTrace();
    requireActive(rcAddress, "RoundController", build("RoundController"), rcTon);
    println("RoundController deployed at {}", rcAddress);
    // wire the adapter to this RC (one-time)
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: adapterAddress,
        body: SetOracleController { controller: rcAddress },
    })).waitForTrace();
    val adapterCfgAfter = net.runGetMethod<OracleConfigView>(adapterAddress, "get_config");
    if (adapterCfgAfter.controller == null || adapterCfgAfter.controller! != rcAddress) {
        Assert.fail("OracleAdapter controller wiring failed");
    }
    println("OracleAdapter.SetOracleController -> RoundController");

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
        dest: rcAddress,
        body: SetJettonWalletCode { code: build("JettonWallet") },
    })).waitForTrace();
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: tvAddress,
        body: SetJettonWallet { wallet: tvJettonWallet },
    })).waitForTrace();
    val teamWalletJettonWallet = net.runGetMethod<address>(masterAddress, "get_wallet_address", [teamWallet.address]);
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: tvAddress,
        body: SetTeamWalletJettonWallet { wallet: teamWalletJettonWallet },
    })).waitForTrace();
    val rcCfg = net.runGetMethod<ProtocolConfigView>(rcAddress, "get_protocol_config");
    if (rcCfg.stakingJettonWallet != rcJettonWallet) {
        Assert.fail("RC SetJettonWallet wiring failed");
    }
    val codeHash = net.runGetMethod<uint256>(rcAddress, "get_jetton_wallet_code_hash");
    if (codeHash != build("JettonWallet").hash()) {
        Assert.fail("RC SetJettonWalletCode wiring failed (code hash mismatch)");
    }
    println("SetJettonWallet + SetJettonWalletCode wired on RoundController");
    val tvState = net.runGetMethod<TeamVaultState>(tvAddress, "get_team_vault_state");
    if (tvState.jettonWallet != tvJettonWallet) {
        Assert.fail("TeamVault SetJettonWallet wiring failed");
    }
    val tvTeamWallet = net.runGetMethod<address>(tvAddress, "get_team_wallet_jetton_wallet");
    if (tvTeamWallet != teamWalletJettonWallet) {
        Assert.fail("TeamVault SetTeamWalletJettonWallet wiring failed");
    }
    println("SetJettonWallet + SetTeamWalletJettonWallet wired on TeamVault");

    // --- 6. TeamVault controller (one-time) ---------------------------------
    net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: tvAddress,
        body: InitController { controller: rcAddress },
    })).waitForTrace();
    val tvCfg = net.runGetMethod<TeamVaultConfig>(tvAddress, "get_config");
    if (tvCfg.controller == null || tvCfg.controller! != rcAddress) {
        Assert.fail("TeamVault.InitController wiring failed");
    }
    println("TeamVault.InitController -> {}", rcAddress);

    println("TODO (ops): transfer 7,000,000,000 A9 to the RC Jetton Wallet and");
    println("1,200,000,000 A9 to the TeamVault Jetton Wallet; seed TON gas balances.");
    println("admin wallet now holds the 100e9 A9 supply (mint closed).");
}
