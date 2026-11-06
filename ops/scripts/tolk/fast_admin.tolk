// Fast-test admin ops with small TON value: open-round / close-staking / finalize-round.
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/fast_admin.tolk <cmd> <roundId> <twap>
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun signerName(): string { return env<string>("A9_SIGNER_WALLET") ?? "a9-fast-admin"; }

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
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.012"), dest: rc!, body: CloseStaking { queryId: 0, twap1hUsdE8: twap as uint128 } }));
        println("close-staking sent twap={}", twap);
        return;
    }
    if (op.equalTo("finalize-round")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.012"), dest: rc!, body: FinalizeRound { queryId: 0, roundId: roundId as uint8 } }));
        println("finalize-round sent round={}", roundId);
        return;
    }
    throw 400;
}
