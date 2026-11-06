// Query user getters on a RoundController.
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/query_user.tolk <cmd> <owner> <roundId>
// cmd: stake|weight|reward|claimable|referral|streak|unlock
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
        val v = net.runGetMethod<StakePosition>(rc!, "get_user_stake", [roundId as uint8, owner]);
        println("stake amount={} weight={} nonce={}", v.amountRaw, v.weight, v.lastDepositNonce);
        println("stake principalClaimed={} rewardClaimed={} rewardState={}", v.principalClaimed, v.rewardClaimed, v.rewardState);
        return;
    }
    if (op.equalTo("weight")) {
        val w = net.runGetMethod<uint128>(rc!, "get_user_weight", [roundId as uint8, owner]);
        println("weight {}", w);
        return;
    }
    if (op.equalTo("reward")) {
        val r = net.runGetMethod<uint128>(rc!, "get_user_reward_estimate", [roundId as uint8, owner]);
        println("reward {}", r);
        return;
    }
    if (op.equalTo("claimable")) {
        val c = net.runGetMethod<Claimable>(rc!, "get_claimable_all", [owner]);
        println("claimable principal={} reward={} mask={}", c.principalRaw, c.rewardRaw, c.roundsMask);
        return;
    }
    if (op.equalTo("referral")) {
        val r = net.runGetMethod<ReferralInfo>(rc!, "get_referral", [owner]);
        println("referral referrer={} referredStake={} bonus={}", r.referrer, r.referredStakeThisRound, r.bonusThisRound);
        return;
    }
    if (op.equalTo("streak")) {
        val s = net.runGetMethod<StreakInfo>(rc!, "get_streak", [owner]);
        println("streak lastRound={} count={}", s.lastRound, s.count);
        return;
    }
    if (op.equalTo("unlock")) {
        val u = net.runGetMethod<UnlockInfo>(rc!, "get_unlock_info", [owner]);
        println("unlock start={} totalLocked={}", u.unlockStart, u.totalLockedRaw);
        return;
    }
    throw 400;
}
