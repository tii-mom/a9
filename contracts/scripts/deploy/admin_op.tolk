// Keeper / operator operation on RoundController (v10).
// POSITIONAL args:
//   acton script scripts/deploy/admin_op.tolk <op> <roundId> <extra>
//
// op + args:
//   open-round        extra = opening 24h TWAP (USD_E8), roundId ignored (0)
//   close-staking     extra = current 1h TWAP (USD_E8), roundId ignored (0)
//   submit-candle     roundId; candle fields via env:
//                     A9_CANDLE_INDEX / A9_PERIOD_START / A9_PERIOD_END /
//                     A9_TWAP_E8 / A9_DIGEST (64 hex or 0x + 64 hex)
//   abort-technical   roundId/extra ignored
//   retry-settlement  roundId, extra ignored (alias: retry-pending)
//
// Removed in v10 (fail with a clear message): start-observation, finalize-round,
// pause-oracle, resume-oracle, oracle-candle, set-jetton-wallet, init-controller.
//
// Addresses: ROUND_CONTROLLER_ADDRESS env or deploy/round-controller.addr.
// Dry-run by default; broadcast with OPS_EXECUTE=1 OPS_CONFIRM=YES + --net testnet.
//
// Examples:
//   admin_op.tolk open-round 0 232000
//   admin_op.tolk close-staking 0 0
//   admin_op.tolk retry-settlement 1 0
//   A9_CANDLE_INDEX=0 A9_PERIOD_START=... A9_PERIOD_END=... A9_TWAP_E8=232000 \
//     A9_DIGEST=<64 hex> admin_op.tolk submit-candle 1 0

import "@acton/env"
import "@stdlib/strings"
import "@acton/fmt"
import "@acton/io"
import "@acton/testing/assert"
import "@acton/emulation/scripts"
import "@contracts/constants"
import "actions"

struct OpPlan {
    target: address
    opcode: uint32
    label: string
    message: OutMessage
    details: string
}

fun candleEnvInt(name: string, label: string): int {
    val v = env<int>(name);
    if (v == null) {
        Assert.fail(format("submit-candle requires env {} ({})", name, label));
    }
    return v!;
}

fun candleEnvDigest(): uint256 {
    val raw = env<string>("A9_DIGEST");
    if (raw == null) {
        Assert.fail("submit-candle requires env A9_DIGEST (64 hex chars or 0x + 64 hex chars)");
    }
    return parseDigestHex(raw!, "A9_DIGEST");
}

fun isRemovedOp(opName: string): bool {
    return opName.equalTo("start-observation")
        || opName.equalTo("finalize-round")
        || opName.equalTo("pause-oracle")
        || opName.equalTo("resume-oracle")
        || opName.equalTo("oracle-candle")
        || opName.equalTo("set-jetton-wallet")
        || opName.equalTo("init-controller");
}

fun planCandleOp(opName: string, roundId: int, rc: address): OpPlan {
    if (roundId < 1 || roundId > 10) {
        Assert.fail(format("{} roundId must be 1..10, got {}", opName, roundId));
    }
    val candleIndex = candleEnvInt("A9_CANDLE_INDEX", "0..23");
    val periodStart = candleEnvInt("A9_PERIOD_START", "unix seconds");
    val periodEnd = candleEnvInt("A9_PERIOD_END", "unix seconds");
    val twap = candleEnvInt("A9_TWAP_E8", "USD_E8");
    if (candleIndex < 0 || candleIndex > 255) {
        Assert.fail("A9_CANDLE_INDEX must be 0..255");
    }
    if (periodStart <= 0 || periodEnd <= periodStart) {
        Assert.fail(
            format(
                "invalid candle period: periodStart={} periodEnd={} (periodEnd must be > periodStart > 0)",
                periodStart,
                periodEnd,
            ),
        );
    }
    if (twap <= 0) {
        Assert.fail("A9_TWAP_E8 must be > 0");
    }
    val digest = candleEnvDigest();
    var sb = StringBuilder.create();
    sb.append("roundId=").appendInt(roundId);
    sb.append(" candleIndex=").appendInt(candleIndex);
    sb.append(" periodStart=").appendInt(periodStart);
    sb.append(" periodEnd=").appendInt(periodEnd);
    sb.append(" twapUsdE8=").appendInt(twap);
    sb.append(" digest=0x").append(format("{:x}", digest));
    val details = sb.build();
    return {
        target: rc,
        opcode: OP_SUBMIT_CANDLE,
        label: "SubmitCandle",
        message: buildSubmitCandle(
            rc,
            roundId as uint8,
            candleIndex as uint8,
            periodStart as uint32,
            periodEnd as uint32,
            twap as uint128,
            digest,
        ),
        details,
    };
}

fun planControllerOp(op: string, roundId: int, extra: int, rc: address): OpPlan {
    // Acton passes script string args as slices; format() materialises a real string for comparisons.
    val opName = format("{}", op);
    if (isRemovedOp(opName)) {
        Assert.fail(format("{} was removed in v10", opName));
    }
    if (opName.equalTo("open-round")) {
        return {
            target: rc,
            opcode: OP_OPEN_ROUND,
            label: "OpenRound",
            message: buildOpenRound(rc, extra as uint128),
            details: "",
        };
    }
    if (opName.equalTo("close-staking")) {
        return {
            target: rc,
            opcode: OP_CLOSE_STAKING,
            label: "CloseStaking",
            message: buildCloseStaking(rc, extra as uint128),
            details: "",
        };
    }
    if (opName.equalTo("abort-technical")) {
        return {
            target: rc,
            opcode: OP_ABORT_TECHNICAL,
            label: "AbortTechnical",
            message: buildAbortTechnical(rc),
            details: "",
        };
    }
    if (opName.equalTo("retry-settlement") || opName.equalTo("retry-pending")) {
        return {
            target: rc,
            opcode: OP_RETRY_SETTLEMENT,
            label: "RetrySettlement",
            message: buildRetrySettlement(rc, roundId as uint8),
            details: "",
        };
    }
    if (opName.equalTo("submit-candle")) {
        return planCandleOp(opName, roundId, rc);
    }
    Assert.fail(
        format(
            "unknown op: {} (expected open-round/close-staking/submit-candle/abort-technical/retry-settlement)",
            opName,
        ),
    );
}

fun main(op: string, roundId: int, extra: int) {
    // fail on removed ops before any address lookup
    if (isRemovedOp(format("{}", op))) {
        Assert.fail(format("{} was removed in v10", format("{}", op)));
    }
    val rc = resolveAddress(
        "ROUND_CONTROLLER_ADDRESS",
        "deploy/round-controller.addr",
        "RoundController",
    );
    val signer = scripts.wallet(signerName());
    val plan = planControllerOp(op, roundId, extra, rc);

    println("admin_op:");
    println("  signer      = {}", signer.address);
    println("  wallet name = {}", signerName());
    println("  op          = {} ({})", format("{}", op), plan.label);
    println("  roundId     = {}", roundId);
    println("  extra       = {}", extra);
    if (plan.details.calculateLength() > 0) {
        println("  fields      = {}", plan.details);
    }
    printSummary("  message", plan.target, ton("0.3"), plan.opcode, plan.message);
    broadcastOrDryRun(signer.address, plan.message);
}
