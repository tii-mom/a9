// Fast-test keeper / ops messages (v10) with small TON values.
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/fast_admin.tolk <cmd> <roundId> <twap>
//   open-round        keeper only; roundId ignored (RC opens the round after the settled one), twap = opening 24h TWAP
//   close-staking     anyone, after the 36h window; roundId/twap ignored
//   abort-technical   anyone, 7 days after the observation / preview should have ended
//   retry-settlement  anyone, after a SettlementBounced event for <roundId> (RC requires >= 0.3 TON)
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun signerName(): string { return env<string>("A9_SIGNER_WALLET") ?? "a9-keeper"; }

fun main(cmd: string, roundId: int, twap: int) {
    val rc = env<address>("ROUND_CONTROLLER_ADDRESS");
    if (rc == null) { throw 400; }
    val signer = scripts.wallet(signerName());
    val op = format("{}", cmd);
    if (op.equalTo("open-round")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.012"), dest: rc!, body: OpenRound { queryId: 0, twap24hUsdE8: twap as uint128 } }));
        println("open-round sent twap={}", twap);
        return;
    }
    if (op.equalTo("close-staking")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.012"), dest: rc!, body: CloseStaking { queryId: 0, twap1hUsdE8: 0 } }));
        println("close-staking sent");
        return;
    }
    if (op.equalTo("abort-technical")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.05"), dest: rc!, body: AbortTechnical { queryId: 0 } }));
        println("abort-technical sent");
        return;
    }
    if (op.equalTo("retry-settlement")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.3"), dest: rc!, body: RetrySettlement { queryId: 0, roundId: roundId as uint8 } }));
        println("retry-settlement sent round={}", roundId);
        return;
    }
    throw 400;
}
