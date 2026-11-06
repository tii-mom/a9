// A9 Protocol - OracleAdapter (mainnet M-2, docs/03 / docs/04 §2.5)
//
// Forwards 3/5 ed25519-signed OpenRound / CloseStaking / SubmitCandle messages to
// the frozen RoundController. The RC only checks that the sender is the address
// configured as oracle, so this contract can be swapped in without touching RC.
//
// Signed payload hash:
//   sha256("A9_ORACLE_ADAPTER_V1" || chainId || controller ||
//          action || roundId || candleIndex || periodStart || periodEnd ||
//          twapUsdE8 || dataDigest || timestamp)

import "types"
import "constants"

const ORACLE_DOMAIN_STRING: string = "A9_ORACLE_ADAPTER_V1";

contract OracleAdapter {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "3/5 ed25519 multi-source oracle adapter forwarding signed actions to RoundController."
    storage: OracleAdapterStorage
    incomingMessages: OracleAllowedMessage
}

type OracleAllowedMessage =
    | SetSignerSet
    | SetOracleController
    | SetOracleAdmin
    | SubmitSignedOpenRound
    | SubmitSignedCloseStaking
    | SubmitSignedCandle
    | ResetRoundCandles
    | TopUpTons

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fun OracleAdapterStorage.load(): OracleAdapterStorage {
    return OracleAdapterStorage.fromCell(contract.getData());
}

fun OracleAdapterStorage.save(self) {
    contract.setData(self.toCell());
}

fun signerKeys(cfg: OracleAdapterConfig): OracleSignerKeys {
    val packed = cfg.signers.load();
    val tail = packed.tail.load();
    return {
        s0: packed.s0,
        s1: packed.s1,
        s2: packed.s2,
        s3: tail.s3,
        s4: tail.s4,
        threshold: packed.threshold,
    };
}

fun packSigners(keys: OracleSignerKeys): Cell<OracleSignersPacked> {
    return OracleSignersPacked {
        s0: keys.s0,
        s1: keys.s1,
        s2: keys.s2,
        threshold: keys.threshold,
        tail: OracleSignersTail { s3: keys.s3, s4: keys.s4 }.toCell(),
    }.toCell();
}

fun pubkeyAt(keys: OracleSignerKeys, index: uint8): uint256 {
    if (index == 1) { return keys.s0; }
    if (index == 2) { return keys.s1; }
    if (index == 3) { return keys.s2; }
    if (index == 4) { return keys.s3; }
    if (index == 5) { return keys.s4; }
    throw Errors.BadSignerIndex;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

fun signatureHash(
    chainId: uint32,
    controller: address,
    action: uint8,
    roundId: uint8,
    candleIndex: uint8,
    periodStart: uint32,
    periodEnd: uint32,
    twapUsdE8: uint128,
    dataDigest: uint256,
    timestamp: uint64,
): uint256 {
    // main cell (771 bits) + ref(tail 320 bits) keeps us under the 1023-bit limit.
    return beginCell()
        .storeUint(ORACLE_DOMAIN_STRING.sha256(), 256)
        .storeUint(chainId, 32)
        .storeAddress(controller)
        .storeUint(action, 8)
        .storeUint(roundId, 8)
        .storeUint(candleIndex, 8)
        .storeUint(periodStart, 32)
        .storeUint(periodEnd, 32)
        .storeUint(twapUsdE8, 128)
        .storeRef(beginCell()
            .storeUint(dataDigest, 256)
            .storeUint(timestamp, 64)
            .endCell())
        .endCell()
        .hash();
}

// Signatures are a chain: root cell = entry0 + ref(entry1), entryN = data + ref(next).
// Each entry is signerIndex:u8 + signatureHi:u256 + signatureLo:u256.
fun verifySignatures(hash: uint256, sigs: cell, sigCount: uint8, keys: OracleSignerKeys): uint8 {
    if (sigCount < keys.threshold || sigCount > 5) {
        return 0;
    }
    var ptr = sigs.beginParse();
    var seen: uint8 = 0;
    var valid: uint8 = 0;
    var i: uint8 = 0;
    var done: bool = false;
    while (i < sigCount && !done) {
        if (ptr.remainingBitsCount() < 520) {
            done = true;
        } else {
            val signerIndex = ptr.loadUint(8) as uint8;
            val hi = ptr.loadUint(256) as uint256;
            val lo = ptr.loadUint(256) as uint256;
            if (signerIndex >= 1 && signerIndex <= 5) {
                val bit: uint8 = (1 as uint8) << (signerIndex - 1);
                if ((seen & bit) == 0) {
                    seen = seen | bit;
                    val sig = beginCell().storeUint(hi, 256).storeUint(lo, 256).endCell().beginParse();
                    if (isSignatureValid(hash, sig, pubkeyAt(keys, signerIndex))) {
                        valid = valid + 1;
                    }
                }
            }
            i = i + 1;
            if (i < sigCount) {
                if (ptr.remainingRefsCount() == 0) {
                    done = true;
                } else {
                    ptr = ptr.loadRef().beginParse();
                }
            }
        }
    }
    return valid;
}

fun checkTimestamp(timestamp: uint64, now: uint64) {
    if (timestamp > now + (SIGNED_TIMESTAMP_WINDOW as uint64)) {
        throw Errors.StaleSignature;
    }
    if (timestamp + (SIGNED_TIMESTAMP_WINDOW as uint64) < now) {
        throw Errors.StaleSignature;
    }
}

fun requireController(cfg: OracleAdapterConfig): address {
    if (cfg.controller == null) {
        throw Errors.NotInitialized;
    }
    return cfg.controller!;
}

fun forwardQueryId(roundId: uint8, action: uint8, candleIndex: uint8): uint64 {
    return ((roundId as uint64) << 16) | ((action as uint64) << 8) | (candleIndex as uint64);
}

fun forwardTarget(target: address, body: cell) {
    val out = createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: target,
        body,
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fun onInternalMessage(in: InMessage) {
    val msg = lazy OracleAllowedMessage.fromSlice(in.body);
    match (msg) {
        SetSignerSet => {
            var st = lazy OracleAdapterStorage.load();
            var cfg = st.config.load();
            if (in.senderAddress != cfg.admin) {
                throw Errors.NotAdmin;
            }
            if (msg.configVersion <= cfg.configVersion) {
                throw Errors.VersionTooOld;
            }
            if (msg.threshold < 1 || msg.threshold > 5) {
                throw Errors.BadThreshold;
            }
            // signers cell: packed s0..s2 + threshold + ref(s3,s4)
            var packed = msg.signers.beginParse();
            val s0 = packed.loadUint(256) as uint256;
            val s1 = packed.loadUint(256) as uint256;
            val s2 = packed.loadUint(256) as uint256;
            val threshold = packed.loadUint(8) as uint8;
            var tail = packed.loadRef().beginParse();
            val s3 = tail.loadUint(256) as uint256;
            val s4 = tail.loadUint(256) as uint256;
            if (threshold != msg.threshold) {
                throw Errors.BadThreshold;
            }
            cfg.chainId = msg.chainId;
            cfg.configVersion = msg.configVersion;
            cfg.signers = packSigners(OracleSignerKeys {
                s0, s1, s2, s3, s4, threshold: msg.threshold,
            });
            st.config = cfg.toCell();
            st.save();
        }
        SetOracleController => {
            var st = lazy OracleAdapterStorage.load();
            val cfg = st.config.load();
            if (in.senderAddress != cfg.admin) {
                throw Errors.NotAdmin;
            }
            if (cfg.controller != null) {
                throw Errors.AlreadyInitialized;
            }
            if (msg.controller == createAddressNone()) {
                throw Errors.BadConfig;
            }
            var updated = cfg;
            updated.controller = msg.controller;
            st.config = updated.toCell();
            st.save();
        }
        SetOracleAdmin => {
            var st = lazy OracleAdapterStorage.load();
            val cfg = st.config.load();
            if (in.senderAddress != cfg.admin) {
                throw Errors.NotAdmin;
            }
            if (msg.admin == createAddressNone()) {
                throw Errors.BadConfig;
            }
            var updated = cfg;
            updated.admin = msg.admin;
            st.config = updated.toCell();
            st.save();
        }
        SubmitSignedOpenRound => {
            var st = lazy OracleAdapterStorage.load();
            val cfg = st.config.load();
            val controller = requireController(cfg);
            val keys = signerKeys(cfg);
            val now: uint64 = blockchain.now() as uint64;
            checkTimestamp(msg.timestamp, now);
            val hash = signatureHash(
                cfg.chainId, controller, SIGNED_ACTION_OPEN, msg.roundId,
                0, 0, 0, msg.twap24hUsdE8, 0 as uint256, msg.timestamp,
            );
            if (verifySignatures(hash, msg.sigs, msg.sigCount, keys) < keys.threshold) {
                throw Errors.NotEnoughSignatures;
            }
            val mask = st.usedMask.get(msg.roundId);
            val used: uint8 = mask.isFound ? mask.loadValue() : 0;
            if ((used & SIGNED_MASK_OPEN) != 0) {
                throw Errors.ReplayAction;
            }
            st.usedMask.set(msg.roundId, used | SIGNED_MASK_OPEN);
            val q = forwardQueryId(msg.roundId, SIGNED_ACTION_OPEN, 0);
            st.pending.set(q, OraclePendingForward {
                kind: SIGNED_ACTION_OPEN,
                prevLastPlus: 0,
                acceptedLastPlus: 0,
            });
            st.save();
            forwardTarget(controller, beginCell()
                .storeUint(OP_OPEN_ROUND, 32)
                .storeUint(q, 64)
                .storeUint(msg.twap24hUsdE8, 128)
                .endCell());
        }
        SubmitSignedCloseStaking => {
            var st = lazy OracleAdapterStorage.load();
            val cfg = st.config.load();
            val controller = requireController(cfg);
            val keys = signerKeys(cfg);
            val now: uint64 = blockchain.now() as uint64;
            checkTimestamp(msg.timestamp, now);
            val hash = signatureHash(
                cfg.chainId, controller, SIGNED_ACTION_CLOSE, msg.roundId,
                0, 0, 0, msg.twap1hUsdE8, 0 as uint256, msg.timestamp,
            );
            if (verifySignatures(hash, msg.sigs, msg.sigCount, keys) < keys.threshold) {
                throw Errors.NotEnoughSignatures;
            }
            val mask = st.usedMask.get(msg.roundId);
            val used: uint8 = mask.isFound ? mask.loadValue() : 0;
            if ((used & SIGNED_MASK_CLOSE) != 0) {
                throw Errors.ReplayAction;
            }
            st.usedMask.set(msg.roundId, used | SIGNED_MASK_CLOSE);
            val q = forwardQueryId(msg.roundId, SIGNED_ACTION_CLOSE, 0);
            st.pending.set(q, OraclePendingForward {
                kind: SIGNED_ACTION_CLOSE,
                prevLastPlus: 0,
                acceptedLastPlus: 0,
            });
            st.save();
            forwardTarget(controller, beginCell()
                .storeUint(OP_CLOSE_STAKING, 32)
                .storeUint(q, 64)
                .storeUint(msg.twap1hUsdE8, 128)
                .endCell());
        }
        SubmitSignedCandle => {
            var st = lazy OracleAdapterStorage.load();
            val cfg = st.config.load();
            val controller = requireController(cfg);
            val keys = signerKeys(cfg);
            val now: uint64 = blockchain.now() as uint64;
            checkTimestamp(msg.timestamp, now);
            val hash = signatureHash(
                cfg.chainId, controller, SIGNED_ACTION_CANDLE, msg.roundId,
                msg.candleIndex, msg.periodStart, msg.periodEnd,
                msg.twapPriceUsdE8, msg.dataDigest, msg.timestamp,
            );
            if (verifySignatures(hash, msg.sigs, msg.sigCount, keys) < keys.threshold) {
                throw Errors.NotEnoughSignatures;
            }
            // C-2 defensive bound: index+1 must not wrap uint8 (255 -> 0).
            assert (msg.candleIndex < 32) throw Errors.BadCandleOrder;
            // C-2: store index+1 so "no record" (0) is distinct from accepted index 0.
            val lastRes = st.lastCandle.get(msg.roundId);
            val lastPlus: uint8 = lastRes.isFound ? lastRes.loadValue() : 0;
            if ((msg.candleIndex as int) + 1 <= (lastPlus as int)) {
                throw Errors.BadCandleOrder;
            }
            val acceptedPlus: uint8 = (msg.candleIndex as uint8) + 1;
            st.lastCandle.set(msg.roundId, acceptedPlus);
            val mask = st.usedMask.get(msg.roundId);
            val used: uint8 = mask.isFound ? mask.loadValue() : 0;
            st.usedMask.set(msg.roundId, used | SIGNED_MASK_CANDLE);
            val q = forwardQueryId(msg.roundId, SIGNED_ACTION_CANDLE, msg.candleIndex);
            st.pending.set(q, OraclePendingForward {
                kind: SIGNED_ACTION_CANDLE,
                prevLastPlus: lastPlus,
                acceptedLastPlus: acceptedPlus,
            });
            st.save();
            forwardTarget(controller, beginCell()
                .storeUint(OP_SUBMIT_CANDLE, 32)
                .storeUint(q, 64)
                .storeUint(msg.roundId, 8)
                .storeUint(msg.candleIndex, 8)
                .storeUint(msg.periodStart, 32)
                .storeUint(msg.periodEnd, 32)
                .storeUint(msg.twapPriceUsdE8, 128)
                .storeUint(msg.dataDigest, 256)
                .endCell());
        }
        ResetRoundCandles => {
            var st = lazy OracleAdapterStorage.load();
            val cfg = st.config.load();
            val isAdmin = in.senderAddress == cfg.admin;
            val isController = cfg.controller != null && in.senderAddress == cfg.controller!;
            if (!isAdmin && !isController) {
                throw Errors.NotAdmin;
            }
            assert (msg.roundId >= 1 && msg.roundId <= MAX_ROUNDS) throw Errors.BadRoundId;
            // A9-F5: clear the per-round candle cursor and only the CANDLE pending
            // entries (key = roundId<<16 | action<<8 | candleIndex); OPEN/CLOSE stay.
            st.lastCandle.delete(msg.roundId);
            val maskRes = st.usedMask.get(msg.roundId);
            if (maskRes.isFound) {
                val mask = maskRes.loadValue();
                st.usedMask.set(msg.roundId, mask & ~SIGNED_MASK_CANDLE);
            }
            var i: uint8 = 0;
            while (i < 32) {
                val q: uint64 = ((msg.roundId as uint64) << 16) |
                    ((SIGNED_ACTION_CANDLE as uint64) << 8) | (i as uint64);
                st.pending.delete(q);
                i += 1;
            }
            st.save();
        }
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // C-3: RC rejected the forwarded action -> precisely roll back the replay
    // marker before the caller can resubmit. Forwarded messages carry queryId =
    // roundId<<16 | action<<8 | candleIndex and bounce 256 bits of the body.
    var st = lazy OracleAdapterStorage.load();
    val cfg = st.config.load();
    if (cfg.controller == null || in.senderAddress != cfg.controller!) {
        return;
    }
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 96) {
        return;
    }
    in.bouncedBody.loadUint(32); // opcode
    val q: uint64 = in.bouncedBody.loadUint(64) as uint64;
    val found = st.pending.get(q);
    if (!found.isFound) {
        return;
    }
    val p = found.loadValue();
    val roundId: uint8 = ((q >> 16) & 0xff) as uint8;
    val maskRes = st.usedMask.get(roundId);
    val mask: uint8 = maskRes.isFound ? maskRes.loadValue() : 0;
    if (p.kind == SIGNED_ACTION_OPEN) {
        st.usedMask.set(roundId, mask & ~SIGNED_ACTION_OPEN);
    } else if (p.kind == SIGNED_ACTION_CLOSE) {
        st.usedMask.set(roundId, mask & ~SIGNED_ACTION_CLOSE);
    } else if (p.kind == SIGNED_ACTION_CANDLE) {
        val lastRes = st.lastCandle.get(roundId);
        val current: uint8 = lastRes.isFound ? lastRes.loadValue() : 0;
        // A9-F5: FIFO bounce order — roll back to the minimum unconfirmed cursor.
        if (p.prevLastPlus < current) {
            st.lastCandle.set(roundId, p.prevLastPlus);
        }
    }
    st.pending.delete(q);
    st.save();
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

get fun get_config(): OracleConfigView {
    val st = lazy OracleAdapterStorage.load();
    val cfg = st.config.load();
    val keys = signerKeys(cfg);
    return {
        admin: cfg.admin,
        controller: cfg.controller,
        chainId: cfg.chainId,
        configVersion: cfg.configVersion,
        threshold: keys.threshold,
    };
}

get fun get_signer_set(): OracleSignerSetView {
    val st = lazy OracleAdapterStorage.load();
    val keys = signerKeys(st.config.load());
    return {
        s0: keys.s0,
        s1: keys.s1,
        s2: keys.s2,
        s3: keys.s3,
        s4: keys.s4,
        threshold: keys.threshold,
    };
}

get fun get_used_actions(roundId: uint8): OracleUsedActions {
    val st = lazy OracleAdapterStorage.load();
    val maskRes = st.usedMask.get(roundId);
    val mask: uint8 = maskRes.isFound ? maskRes.loadValue() : 0;
    val lastRes = st.lastCandle.get(roundId);
    return {
        openUsed: (mask & SIGNED_MASK_OPEN) != 0,
        closeUsed: (mask & SIGNED_MASK_CLOSE) != 0,
        lastCandleIndex: lastRes.isFound && lastRes.loadValue() > 0 ? lastRes.loadValue() - 1 : 0,
    };
}
