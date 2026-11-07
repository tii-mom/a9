// User operations on a v11 RC: stake (payload v2) / claim (TicketClaim) / restake (TicketRestake).
// Usage examples:
//   acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/user_op.tolk stake 1000000000000 1 1 <dummy>
//   ... claim 1 0 0 <dummy>      (TicketClaim to the signer's StakeTicket for round 1)
//   ... restake 1 0 0 <dummy>    (TicketRestake: move round 1's principal into the current round)
// Stake: min 1,000 A9 (v11, no caps), forward_ton_amount >= 0.1 TON (0.12 used), total message 0.3 TON.
// Payload v2: op 0x5254000F | version 2 | roundId | riskDisclosureVersion 1 | acceptFullPrincipalBurn 1
//             | beneficiary = addr_none (the stake belongs to the sender).
// Tickets are addressed by RC.get_ticket_address(owner, roundId); the RC never looks them up by sender.
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"
import "@contracts/ticket"

// TEP-74 transfer body (same layout as contracts/scripts/deploy/actions.tolk).
struct (0x0f8a7ea5) AskToTransferMsg {
    queryId: uint64
    jettonAmount: coins
    transferRecipient: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

fun signerName(): string {
    return env<string>("A9_SIGNER_WALLET") ?? "a9-user";
}

fun rcAddr(): address {
    val a = env<address>("ROUND_CONTROLLER_ADDRESS");
    if (a == null) { throw 400; }
    return a!;
}

fun jettonMaster(): address {
    val a = env<address>("JETTON_MASTER_ADDRESS");
    if (a == null) { throw 400; }
    return a!;
}

fun main(cmd: string, arg1: int, arg2: int, arg3: int, addr: address) {
    val signer = scripts.wallet(signerName());
    val rc = rcAddr();
    val op = format("{}", cmd);

    if (op.equalTo("stake")) {
        val amount: coins = arg1 as coins;
        val roundId: uint8 = arg2 as uint8;
        val queryId: uint64 = arg3 as uint64;
        val wallet = net.runGetMethod<address>(jettonMaster(), "get_wallet_address", [signer.address]);
        val payload = beginCell()
            .storeUint(0, 1) // inline forward payload
            .storeUint(0x5254000F, 32) // StakeDeposit op
            .storeUint(2, 8) // version 2 (v11)
            .storeUint(roundId, 8)
            .storeUint(1, 16) // risk disclosure version
            .storeUint(1, 8) // accept full principal burn
            .storeUint(0, 2) // beneficiary = addr_none (sender)
            .toSlice();
        net.send(signer.address, createMessage({
            bounce: true,
            value: ton("0.3"),
            dest: wallet,
            body: AskToTransferMsg {
                queryId: queryId,
                jettonAmount: amount,
                transferRecipient: rc,
                sendExcessesTo: signer.address,
                customPayload: null,
                forwardTonAmount: ton("0.12"),
                forwardPayload: payload,
            },
        }));
        println("stake sent: amount={} round={} queryId={}", amount, roundId, queryId);
        return;
    }
    if (op.equalTo("claim") || op.equalTo("restake")) {
        // ticket of the signer for round arg1; arg2 = queryId
        val roundId: uint8 = arg1 as uint8;
        val ticket = net.runGetMethod<address>(rc, "get_ticket_address", [signer.address, roundId]);
        if (op.equalTo("claim")) {
            net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: ticket, body: TicketClaim { queryId: arg2 as uint64 } }));
            println("claim sent round={} ticket={}", roundId, ticket);
        } else {
            net.send(signer.address, createMessage({ bounce: true, value: ton("0.3"), dest: ticket, body: TicketRestake { queryId: arg2 as uint64 } }));
            println("restake sent round={} ticket={}", roundId, ticket);
        }
        return;
    }
    throw 400;
}
