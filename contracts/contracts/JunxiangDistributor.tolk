// A9 军饷 distributor (docs/35 §4.4): pays weekly cumulative Merkle allocations in A9.
//
//   * publisher posts roots with strictly increasing listId (only the latest is valid)
//   * claimant proves (self, cumulative) against the root -> ClaimRecord(self) advances
//     claimedRaw -> RecordPay back here (sender verified by address derivation) -> A9 out
//   * funded by plain jetton transfers to its wallet (no notification needed)
//   * no admin, no withdrawal, no upgrade. Trust: the publisher key decides allocations.
//     Ops rule: fund the wallet with >= the list's new total BEFORE publishing its root.

import "junxiang"
import "types"
import "constants"
import "jetton"
import "jetton/jetton-utils"

contract JunxiangDistributor {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "A9 junxiang cumulative merkle distributor."
    storage: DistributorStorage
    incomingMessages: DistributorMessage
}

type DistributorMessage = SetRoot | ClaimJunxiang | RecordPay | TopUpTons | ReturnExcessesBack

fun DistributorStorage.load(): DistributorStorage { return DistributorStorage.fromCell(contract.getData()); }
fun DistributorStorage.save(self) { contract.setData(self.toCell()); }

const MIN_JUNXIANG_CLAIM_VALUE: int = 150000000; // claimant pays the record hop + jetton transfer

fun distributorWallet(st: DistributorStorage): address {
    return calcAddressOfJettonWallet(contract.getAddress(), st.jettonMaster, st.codes.load().jettonWalletCode);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy DistributorMessage.fromSlice(in.body);
    match (msg) {
        SetRoot => {
            var st = lazy DistributorStorage.load();
            assert (in.senderAddress == st.publisher) throw Errors.NotKeeper;
            assert (msg.listId > st.listId) throw Errors.BadRoundId;
            st.root = msg.root;
            st.listId = msg.listId;
            st.save();
            emitExternalEvent(RootPublished { listId: msg.listId, root: msg.root });
        }
        ClaimJunxiang => {
            assert (in.valueCoins >= MIN_JUNXIANG_CLAIM_VALUE) throw Errors.NotEnoughValue;
            assert (in.senderAddress.getWorkchain() == BASECHAIN) throw Errors.WrongWorkchain;
            val st = lazy DistributorStorage.load();
            assert (st.root != 0) throw Errors.NothingToClaim;
            val leaf = junxiangLeaf(in.senderAddress, msg.cumulativeRaw);
            assert (merkleRootOf(leaf, msg.proof) == st.root) throw Errors.NothingToClaim;
            val out = createMessage({
                bounce: BounceMode.NoBounce, // a refused advance (nothing new) keeps the claimant's TON in the record
                value: 0,
                dest: calcDeployedRecord(contract.getAddress(), in.senderAddress, st.codes.load().recordCode),
                body: RecordAdvance { queryId: msg.queryId, cumulativeRaw: msg.cumulativeRaw },
            });
            out.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }
        RecordPay => {
            var st = lazy DistributorStorage.load();
            assert (in.senderAddress == calcRecordAddress(contract.getAddress(), msg.owner, st.codes.load().recordCode)) throw Errors.NotTicket;
            st.totalPaidRaw += msg.amountRaw;
            st.save();
            // The claimant pays everything: keep the distributor's own TON, then the event and the
            // jetton transfer are both paid from this message's value (A9-V11-01).
            reserveToncoinsOnBalance(contract.getOriginalBalance() - in.valueCoins, RESERVE_MODE_AT_MOST);
            emitExternalEvent(JunxiangClaimed { owner: msg.owner, amountRaw: msg.amountRaw, cumulativeRaw: msg.cumulativeRaw });
            sendWithReservedBalance(distributorWallet(st), buildJettonTransferBody(msg.queryId, msg.amountRaw as coins, msg.owner, msg.owner));
        }
        TopUpTons => {}
        ReturnExcessesBack => {}
        else => {
            // plain jetton notifications (funding) and anything else are accepted silently
        }
    }
}

get fun get_distributor(): DistributorView {
    val st = lazy DistributorStorage.load();
    return { publisher: st.publisher, root: st.root, listId: st.listId, totalPaidRaw: st.totalPaidRaw };
}

get fun get_record_address(owner: address): address {
    val st = lazy DistributorStorage.load();
    return calcRecordAddress(contract.getAddress(), owner, st.codes.load().recordCode);
}
