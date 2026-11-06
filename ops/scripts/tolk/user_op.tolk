// User operations on a v10 RC: stake / claim / claim-all.
// Usage examples:
//   acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/user_op.tolk stake 100000000000000 1 1 <dummy>
//   ... claim 1 0 0 <dummy>        (Claim(roundId): principal + full reward; roundId 0 = refund ledger)
//   ... claim-all 0 0 0 <dummy>    (ClaimAll: rounds 1..10 + refund ledger)
// Stake: min 100,000 A9, forward_ton_amount >= 0.1 TON (0.12 used), total message 0.3 TON.
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

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
        val nonce: uint64 = arg3 as uint64;
        val wallet = net.runGetMethod<address>(jettonMaster(), "get_wallet_address", [signer.address]);
        val payload = beginCell()
            .storeUint(0, 1) // inline forward payload
            .storeUint(0x5254000F, 32)
            .storeUint(1, 8) // version
            .storeUint(roundId, 8)
            .storeUint(nonce, 64)
            .storeUint(1, 16) // risk version
            .storeUint(1, 8)  // accept burn
            .toSlice();
        net.send(signer.address, createMessage({
            bounce: true,
            value: ton("0.3"),
            dest: wallet,
            body: AskToTransferMsg {
                queryId: nonce,
                jettonAmount: amount,
                transferRecipient: rc,
                sendExcessesTo: signer.address,
                customPayload: null,
                forwardTonAmount: ton("0.12"),
                forwardPayload: payload,
            },
        }));
        println("stake sent: amount={} round={} nonce={}", amount, roundId, nonce);
        return;
    }
    if (op.equalTo("claim")) {
        // roundId 0 = refund ledger; principal + full reward in one message
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: Claim { queryId: arg2 as uint64, roundId: arg1 as uint8 } }));
        println("claim sent round={}", arg1);
        return;
    }
    if (op.equalTo("claim-all")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: ClaimAll { queryId: arg2 as uint64, roundId: 0 } }));
        println("claim-all sent");
        return;
    }
    throw 400;
}
