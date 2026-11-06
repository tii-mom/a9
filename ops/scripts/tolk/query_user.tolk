// Query a user's position on a v11 RoundController through the user's StakeTicket (攻城令).
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/query_user.tolk <cmd> <owner> <roundId>
// cmd: stake      -> ticket state (amount / weight / principalDone / lockedClaimed / pending)
//      claimable  -> what the ticket is owed now (RC.get_reward_preview on the ticket weight)
// A ticket that was never created (no stake, or a stake below the minimum) makes the getter
// fail; the script then exits non-zero and the caller reads that as amount = 0.
import "@stdlib/strings"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"
import "@contracts/ticket"

fun main(cmd: string, owner: address, roundId: int) {
    val rc = env<address>("ROUND_CONTROLLER_ADDRESS");
    if (rc == null) { throw 400; }
    val op = format("{}", cmd);
    val ticket = net.runGetMethod<address>(rc!, "get_ticket_address", [owner, roundId as uint8]);
    if (op.equalTo("stake")) {
        val v = net.runGetMethod<TicketView>(ticket, "get_ticket_data");
        println("stake amount={} weight={} principalDone={} lockedClaimed={} pending={}", v.amountRaw, v.weightRaw, v.principalDone, v.lockedClaimedRaw, v.pending);
        return;
    }
    if (op.equalTo("claimable")) {
        val v = net.runGetMethod<TicketView>(ticket, "get_ticket_data");
        val p = net.runGetMethod<RewardPreview>(rc!, "get_reward_preview", [roundId as uint8, v.weightRaw]);
        println("claimable reward={} immediate={} locked={} unlockedLocked={} principalDone={}", p.rewardRaw, p.immediateRaw, p.lockedRaw, p.unlockedLockedRaw, v.principalDone);
        return;
    }
    throw 400;
}
