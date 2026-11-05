// User operations for fast-test RC: stake / set-referrer / claims.
// Usage examples:
//   acton script --manifest-path contracts/Acton.toml --net testnet ops/scripts/tolk/user_op.tolk stake 100000000000000 1 1 <dummy>
//   ... set-referrer 0 0 0 <referrer>
//   ... claim-principal 1 0 0 <dummy>
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun signerName(): string {
    return env<string>("A9_SIGNER_WALLET") ?? "a9-fast-admin";
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
            value: ton("0.35"),
            dest: wallet,
            body: AskToTransfer {
                queryId: nonce,
                jettonAmount: amount,
                transferRecipient: rc,
                sendExcessesTo: signer.address,
                customPayload: null,
                forwardTonAmount: ton("0.18"),
                forwardPayload: payload,
            },
        }));
        println("stake sent: amount={} round={} nonce={}", amount, roundId, nonce);
        return;
    }
    if (op.equalTo("set-referrer")) {
        net.send(signer.address, createMessage({
            bounce: true,
            value: ton("0.1"),
            dest: rc,
            body: SetReferrer { referrer: addr },
        }));
        println("set-referrer sent: {}", addr);
        return;
    }
    if (op.equalTo("claim-principal")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: ClaimPrincipal { queryId: arg2 as uint64, roundId: arg1 as uint8 } }));
        println("claim-principal sent round={}", arg1);
        return;
    }
    if (op.equalTo("claim-reward")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: ClaimReward { queryId: arg2 as uint64, roundId: arg1 as uint8 } }));
        println("claim-reward sent round={}", arg1);
        return;
    }
    if (op.equalTo("claim-early")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: ClaimRewardEarly { queryId: arg2 as uint64, roundId: arg1 as uint8 } }));
        println("claim-early sent round={}", arg1);
        return;
    }
    if (op.equalTo("roll")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: RollReward { queryId: arg2 as uint64, roundId: arg1 as uint8 } }));
        println("roll sent round={}", arg1);
        return;
    }
    if (op.equalTo("claim-all")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: ClaimAll { queryId: arg2 as uint64, roundId: arg1 as uint8 } }));
        println("claim-all sent round={}", arg1);
        return;
    }
    if (op.equalTo("claim-unlocked")) {
        net.send(signer.address, createMessage({ bounce: true, value: ton("0.2"), dest: rc, body: ClaimUnlocked { queryId: arg1 as uint64 } }));
        println("claim-unlocked sent");
        return;
    }
    throw 400;
}
