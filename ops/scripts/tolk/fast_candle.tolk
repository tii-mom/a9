// Fast-test keeper candle submitter: sends SubmitCandle directly with a small TON value.
// Usage: A9_PERIOD_START=... A9_PERIOD_END=... A9_TWAP_E8=... acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/fast_candle.tolk <roundId> <candleIndex>
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun signerName(): string { return env<string>("A9_SIGNER_WALLET") ?? "a9-keeper"; }
fun envInt(name: string): int { val v = env<int>(name); if (v == null) { throw 400; } return v!; }

fun main(roundId: int, candleIndex: int) {
    val rc = env<address>("ROUND_CONTROLLER_ADDRESS");
    if (rc == null) { throw 400; }
    val signer = scripts.wallet(signerName());
    val periodStart = envInt("A9_PERIOD_START");
    val periodEnd = envInt("A9_PERIOD_END");
    val twap = envInt("A9_TWAP_E8");
    net.send(signer.address, createMessage({
        bounce: true,
        value: ton("0.01"),
        dest: rc!,
        body: SubmitCandle {
            queryId: 0,
            roundId: roundId as uint8,
            candleIndex: candleIndex as uint8,
            periodStart: periodStart as uint32,
            periodEnd: periodEnd as uint32,
            twapPriceUsdE8: twap as uint128,
            dataDigest: 0 as uint256,
        },
    }));
    println("candle sent: round={} index={} period={}..{} twap={}", roundId, candleIndex, periodStart, periodEnd, twap);
}
