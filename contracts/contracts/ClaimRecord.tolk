// A9 军饷 ClaimRecord: one per (distributor, owner). The serialization point for claims:
// it only ever moves claimedRaw upward, so replayed or out-of-order proofs pay nothing.

import "constants"
import "junxiang"

contract ClaimRecord {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "A9 junxiang per-wallet claimed amount."
    storage: RecordStorage
    incomingMessages: RecordAdvance
}

fun RecordStorage.load(): RecordStorage { return RecordStorage.fromCell(contract.getData()); }
fun RecordStorage.save(self) { contract.setData(self.toCell()); }

fun onInternalMessage(in: InMessage) {
    val msg = lazy RecordAdvance.fromSlice(in.body);
    var st = lazy RecordStorage.load();
    assert (in.senderAddress == st.distributor) throw Errors.NotDistributor;
    if (msg.cumulativeRaw <= st.claimedRaw) {
        // nothing new (duplicate / stale proof): the advance is non-bounceable, so return the
        // claimant's TON to the owner instead of keeping it (keep 0.01 TON for storage).
        reserveToncoinsOnBalance(10000000, RESERVE_MODE_AT_MOST);
        val refund = createMessage({
            bounce: BounceMode.NoBounce,
            value: 0,
            dest: st.owner,
            body: RecordExcessesBack { queryId: msg.queryId },
        });
        // SAFETY: storage reserve set above; the record holds no jettons, only the claim's TON.
        refund.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        return;
    }
    val delta: uint128 = msg.cumulativeRaw - st.claimedRaw;
    st.claimedRaw = msg.cumulativeRaw;
    st.save();
    reserveToncoinsOnBalance(10000000, RESERVE_MODE_AT_MOST); // keep 0.01 TON for storage
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: st.distributor,
        body: RecordPay { queryId: msg.queryId, owner: st.owner, amountRaw: delta, cumulativeRaw: msg.cumulativeRaw },
    });
    // SAFETY: storage reserve set above; the record holds no jettons, only the claim's TON.
    out.send(SEND_MODE_CARRY_ALL_BALANCE);
}

get fun get_record(): RecordView {
    val st = lazy RecordStorage.load();
    return { distributor: st.distributor, owner: st.owner, claimedRaw: st.claimedRaw };
}

// TEP-74 excesses op (0xd53276db): wallets show it as a plain TON refund.
struct (0xd53276db) RecordExcessesBack {
    queryId: uint64
}
