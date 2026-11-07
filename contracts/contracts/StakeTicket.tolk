// A9 Protocol v11 — StakeTicket (攻城令): one per (owner, roundId).
//
//   * only the RC can credit stake (TicketAddStake) or confirm a payout (TicketUpdate)
//   * only the owner can ask for a claim / restake; one request in flight at a time
//   * the ticket holds no jettons: it is a receipt the RC verifies by address derivation
//   * a bounced request (RC refused: nothing claimable, window closed...) clears pending

import "constants"
import "ticket"

contract StakeTicket {
    author: "A9 Protocol"
    version: "11.0.0"
    description: "A9 stake ticket: per-owner, per-round receipt for the RoundController."
    storage: TicketStorage
    incomingMessages: TicketMessage
}

type TicketMessage = TicketAddStake | TicketUpdate | TicketClaim | TicketRestake

fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 32) {
        return;
    }
    val op = in.bouncedBody.loadUint(32) as uint32;
    if (op == OP_TICKET_REQUEST) {
        var st = lazy TicketStorage.load();
        st.pending = false;
        st.save();
        returnExcess(st.owner);
    }
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy TicketMessage.fromSlice(in.body);
    match (msg) {
        TicketAddStake => {
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.rc) throw Errors.NotTicket;
            st.amountRaw += msg.amountRaw;
            st.weightRaw += msg.weightRaw;
            st.save();
            returnExcess(st.owner);
        }
        TicketUpdate => {
            var st = lazy TicketStorage.load();
            assert (in.senderAddress == st.rc) throw Errors.NotTicket;
            st.principalDone = msg.principalDone;
            st.lockedClaimedRaw = msg.lockedClaimedRaw;
            st.pending = false;
            st.save();
            returnExcess(st.owner);
        }
        TicketClaim => {
            assert (in.valueCoins >= MIN_TICKET_ACTION_VALUE) throw Errors.NotEnoughValue;
            sendRequest(in.senderAddress, msg.queryId, false);
        }
        TicketRestake => {
            assert (in.valueCoins >= MIN_TICKET_RESTAKE_VALUE) throw Errors.NotEnoughValue;
            sendRequest(in.senderAddress, msg.queryId, true);
        }
        else => throw Errors.UnknownMessage,
    }
}

fun sendRequest(sender: address, queryId: uint64, restake: bool) {
    var st = lazy TicketStorage.load();
    assert (sender == st.owner) throw Errors.NotOwner;
    assert (!st.pending) throw Errors.TicketPending;
    assert (st.amountRaw > 0) throw Errors.NothingToClaim;
    st.pending = true;
    st.save();
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: st.rc,
        body: TicketRequest {
            queryId,
            owner: st.owner,
            roundId: st.roundId,
            amountRaw: st.amountRaw,
            weightRaw: st.weightRaw,
            principalDone: st.principalDone,
            lockedClaimedRaw: st.lockedClaimedRaw,
            restake,
        },
    });
    // an action-phase failure bounces the owner's message (state, incl. pending, is rolled back)
    out.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// Keep a small storage reserve, return everything else to the owner.
fun returnExcess(owner: address) {
    reserveToncoinsOnBalance(TICKET_MIN_BALANCE, RESERVE_MODE_AT_MOST);
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: owner,
        body: ReturnExcessesBackTicket { queryId: 0 },
    });
    // SAFETY: TICKET_MIN_BALANCE is reserved just above; the ticket holds no jettons,
    // so only surplus TON (the owner's own excess) is returned.
    out.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// TEP-74 "excesses" op so wallets display the refund as such.
struct (0xd53276db) ReturnExcessesBackTicket {
    queryId: uint64
}

get fun get_ticket_data(): TicketView {
    val st = lazy TicketStorage.load();
    return {
        rc: st.rc,
        owner: st.owner,
        roundId: st.roundId,
        amountRaw: st.amountRaw,
        weightRaw: st.weightRaw,
        principalDone: st.principalDone,
        lockedClaimedRaw: st.lockedClaimedRaw,
        pending: st.pending,
    };
}
