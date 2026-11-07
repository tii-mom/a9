// A9 Protocol v11 — deterministic deployment (emulation by default).
//
//   acton script scripts/deploy-emulation.tolk                 # local emulation
//   acton script scripts/deploy-emulation.tolk --net testnet   # real testnet broadcast
//
// Deployment order implemented here:
//   1. JettonMaster (A9, TEP-74) deployed with admin = admin wallet, empty supply.
//   2. Mint 100,000,000,000 A9 exactly once to admin; mint closes permanently.
//      (Resume mode: A9_RESUME_JETTON_MASTER_ADDRESS reuses an existing master.)
//   3. RoundController deployed with the REAL JettonMaster. There is no admin and
//      no wiring step: RC derives its own jetton wallet from its code and address.
//   4. Verify RC is active with the expected code hash and that
//      RC.get_jetton_wallet_address == JettonMaster.get_wallet_address(RC).
//   5. Fund RC with 10 rounds of reward + 10 rounds of team quota via a TEP-74
//      transfer with forward_ton_amount = 0 (otherwise RC treats it as a deposit
//      and refunds it), then verify the RC jetton balance.
//   6. Deploy JunxiangDistributor (+ its jetton wallet address). NOT funded here:
//      ops funds its jetton wallet before every root is published (contracts/README §7.1).
//   7. Read back RC.get_ticket_code_hash and the distributor's get_distributor and print both.
//
// Env (all optional unless noted):
//   A9_KEEPER_ADDRESS          keeper address (default: deployer wallet)
//   A9_TEAM_WALLET_ADDRESS     team wallet (REQUIRED with --net; default: deployer wallet)
//   A9_JUNXIANG_PUBLISHER_ADDRESS  distributor root publisher (default: keeper)
//   A9_DEPLOY_ROUND_REWARD_RAW, A9_DEPLOY_TEAM_ROUND_RAW, A9_DEPLOY_MIN_STAKE_RAW (raw A9)
//   A9_TIMING_PREVIEW_SECONDS, A9_TIMING_STAKE_SECONDS, A9_TIMING_CANDLE_SECONDS,
//   A9_TIMING_CANDLE_COUNT, A9_TIMING_MIN_QUALIFIED, A9_TIMING_ABORT_TIMEOUT_SECONDS
//                              A9_TIMING_OBSERVATION_SECONDS is no longer configurable:
//                              observation = candleSeconds * candleCount. If set, it must match.
//   A9_DEPLOY_TON_JETTON_MASTER, A9_DEPLOY_TON_ROUND_CONTROLLER, A9_DEPLOY_TON_JUNXIANG_DISTRIBUTOR,
//   A9_DEPLOY_MINT_TON, A9_DEPLOY_MINT_FORWARD_TON, A9_DEPLOY_FUND_TON   deployment TON budget (decimal TON)

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
import "@contracts/junxiang"
import "deploy/actions"

const PARAM_TOTAL_SUPPLY: coins = 10000000000000000000; // 100 亿 A9 (9 decimals)
const PARAM_P0: uint128 = 116000;
const PARAM_ROUND_REWARD: uint128 = 700000000000000000;
const PARAM_TEAM_ROUND: uint128 = 120000000000000000;
const PARAM_MIN_STAKE: uint128 = 1000000000000; // v11: 1,000 A9, no caps
const PARAM_ABORT_TIMEOUT: uint32 = 604800;

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

fun tonSetting(envName: string, defaultTon: string): coins {
    val raw = env<string>(envName);
    if (raw == null) {
        return parseTonString(defaultTon, envName);
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

// Real deploys write deploy/<name>.addr (read by ops tooling); local emulation writes
// deploy/<name>.emulation.addr so a rehearsal never clobbers the live addresses.
fun addrFile(name: string): string {
    return net.isBroadcasting() ? format("deploy/{}.addr", name) : format("deploy/{}.emulation.addr", name);
}

fun main() {
    val masterTon = deployTon("A9_DEPLOY_TON_JETTON_MASTER", 5);
    val rcTon = deployTon("A9_DEPLOY_TON_ROUND_CONTROLLER", 5);
    val distTon = deployTon("A9_DEPLOY_TON_JUNXIANG_DISTRIBUTOR", 1);
    val mintTon = tonSetting("A9_DEPLOY_MINT_TON", "0.55");
    val mintForwardTon = tonSetting("A9_DEPLOY_MINT_FORWARD_TON", "0.4");
    val fundTon = tonSetting("A9_DEPLOY_FUND_TON", "0.3");
    println(
        "Deploy TON: JettonMaster={} nano [{}] RoundController={} nano [{}]",
        masterTon, tonSource("A9_DEPLOY_TON_JETTON_MASTER"),
        rcTon, tonSource("A9_DEPLOY_TON_ROUND_CONTROLLER"),
    );
    println(
        "Deploy TON: JunxiangDistributor={} nano [{}]",
        distTon, tonSource("A9_DEPLOY_TON_JUNXIANG_DISTRIBUTOR"),
    );
    println(
        "Deploy TON extras: mint={} nano [{}] mintForward={} nano [{}]",
        mintTon, tonSource("A9_DEPLOY_MINT_TON"),
        mintForwardTon, tonSource("A9_DEPLOY_MINT_FORWARD_TON"),
    );
    println(
        "Deploy TON extras: fund={} nano [{}]",
        fundTon, tonSource("A9_DEPLOY_FUND_TON"),
    );

    val previewSeconds = intSetting("A9_TIMING_PREVIEW_SECONDS", 43200);
    val stakeSeconds = intSetting("A9_TIMING_STAKE_SECONDS", 129600);
    val candleSeconds = intSetting("A9_TIMING_CANDLE_SECONDS", 3600);
    val candleCount = intSetting("A9_TIMING_CANDLE_COUNT", 24);
    val minQualified = intSetting("A9_TIMING_MIN_QUALIFIED", 16);
    val roundRewardRaw = coinRawSetting("A9_DEPLOY_ROUND_REWARD_RAW", PARAM_ROUND_REWARD);
    val teamRoundRaw = coinRawSetting("A9_DEPLOY_TEAM_ROUND_RAW", PARAM_TEAM_ROUND);
    val minStakeRaw = coinRawSetting("A9_DEPLOY_MIN_STAKE_RAW", PARAM_MIN_STAKE);
    val p0UsdE8 = coinRawSetting("A9_DEPLOY_P0_USD_E8", PARAM_P0);
    val abortTimeoutSeconds = intSetting("A9_TIMING_ABORT_TIMEOUT_SECONDS", PARAM_ABORT_TIMEOUT);
    // 30 days on mainnet; fast testnet drills use seconds (restore before mainnet)
    val fallbackUnlockSeconds = intSetting("A9_TIMING_FALLBACK_UNLOCK_SECONDS", 2592000);

    if (previewSeconds <= 0 || stakeSeconds <= 0 || candleSeconds <= 0 || candleCount <= 0) {
        Assert.fail("timing values must all be > 0");
    }
    if (abortTimeoutSeconds <= 0) {
        Assert.fail("A9_TIMING_ABORT_TIMEOUT_SECONDS must be > 0");
    }
    // observation window is derived in v11; an explicit override must agree with it
    val observationSeconds = candleSeconds * candleCount;
    val obsRaw = env<string>("A9_TIMING_OBSERVATION_SECONDS");
    if (obsRaw != null) {
        val obsEnv = parseEnvIntStrict(obsRaw!, "A9_TIMING_OBSERVATION_SECONDS");
        if (obsEnv != observationSeconds) {
            Assert.fail(
                format(
                    "A9_TIMING_OBSERVATION_SECONDS={} must equal candleSeconds*candleCount={} (observation is derived in v11)",
                    obsEnv,
                    observationSeconds,
                ),
            );
        }
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
        "Timing: minQ={} [{}] observation={} (candleSeconds*candleCount)",
        minQualified, intSource("A9_TIMING_MIN_QUALIFIED"),
        observationSeconds,
    );
    println(
        "Timing: abortTimeout={} [{}] (technical abort; observation/preview timeout)",
        abortTimeoutSeconds, intSource("A9_TIMING_ABORT_TIMEOUT_SECONDS"),
    );

    val deployer = scripts.wallet("deployer");
    val admin = scripts.wallet("admin");
    // keeper / team default to the deployer wallet; team wallet must be explicit on a real network
    // On a real network every immutable role and P0 must be explicit (no silent deployer defaults).
    if (net.isBroadcasting()) {
        if (env<address>("A9_KEEPER_ADDRESS") == null) { Assert.fail("A9_KEEPER_ADDRESS must be set when broadcasting with --net"); }
        if (env<address>("A9_JUNXIANG_PUBLISHER_ADDRESS") == null) { Assert.fail("A9_JUNXIANG_PUBLISHER_ADDRESS must be set when broadcasting with --net"); }
        if (env<string>("A9_DEPLOY_P0_USD_E8") == null) { Assert.fail("A9_DEPLOY_P0_USD_E8 must be set when broadcasting with --net"); }
        // Fast drill timing is testnet-only: refuse it unless explicitly allowed (never set this on mainnet).
        val fastTiming = stakeSeconds < 3600 || abortTimeoutSeconds < 86400 || fallbackUnlockSeconds < 86400;
        if (fastTiming && intSetting("A9_ALLOW_FAST_TIMING", 0) != 1) {
            Assert.fail("fast drill timing detected; set A9_ALLOW_FAST_TIMING=1 only for testnet drills");
        }
    }
    val keeper = env<address>("A9_KEEPER_ADDRESS") ?? deployer.address;
    val teamEnv = env<address>("A9_TEAM_WALLET_ADDRESS");
    if (teamEnv == null && net.isBroadcasting()) {
        Assert.fail("A9_TEAM_WALLET_ADDRESS must be set when broadcasting with --net");
    }
    val teamWallet = teamEnv ?? deployer.address;
    // distributor publisher: explicit env, else the keeper (contracts/README §7.1)
    val publisherEnv = env<address>("A9_JUNXIANG_PUBLISHER_ADDRESS");
    val junxiangPublisher = publisherEnv ?? keeper;

    println("A9 deploy params:");
    println("  totalSupplyRaw     = {}", PARAM_TOTAL_SUPPLY);
    println("  keeper             = {} [{}]", keeper, env<address>("A9_KEEPER_ADDRESS") == null ? "default: deployer" : "env");
    println("  teamWallet         = {} [{}]", teamWallet, teamEnv == null ? "default: deployer" : "env");
    println("  junxiangPublisher  = {} [{}]", junxiangPublisher, publisherEnv == null ? "default: keeper" : "env");
    println("  p0UsdE8            = {} [{}]", p0UsdE8, intSource("A9_DEPLOY_P0_USD_E8"));
    println("  priceMultiplier    = 2");
    println("  roundRewardRaw     = {} [{}]", roundRewardRaw, intSource("A9_DEPLOY_ROUND_REWARD_RAW"));
    println("  teamRoundRaw       = {} [{}]", teamRoundRaw, intSource("A9_DEPLOY_TEAM_ROUND_RAW"));
    println("  minStakeRaw        = {} [{}]", minStakeRaw, intSource("A9_DEPLOY_MIN_STAKE_RAW"));

    // Resume mode (env): reuse an already-deployed JettonMaster; never deploy/mint again.
    val resumeMaster = env<address>("A9_RESUME_JETTON_MASTER_ADDRESS");
    var masterAddress: address;
    if (resumeMaster == null) {
        // --- 1. JettonMaster ------------------------------------------------
        var metadata: OnchainMetadataReply = { contentDict: [] };
        // A9_DEPLOY_METADATA_URI (testnet reruns only): a different URI gives a fresh master address,
        // since the address is derived from the initial data. Mainnet keeps the default.
        val metadataUri = env<string>("A9_DEPLOY_METADATA_URI") ?? "https://a9.lat/a9.json";
        metadata.contentDict.set("uri".sha256(), metadataUri.prefixWith00());
        val masterStorage = MasterStorage {
            totalSupply: 0,
            adminAddress: admin.address,
            nextAdminAddress: null,
            metadata: metadata.toCell(),
        };
        val masterInit = ContractState { code: build("JettonMaster"), data: masterStorage.toCell() };
        masterAddress = AutoDeployAddress { stateInit: masterInit }.calculateAddress();
        fs.writeString(addrFile("jetton-master"), format("{}\n", masterAddress));
        net.send(deployer.address, createMessage({
            bounce: false,
            value: masterTon,
            dest: { stateInit: masterInit },
            body: TopUpTons {},
        })).waitForTrace();
        println("JettonMaster deployed at {}", masterAddress);

        // --- 2. Mint 100e9 exactly once (mint closes permanently) -----------
        val mintBody = beginCell()
            .storeUint(0x00000015, 32) // MintOnce
            .storeUint(0, 64)
            .storeAddress(admin.address)
            .storeCoins(mintForwardTon) // ton_amount forwarded to the new wallet
            .storeCoins(PARAM_TOTAL_SUPPLY) // jetton_amount
            .storeCoins(ton("0.5")) // total_ton_amount attached to mint
            .storeUint(0, 1) // forward_payload: inline empty
            .endCell();
        net.send(admin.address, createMessage({
            bounce: true,
            value: mintTon,
            dest: masterAddress,
            body: mintBody,
        })).waitForTrace();
        println("JettonMaster minted 100e9 A9 to admin; mint is now permanently closed");
        requireActive(masterAddress, "JettonMaster", build("JettonMaster"), masterTon);
    } else {
        masterAddress = resumeMaster!;
        println("reusing JettonMaster at {}", masterAddress);
        requireActive(masterAddress, "JettonMaster(resume)", build("JettonMaster"), 0 as coins);
        fs.writeString(addrFile("jetton-master"), format("{}\n", masterAddress));
        val masterData = net.runGetMethod<JettonDataReply>(masterAddress, "get_jetton_data");
        if (masterData.totalSupply != PARAM_TOTAL_SUPPLY) {
            Assert.fail("resume master totalSupply mismatch: expected 100e9 A9 already minted");
        }
    }

    // --- 3. RoundController (with the real JettonMaster; no wiring step) ----
    val cfg = ProtocolConfig {
        addresses: ProtocolAddresses {
            keeper,
            jettonMaster: masterAddress,
            teamWallet,
        }.toCell(),
        econ: ProtocolEcon {
            p0UsdE8,
            roundRewardRaw,
            teamRoundRaw,
            minStakeRaw,
        }.toCell(),
        timing: ProtocolTiming {
            previewSeconds: previewSeconds as uint32,
            stakeDurationSeconds: stakeSeconds as uint32,
            candleSeconds: candleSeconds as uint32,
            candleCount: candleCount as uint8,
            minQualifiedCandles: minQualified as uint8,
            abortTimeoutSeconds: abortTimeoutSeconds as uint32,
            fallbackUnlockSeconds: fallbackUnlockSeconds as uint32,
            riskDisclosureVersion: 1,
            configVersion: 1,
        }.toCell(),
        codes: ProtocolCodes { jettonWalletCode: build("JettonWallet"), ticketCode: build("StakeTicket") }.toCell(),
    };
    val rcData = Storage {
        config: cfg.toCell(),
        currentRoundId: 0,
        successCount: 0,
        rounds: [],
        carryRaw: 0,
        lastSuccessRound: 0,
        teamPendingRaw: 0,
        endAt: 0,
    };
    val rcInit = ContractState { code: build("RoundController"), data: rcData.toCell() };
    val rcAddress = AutoDeployAddress { stateInit: rcInit }.calculateAddress();
    net.send(deployer.address, createMessage({
        bounce: false,
        value: rcTon,
        dest: { stateInit: rcInit },
        body: TopUpTons {},
    })).waitForTrace();
    requireActive(rcAddress, "RoundController", build("RoundController"), rcTon);
    println("RoundController deployed at {}", rcAddress);

    // --- 4. Verify RC jetton wallet derivation ------------------------------
    val rcWallet = net.runGetMethod<address>(masterAddress, "get_wallet_address", [rcAddress]);
    val rcWalletOnChain = net.runGetMethod<address>(rcAddress, "get_jetton_wallet_address");
    if (rcWalletOnChain != rcWallet) {
        Assert.fail(
            format(
                "RC.get_jetton_wallet_address={} does not match master.get_wallet_address(RC)={}",
                rcWalletOnChain,
                rcWallet,
            ),
        );
    }
    fs.writeString(addrFile("round-controller"), format("{}\n", rcAddress));
    println("RC Jetton Wallet     = {}", rcWallet);

    // --- 5. Fund RC: 10 rounds of reward + 10 rounds of team quota ----------
    val adminWallet = net.runGetMethod<address>(masterAddress, "get_wallet_address", [admin.address]);
    val adminBalance = net.runGetMethod<JettonWalletDataReply>(adminWallet, "get_wallet_data").jettonBalance;
    val rcFundRaw = (roundRewardRaw * 10 + teamRoundRaw * 10) as coins;
    if (adminBalance < rcFundRaw) {
        Assert.fail(format("admin A9 balance {} insufficient for RC funding {}", adminBalance, rcFundRaw));
    }
    // forward_ton_amount = 0: RC receives no transfer_notification (it would be treated as a deposit)
    net.send(admin.address, createMessage({
        bounce: true,
        value: fundTon,
        dest: adminWallet,
        body: AskToTransferMsg {
            queryId: 1,
            jettonAmount: rcFundRaw,
            transferRecipient: rcAddress,
            sendExcessesTo: admin.address,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: beginCell().storeUint(0, 1).toSlice(),
        },
    })).waitForTrace();
    val rcBalance = net.runGetMethod<JettonWalletDataReply>(rcWallet, "get_wallet_data").jettonBalance;
    if (rcBalance != rcFundRaw) {
        Assert.fail(format("RC jetton balance {} != expected funding {}", rcBalance, rcFundRaw));
    }
    println("Funded RC Jetton Wallet with {} raw A9 (balance verified = {})", rcFundRaw, rcBalance);

    // --- 6. JunxiangDistributor (deployed, NOT funded: ops funds before each root) ---
    val distStorage = DistributorStorage {
        publisher: junxiangPublisher,
        jettonMaster: masterAddress,
        codes: DistributorCodes { jettonWalletCode: build("JettonWallet"), recordCode: build("ClaimRecord") }.toCell(),
        root: 0 as uint256,
        listId: 0,
        totalPaidRaw: 0,
    };
    val distInit = ContractState { code: build("JunxiangDistributor"), data: distStorage.toCell() };
    val distAddress = AutoDeployAddress { stateInit: distInit }.calculateAddress();
    net.send(deployer.address, createMessage({
        bounce: false,
        value: distTon,
        dest: { stateInit: distInit },
        body: TopUpTons {},
    })).waitForTrace();
    requireActive(distAddress, "JunxiangDistributor", build("JunxiangDistributor"), distTon);
    fs.writeString(addrFile("junxiang-distributor"), format("{}\n", distAddress));
    println("JunxiangDistributor deployed at {}", distAddress);
    val distWallet = net.runGetMethod<address>(masterAddress, "get_wallet_address", [distAddress]);
    println("Distributor Jetton Wallet = {} (not funded by deploy; ops funds it before junxiang-set-root)", distWallet);

    // --- 7. Read-back: RC ticket code hash + distributor state ---------------
    val ticketHashBuild = build("StakeTicket").hash();
    val ticketHashOnChain = net.runGetMethod<uint256>(rcAddress, "get_ticket_code_hash");
    println("RC get_ticket_code_hash      = 0x{:x} (build StakeTicket = 0x{:x})", ticketHashOnChain, ticketHashBuild);
    if (ticketHashOnChain != ticketHashBuild) {
        Assert.fail("RC.get_ticket_code_hash does not match build StakeTicket");
    }
    val distView = net.runGetMethod<DistributorView>(distAddress, "get_distributor");
    println(
        "JunxiangDistributor get_distributor = publisher={} listId={} root=0x{:x} totalPaidRaw={}",
        distView.publisher, distView.listId, distView.root, distView.totalPaidRaw,
    );
    if (distView.publisher != junxiangPublisher) {
        Assert.fail("JunxiangDistributor.publisher does not match junxiangPublisher");
    }
    if (distView.listId != 0 || distView.totalPaidRaw != 0) {
        Assert.fail("JunxiangDistributor must start with listId=0 and totalPaidRaw=0");
    }

    // --- Summary ------------------------------------------------------------
    println("");
    println("=== A9 v11 deploy summary ===");
    println("  JettonMaster       = {}", masterAddress);
    println("  RoundController    = {}", rcAddress);
    println("  RC jetton wallet   = {}", rcWallet);
    println("  RC funded balance  = {} raw A9", rcBalance);
    println("  RC ticket code hash = 0x{:x}", ticketHashOnChain);
    println("  JunxiangDistributor = {}", distAddress);
    println("  Distributor jetton wallet = {}", distWallet);
    println("  Distributor code hash = 0x{:x} (build)", build("JunxiangDistributor").hash());
    println("  junxiangPublisher  = {}", junxiangPublisher);
    println("  keeper             = {}", keeper);
    println("  teamWallet         = {}", teamWallet);
    println("  address files      = deploy/<name>.addr (emulation: deploy/<name>.emulation.addr)");
    println("TODO (ops): seed extra TON gas balance on RC if needed (RC >= 20 TON recommended).");
}
