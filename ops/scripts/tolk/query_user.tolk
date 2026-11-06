// Query user getters on a v10 RoundController.
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/query_user.tolk <cmd> <owner> <roundId>
// cmd: stake|reward|claimable
import "@stdlib/strings"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun main(cmd: string, owner: address, roundId: int) {
    val rc = env<address>("ROUND_CONTROLLER_ADDRESS");
    if (rc == null) { throw 400; }
    val op = format("{}", cmd);
    if (op.equalTo("stake")) {
        val v = net.runGetMethod<StakePositionView>(rc!, "get_user_stake", [roundId as uint8, owner]);
        println("stake amount={} nonce={} claimed={}", v.amountRaw, v.lastDepositNonce, v.principalClaimed);
        return;
    }
    if (op.equalTo("reward")) {
        val r = net.runGetMethod<uint128>(rc!, "get_user_reward_estimate", [roundId as uint8, owner]);
        println("reward {}", r);
        return;
    }
    if (op.equalTo("claimable")) {
        // rewardRaw is the full reward; roundsMask bit r-1 = round r, bit 15 = refund ledger
        val c = net.runGetMethod<Claimable>(rc!, "get_claimable_all", [owner]);
        println("claimable principal={} reward={} mask={}", c.principalRaw, c.rewardRaw, c.roundsMask);
        return;
    }
    throw 400;
}
