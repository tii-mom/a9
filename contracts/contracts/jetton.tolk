// Shared TEP-74 message builders + forward-payload helpers (RoundController side).
import "constants"

// Standard TEP-74 transfer body; forward_ton_amount = 0 so the recipient wallet
// sends no notification (the second hop cannot fail for lack of TON).
fun buildJettonTransferBody(
    queryId: uint64,
    amount: coins,
    recipient: address,
    responseDestination: address,
): cell {
    return beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(recipient)
        .storeAddress(responseDestination)
        .storeMaybeRef(null)
        .storeCoins(0)
        .storeUint(0, 1) // forward_payload: Either left (inline), empty
        .endCell();
}

fun buildJettonBurnBody(queryId: uint64, amount: coins, responseDestination: address): cell {
    return beginCell()
        .storeUint(OP_JETTON_BURN, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(responseDestination)
        .storeMaybeRef(null)
        .endCell();
}

// transfer_notification.forward_payload is Either Cell ^Cell; returns the payload slice.
fun unwrapForwardPayload(raw: slice): slice {
    var p = raw;
    if (p.remainingBitsCount() >= 1) {
        val isRef = p.preloadUint(1);
        if (isRef == 1) {
            p.loadUint(1);
            if (p.remainingRefsCount() >= 1) {
                return p.loadRef().beginParse();
            }
            return p; // malformed; caller fails validation
        }
        p.loadUint(1);
    }
    return p;
}

// Settlement transfer/burn paid from the RC balance (bounceable: a first-hop
// failure comes back to RC and marks the action for retry).
fun sendFromBalance(jettonWallet: address, body: cell) {
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: VALUE_JETTON_ACTION,
        dest: jettonWallet,
        body,
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

// User-initiated transfer (claim / instant refund): the inbound message pays.
fun sendWithInboundValue(jettonWallet: address, body: cell) {
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: jettonWallet,
        body,
    });
    out.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// User-initiated transfer after reserveToncoinsOnBalance(original − inbound): carries the rest of
// the inbound value, so external events emitted earlier in the same transaction are paid by the
// user, never by the contract's own balance.
fun sendWithReservedBalance(jettonWallet: address, body: cell) {
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: jettonWallet,
        body,
    });
    // SAFETY: callers reserve the contract's original balance minus this message's value first.
    out.send(SEND_MODE_CARRY_ALL_BALANCE);
}

fun emitExternalEvent<T>(body: T): void {
    createExternalLogMessage({
        dest: createAddressNone(),
        body,
    }).send(SEND_MODE_REGULAR);
}
