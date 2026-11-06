// A9 Protocol v11 — StakeTicket (攻城令) shared types: storage, RC <-> ticket messages
// and on-chain address derivation. One ticket per (owner, roundId); the RC keeps only
// round totals, so the number of stakers per round is unbounded (docs/35 D-48).

struct TicketStorage {
    rc: address
    owner: address
    roundId: uint8
    amountRaw: uint128
    weightRaw: uint128
    // principal (+ 20% immediate reward on success) already paid or restaked
    principalDone: bool
    // part of the 80% locked reward already paid
    lockedClaimedRaw: uint128
    // a request is in flight to the RC; cleared by TicketUpdate or by its bounce
    pending: bool
}

fun TicketStorage.load(): TicketStorage {
    return TicketStorage.fromCell(contract.getData());
}

fun TicketStorage.save(self) {
    contract.setData(self.toCell());
}

// Address depends only on (code, rc, owner, roundId): every other field starts at zero.
fun calcDeployedTicket(rc: address, owner: address, roundId: uint8, ticketCode: cell): AutoDeployAddress {
    val empty: TicketStorage = {
        rc,
        owner,
        roundId,
        amountRaw: 0,
        weightRaw: 0,
        principalDone: false,
        lockedClaimedRaw: 0,
        pending: false,
    };
    return { stateInit: { code: ticketCode, data: empty.toCell() } };
}

fun calcTicketAddress(rc: address, owner: address, roundId: uint8, ticketCode: cell): address {
    return calcDeployedTicket(rc, owner, roundId, ticketCode).calculateAddress();
}

// RC -> ticket: credit a deposit (or a restaked principal). Deploys the ticket if needed.
struct (0x52540301) TicketAddStake {
    queryId: uint64
    amountRaw: uint128
    weightRaw: uint128
}

// RC -> ticket: request accepted and paid; store the new claim state.
struct (0x52540302) TicketUpdate {
    queryId: uint64
    principalDone: bool
    lockedClaimedRaw: uint128
}

// owner -> ticket
struct (0x52540303) TicketClaim {
    queryId: uint64
}

// owner -> ticket: move this ticket's principal into the round now staking.
struct (0x52540304) TicketRestake {
    queryId: uint64
}

// ticket -> RC: everything the RC needs to compute and pay, nothing it must store.
struct (0x52540305) TicketRequest {
    queryId: uint64
    owner: address
    roundId: uint8
    amountRaw: uint128
    weightRaw: uint128
    principalDone: bool
    lockedClaimedRaw: uint128
    restake: bool
}

struct TicketView {
    rc: address
    owner: address
    roundId: uint8
    amountRaw: uint128
    weightRaw: uint128
    principalDone: bool
    lockedClaimedRaw: uint128
    pending: bool
}
