// Shared primitives for A9 ops broadcast scripts (contracts/scripts/deploy/*.tolk).
//
// Acton scripts accept POSITIONAL args only (no --flag support). Execution mode and
// addresses that are not part of the operation arguments are taken from env vars:
//   OPS_EXECUTE=1 + OPS_CONFIRM=YES   -> broadcast (otherwise dry-run; default dry-run)
//   OPS_ALLOW_EMULATION=true          -> dev only: allow "execute" without --net
//   A9_SIGNER_WALLET                  -> Acton wallet name (default TON_DEPLOYER_WALLET or "treasury")
//   JETTON_MASTER_ADDRESS             -> fallback: deploy/jetton-master.addr
//   ROUND_CONTROLLER_ADDRESS          -> fallback: deploy/round-controller.addr
//   TEAM_VAULT_ADDRESS                -> fallback: deploy/team-vault.addr

import "@acton/env"
import "@acton/fs"
import "@acton/fmt"
import "@stdlib/strings"
import "@acton/types/big_array"
import "@acton/io"
import "@acton/testing/assert"
import "@acton/emulation/network"
import "@contracts/types"

fun signerName(): string {
    return env<string>("A9_SIGNER_WALLET") ?? (env<string>("TON_DEPLOYER_WALLET") ?? "treasury");
}

fun readAddressFile(path: string): address? {
    if (!fs.exists(path)) {
        return null;
    }
    val text = fs.readFile(path);
    if (text == null) {
        return null;
    }
    return parseAddress(text);
}

fun resolveAddress(envName: string, filePath: string, label: string): address {
    val fromEnv = env<address>(envName);
    if (fromEnv != null) {
        return fromEnv;
    }
    val fromFile = readAddressFile(filePath);
    if (fromFile != null) {
        return fromFile;
    }
    Assert.fail(
        format(
            "missing {}: set {}=<address> or provide {} (run deploy_jetton_master/deploy-emulation first)",
            label,
            envName,
            filePath,
        ),
    );
}

fun executeFlag(): bool {
    return env<bool>("OPS_EXECUTE") ?? false;
}

fun printSummary(
    label: string,
    dest: address,
    value: coins,
    opcode: uint32,
    msg: OutMessage,
) {
    println("{}:", label);
    println("  dest        = {}", dest);
    println("  value       = {} nano", value);
    println("  body opcode = 0x{:x}", opcode);
    println("  message boc = 0x{:x}", msg.messageCell.hash());
}

fun printExecuteHint() {
    println("  mode        = DRY-RUN (nothing broadcast)");
    println("  to execute  : re-run with --net testnet and OPS_EXECUTE=1 OPS_CONFIRM=YES");
}

fun broadcastOrDryRun(from: address, msg: OutMessage): void {
    if (!executeFlag()) {
        printExecuteHint();
        return;
    }
    if (!(env<string>("OPS_CONFIRM") ?? "YES").equalTo("YES")) {
        Assert.fail("OPS_CONFIRM must be YES when OPS_EXECUTE=1");
    }
    val allowEmulation = env<bool>("OPS_ALLOW_EMULATION") ?? false;
    if (!net.isBroadcasting() && !allowEmulation) {
        Assert.fail("OPS_EXECUTE requires --net <network>; for local dev set OPS_ALLOW_EMULATION=true");
    }

    println("  mode        = EXECUTE");
    val res = net.send(from, msg);
    println("  broadcast accepted; waiting for trace...");
    var traced: SendResultList? = null;
    try {
        traced = res.waitForTrace(true, 20, 3000);
    } catch (e) {
        println("  trace lookup failed: {}", e);
        traced = null;
    }
    if (traced == null) {
        println("  tx hash     = (trace unavailable; check the explorer for the signer wallet)");
        return;
    }
    var i = 0;
    while (i < traced.size()) {
        val txCell = traced.at(i).tx as cell;
        println("  tx[{}] hash = 0x{:x}", i, txCell.hash());
        i += 1;
    }
}

// ---------------------------------------------------------------------------
// Message builders (pure; no network access)
// ---------------------------------------------------------------------------

fun buildFundTon(to: address, amountNano: coins): OutMessage {
    return createMessage({
        bounce: true,
        value: amountNano,
        dest: to,
        body: TopUpTons {},
    });
}

fun buildFundJetton(
    sourceWallet: address,
    sourceOwner: address,
    toJettonWallet: address,
    amountRaw: coins,
): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: sourceWallet,
        body: AskToTransfer {
            queryId: 0,
            jettonAmount: amountRaw,
            transferRecipient: toJettonWallet,
            sendExcessesTo: sourceOwner,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: beginCell().storeUint(0, 1).toSlice(),
        },
    });
}

fun buildOpenRound(target: address, twap24hUsdE8: uint128): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: OpenRound { queryId: 0, twap24hUsdE8 },
    });
}

fun buildCloseStaking(target: address, twap1hUsdE8: uint128): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: CloseStaking { queryId: 0, twap1hUsdE8 },
    });
}

fun buildStartObservation(target: address, roundId: uint8): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: StartObservation { queryId: 0, roundId },
    });
}

fun buildFinalizeRound(target: address, roundId: uint8): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: FinalizeRound { queryId: 0, roundId },
    });
}

fun buildPauseOracle(target: address, reason: uint32): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: PauseOracle { queryId: 0, reason },
    });
}

fun buildResumeOracle(target: address): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: ResumeOracle { queryId: 0 },
    });
}

fun buildAbortTechnical(target: address): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: AbortTechnical { queryId: 0 },
    });
}

fun buildRetryPending(target: address, roundId: uint8): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: RetryPendingActions { queryId: 0, roundId },
    });
}

fun buildSetJettonWallet(target: address, wallet: address): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: SetJettonWallet { wallet },
    });
}

fun buildInitController(target: address, controller: address): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: InitController { controller },
    });
}

// RoundController SubmitCandle body: op(32) + queryId(64) + roundId(8) +
// candleIndex(8) + periodStart(32) + periodEnd(32) + twapPriceUsdE8(128) + digest(256).
fun buildSubmitCandle(
    target: address,
    roundId: uint8,
    candleIndex: uint8,
    periodStart: uint32,
    periodEnd: uint32,
    twapUsdE8: uint128,
    dataDigest: uint256,
): OutMessage {
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body: SubmitCandle {
            queryId: 0,
            roundId,
            candleIndex,
            periodStart,
            periodEnd,
            twapPriceUsdE8: twapUsdE8,
            dataDigest,
        },
    });
}

// OracleCandleVerified (0x52540004) shares the SubmitCandle field layout; reserved
// for the phase-2 OracleAdapter (current RoundController has no handler yet).
fun buildOracleCandle(
    target: address,
    roundId: uint8,
    candleIndex: uint8,
    periodStart: uint32,
    periodEnd: uint32,
    twapUsdE8: uint128,
    dataDigest: uint256,
): OutMessage {
    val body = beginCell()
        .storeUint(0x52540004, 32)
        .storeUint(0, 64)
        .storeUint(roundId, 8)
        .storeUint(candleIndex, 8)
        .storeUint(periodStart, 32)
        .storeUint(periodEnd, 32)
        .storeUint(twapUsdE8, 128)
        .storeUint(dataDigest, 256)
        .endCell();
    return createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: target,
        body,
    });
}

fun hexNibble(ch: int, label: string): int {
    if (ch >= 48 && ch <= 57) {
        return ch - 48;
    }
    if (ch >= 97 && ch <= 102) {
        return ch - 87;
    }
    if (ch >= 65 && ch <= 70) {
        return ch - 55;
    }
    Assert.fail(format("{}: invalid hex digit", label));
}

// Parses 64 hex chars (optionally 0x-prefixed) into uint256 at runtime.
fun parseDigestHex(raw: string, envName: string): uint256 {
    val len = raw.calculateLength();
    var s = raw.beginParse();
    if (len == 66) {
        val c0 = s.loadUint(8);
        val c1 = s.loadUint(8);
        if (c0 != 48 || c1 != 120) {
            Assert.fail(format("{} must be 64 hex chars or 0x + 64 hex chars", envName));
        }
    } else if (len != 64) {
        Assert.fail(format("{} must be 64 hex chars (or 0x + 64 hex chars), got {} chars", envName, len));
    }
    var value: int = 0;
    var i = 0;
    while (i < 64) {
        val ch = s.loadUint(8);
        value = value * 16 + hexNibble(ch, envName);
        i += 1;
    }
    return value as uint256;
}
