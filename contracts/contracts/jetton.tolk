// Shared TEP-74 message builders + forward-payload helpers.
import "constants"

// Builds a standard TEP-74 transfer body (forward_payload inline, empty).
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

// Builds a standard TEP-74 burn body.
fun buildJettonBurnBody(queryId: uint64, amount: coins, responseDestination: address): cell {
    return beginCell()
        .storeUint(OP_JETTON_BURN, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(responseDestination)
        .storeMaybeRef(null)
        .endCell();
}

// transfer_notification.forward_payload is an Either Cell ^Cell:
//   $0 <inline payload>
//   $1 ^<payload cell>
// Returns the actual StakePayload slice.
fun unwrapForwardPayload(raw: slice): slice {
    var p = raw;
    if (p.remainingBitsCount() >= 1) {
        val isRef = p.preloadUint(1);
        if (isRef == 1) {
            p.loadUint(1);
            if (p.remainingRefsCount() >= 1) {
                return p.loadRef().beginParse();
            }
            return p; // malformed; caller will fail payload validation
        }
        p.loadUint(1);
    }
    return p;
}

// Sends a Jetton transfer request from the calling contract's own Jetton Wallet.
fun sendJettonTransfer(
    jettonWallet: address,
    queryId: uint64,
    amount: coins,
    recipient: address,
    responseDestination: address,
): void {
    val body = buildJettonTransferBody(queryId, amount, recipient, responseDestination);
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: ton("0.05"),
        dest: jettonWallet,
        body,
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun sendJettonBurn(jettonWallet: address, queryId: uint64, amount: coins, responseDestination: address): void {
    val body = buildJettonBurnBody(queryId, amount, responseDestination);
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: ton("0.05"),
        dest: jettonWallet,
        body,
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun emitExternalEvent<T>(body: T): void {
    createExternalLogMessage({
        dest: createAddressNone(),
        body,
    }).send(SEND_MODE_REGULAR);
}
