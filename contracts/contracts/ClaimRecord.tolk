// A9 军饷 ClaimRecord: one per (distributor, owner). The serialization point for claims:
// it only ever moves claimedRaw upward, so replayed or out-of-order proofs pay nothing.

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
    assert (in.senderAddress == st.distributor) throw 270;
    // nothing new: throw so the distributor-bound value bounces back
    assert (msg.cumulativeRaw > st.claimedRaw) throw 271;
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
