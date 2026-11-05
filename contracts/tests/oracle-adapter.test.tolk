// OracleAdapter (mainnet M-2): 3/5 ed25519 signed submissions + forwarding tests.
import "@acton/build"
import "@acton/crypto"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/constants"
import "@contracts/types"
import "@contracts/mocks/MockOracleReceiver"
import "test-utils"

const CHAIN_ID: uint32 = 1;
const T0: uint32 = 1700000000;

struct AdapterHandle {
    address: address
}

struct ReceiverHandle {
    address: address
}

struct SigIn {
    signerIndex: uint8
    hi: uint256
    lo: uint256
}

fun newKeys(): array<KeyPair> {
    var keys: array<KeyPair> = [];
    var i = 0;
    while (i < 5) {
        keys.push(crypto.createMnemonic().toKeyPair());
        i += 1;
    }
    return keys;
}

fun signerSetView(keys: array<KeyPair>, threshold: uint8): OracleSignerKeys {
    return {
        s0: keys.get(0).publicKey as uint256,
        s1: keys.get(1).publicKey as uint256,
        s2: keys.get(2).publicKey as uint256,
        s3: keys.get(3).publicKey as uint256,
        s4: keys.get(4).publicKey as uint256,
        threshold,
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

fun deployAdapter(admin: address, chainId: uint32, keys: OracleSignerKeys): AdapterHandle {
    val cfg = OracleAdapterConfig {
        admin,
        controller: null,
        chainId,
        configVersion: 1,
        signers: packSigners(keys),
    };
    val storage = OracleAdapterStorage {
        config: cfg.toCell(),
        usedMask: [],
        lastCandle: [],
        pending: [],
    };
    val init = ContractState { code: build("OracleAdapter"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    val deployer = testing.treasury("oracle-adapter-deployer");
    val res = net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("10"),
        dest: { stateInit: init },
        body: TopUpTons {},
    }));
    expect(res).toHaveSuccessfulDeploy({ to: addr });
    return { address: addr };
}

fun deployReceiver(): ReceiverHandle {
    val storage = OracleReceiverStorage {
        openCount: 0, closeCount: 0, candleCount: 0,
        lastRoundId: 0, lastCandleIndex: 0,
        lastPeriodStart: 0, lastPeriodEnd: 0,
        lastTwap: 0, lastDigest: 0, lastQueryId: 0,
    };
    val init = ContractState { code: build("MockOracleReceiver"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    val deployer = testing.treasury("oracle-receiver-deployer");
    expect(net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("3"),
        dest: { stateInit: init },
        body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: addr });
    return { address: addr };
}

fun setController(adapter: AdapterHandle, admin: address, controller: address): SendResultList {
    return net.send(admin, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: adapter.address,
        body: SetOracleController { controller },
    }));
}

fun signedHash(
    chainId: uint32,
    controller: address,
    action: uint8,
    roundId: uint8,
    candleIndex: uint8,
    periodStart: uint32,
    periodEnd: uint32,
    twap: uint128,
    digest: uint256,
    timestamp: uint64,
): uint256 {
    return beginCell()
        .storeUint("A9_ORACLE_ADAPTER_V1".sha256(), 256)
        .storeUint(chainId, 32)
        .storeAddress(controller)
        .storeUint(action, 8)
        .storeUint(roundId, 8)
        .storeUint(candleIndex, 8)
        .storeUint(periodStart, 32)
        .storeUint(periodEnd, 32)
        .storeUint(twap, 128)
        .storeRef(beginCell().storeUint(digest, 256).storeUint(timestamp, 64).endCell())
        .endCell()
        .hash();
}

fun signaturePart(sig: slice): SigIn {
    var s = sig;
    val hi = s.loadUint(256) as uint256;
    val lo = s.loadUint(256) as uint256;
    return { signerIndex: 0, hi, lo };
}

fun buildSigs(keys: array<KeyPair>, indices: array<uint8>, hash: uint256): cell {
    var chain: cell? = null;
    var i = indices.size();
    while (i > 0) {
        i -= 1;
        val signerIndex = indices.get(i);
        val kp = keys.get((signerIndex as int) - 1);
        val part = signaturePart(crypto.rawSign(kp.privateKey, hash));
        var b = beginCell()
            .storeUint(signerIndex, 8)
            .storeUint(part.hi, 256)
            .storeUint(part.lo, 256);
        if (chain != null) {
            b.storeRef(chain!);
        }
        chain = b.endCell();
    }
    return chain!;
}

fun signedOpenBody(
    hash: uint256, keys: array<KeyPair>, indices: array<uint8>, roundId: uint8, twap: uint128, ts: uint64,
): SubmitSignedOpenRound {
    return {
        roundId,
        twap24hUsdE8: twap,
        timestamp: ts,
        sigCount: indices.size() as uint8,
        sigs: buildSigs(keys, indices, hash),
    };
}

fun state(rcv: ReceiverHandle): OracleReceiverState {
    return net.runGetMethod<OracleReceiverState>(rcv.address, "get_state");
}

fun config(adapter: AdapterHandle): OracleConfigView {
    return net.runGetMethod<OracleConfigView>(adapter.address, "get_config");
}

// ---------------------------------------------------------------------------

get fun `test adapter config + signer set getters`() {
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val ks = signerSetView(keys, 3);
    val adapter = deployAdapter(admin.address, CHAIN_ID, ks);
    val cfg = config(adapter);
    expect(cfg.admin).toEqual(admin.address);
    expect(cfg.controller).toBeNull();
    expect(cfg.chainId).toEqual(CHAIN_ID);
    expect(cfg.configVersion).toEqual(1);
    expect(cfg.threshold).toEqual(3);
    val ss = net.runGetMethod<OracleSignerSetView>(adapter.address, "get_signer_set");
    expect(ss.s0).toEqual(ks.s0);
    expect(ss.s4).toEqual(ks.s4);
    expect(ss.threshold).toEqual(3);
}

get fun `test SetSignerSet is admin-only and version-monotonic`() {
    val admin = testing.treasury("oa-admin");
    val outsider = testing.treasury("oa-out");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val newKs = signerSetView(newKeys(), 4);
    val body = beginCell().storeUint(OP_SET_SIGNER_SET, 32)
        .storeRef(beginCell().storeUint(newKs.s0, 256).storeUint(newKs.s1, 256).storeUint(newKs.s2, 256)
            .storeUint(newKs.threshold, 8)
            .storeRef(beginCell().storeUint(newKs.s3, 256).storeUint(newKs.s4, 256).endCell())
            .endCell())
        .storeUint(newKs.threshold, 8)
        .storeUint(1 as uint32, 32)
        .storeUint(2 as uint32, 32)
        .endCell();
    expect(net.send(outsider.address, createMessage({ bounce: true, value: ton("0.2"), dest: adapter.address, body })))
        .toHaveFailedTx<SetSignerSet>({ from: outsider.address, to: adapter.address, exitCode: Errors.NotAdmin });
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.2"), dest: adapter.address, body })))
        .toHaveSuccessfulTx<SetSignerSet>({ from: admin.address, to: adapter.address });
    expect(config(adapter).configVersion).toEqual(2);
    expect(config(adapter).threshold).toEqual(4);
    // old version rejected
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.2"), dest: adapter.address, body })))
        .toHaveFailedTx<SetSignerSet>({ from: admin.address, to: adapter.address, exitCode: Errors.VersionTooOld });
}

get fun `test SetController is admin-only and one-time`() {
    val admin = testing.treasury("oa-admin");
    val outsider = testing.treasury("oa-out");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, outsider.address, receiver.address)).toHaveFailedTx<SetOracleController>({
        from: outsider.address, to: adapter.address, exitCode: Errors.NotAdmin,
    });
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    expect(config(adapter).controller).toEqual(receiver.address);
    expect(setController(adapter, admin.address, receiver.address)).toHaveFailedTx<SetOracleController>({
        from: admin.address, to: adapter.address, exitCode: Errors.AlreadyInitialized,
    });
}

fun eqArray3(): array<uint8> { return [1 as uint8, 3 as uint8, 5 as uint8]; }

get fun `test 3/5 OpenRound is verified and forwarded with exact fields`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_OPEN, 1, 0, 0, 0, 232000 as uint128, 0 as uint256, T0 as uint64);
    val res = net.send(admin.address, createMessage({
        bounce: true, value: ton("0.3"), dest: adapter.address,
        body: signedOpenBody(hash, keys, eqArray3(), 1, 232000, T0 as uint64),
    }));
    expect(res).toHaveSuccessfulTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address });
    val st = state(receiver);
    expect(st.openCount).toEqual(1);
    expect(st.lastTwap).toEqual(232000 as uint128);
    expect(st.lastQueryId).toEqual(65792 as uint64);
}

get fun `test 2/5 signatures are rejected`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_OPEN, 1, 0, 0, 0, 232000 as uint128, 0 as uint256, T0 as uint64);
    val body = signedOpenBody(hash, keys, [1 as uint8, 2 as uint8], 1, 232000, T0 as uint64);
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveFailedTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address, exitCode: Errors.NotEnoughSignatures });
    expect(state(receiver).openCount).toEqual(0);
}

get fun `test duplicate signer index is rejected`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_OPEN, 1, 0, 0, 0, 232000 as uint128, 0 as uint256, T0 as uint64);
    val body = signedOpenBody(hash, keys, [1 as uint8, 1 as uint8, 2 as uint8], 1, 232000, T0 as uint64);
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveFailedTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address, exitCode: Errors.NotEnoughSignatures });
}

get fun `test stale timestamp is rejected`() {
    testing.setNow((T0 + 301) as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_OPEN, 1, 0, 0, 0, 232000 as uint128, 0 as uint256, T0 as uint64);
    val body = signedOpenBody(hash, keys, eqArray3(), 1, 232000, T0 as uint64);
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveFailedTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address, exitCode: Errors.StaleSignature });
}

get fun `test replay of the same (round, action) is rejected`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_OPEN, 1, 0, 0, 0, 232000 as uint128, 0 as uint256, T0 as uint64);
    val res1 = net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address,
        body: signedOpenBody(hash, keys, eqArray3(), 1, 232000, T0 as uint64) }));
    expect(res1).toHaveSuccessfulTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address });
    val res2 = net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address,
        body: signedOpenBody(hash, keys, eqArray3(), 1, 232000, T0 as uint64) }));
    expect(res2).toHaveFailedTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address, exitCode: Errors.ReplayAction });
    expect(state(receiver).openCount).toEqual(1);
}

get fun `test candle index is monotonic and fields are forwarded exactly`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val start: uint32 = 1700003600;
    val end: uint32 = 1700007200;
    val digest: uint256 = 0x1234 as uint256;
    val h5 = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_CANDLE, 1, 5, start, end, 240000 as uint128, digest, T0 as uint64);
    val body5 = SubmitSignedCandle {
        roundId: 1, candleIndex: 5, periodStart: start, periodEnd: end,
        twapPriceUsdE8: 240000, dataDigest: digest, timestamp: T0 as uint64,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), h5),
    };
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body: body5 })))
        .toHaveSuccessfulTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address });
    val st = state(receiver);
    expect(st.candleCount).toEqual(1);
    expect(st.lastRoundId).toEqual(1);
    expect(st.lastCandleIndex).toEqual(5);
    expect(st.lastPeriodStart).toEqual(start);
    expect(st.lastPeriodEnd).toEqual(end);
    expect(st.lastTwap).toEqual(240000 as uint128);
    expect(st.lastDigest).toEqual(digest);

    // non-increasing index rejected
    val h4 = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_CANDLE, 1, 4, start, end, 240000 as uint128, digest, T0 as uint64);
    val body4 = SubmitSignedCandle {
        roundId: 1, candleIndex: 4, periodStart: start, periodEnd: end,
        twapPriceUsdE8: 240000, dataDigest: digest, timestamp: T0 as uint64,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), h4),
    };
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body: body4 })))
        .toHaveFailedTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address, exitCode: Errors.BadCandleOrder });
    expect(net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]).lastCandleIndex).toEqual(5);
}

get fun `test signature for a different chainId is rejected`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val wrongChainHash = signedHash(2 as uint32, receiver.address, SIGNED_ACTION_OPEN, 1, 0, 0, 0, 232000 as uint128, 0 as uint256, T0 as uint64);
    val body = signedOpenBody(wrongChainHash, keys, eqArray3(), 1, 232000, T0 as uint64);
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveFailedTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address, exitCode: Errors.NotEnoughSignatures });
}

get fun `test 3/5 CloseStaking is forwarded with exact twap`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_CLOSE, 1, 0, 0, 0, 250000 as uint128, 0 as uint256, T0 as uint64);
    val body = SubmitSignedCloseStaking {
        roundId: 1, twap1hUsdE8: 250000, timestamp: T0 as uint64,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), hash),
    };
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveSuccessfulTx<SubmitSignedCloseStaking>({ from: admin.address, to: adapter.address });
    val st = state(receiver);
    expect(st.closeCount).toEqual(1);
    expect(st.lastTwap).toEqual(250000 as uint128);
    val used = net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]);
    expect(used.openUsed).toBeFalse();
    expect(used.closeUsed).toBeTrue();
}

get fun `test SetAdmin is admin-only and changes the admin`() {
    val admin = testing.treasury("oa-admin");
    val outsider = testing.treasury("oa-out");
    val newAdmin = testing.treasury("oa-new");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val body = beginCell().storeUint(OP_SET_ORACLE_ADMIN, 32).storeAddress(newAdmin.address).endCell();
    expect(net.send(outsider.address, createMessage({ bounce: true, value: ton("0.2"), dest: adapter.address, body })))
        .toHaveFailedTx<SetOracleAdmin>({ from: outsider.address, to: adapter.address, exitCode: Errors.NotAdmin });
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.2"), dest: adapter.address, body })))
        .toHaveSuccessfulTx<SetOracleAdmin>({ from: admin.address, to: adapter.address });
    expect(config(adapter).admin).toEqual(newAdmin.address);
}


// C-2: index 0 must be accepted (no record != index 0).
get fun `test C-2 candle index 0 is accepted then monotonic`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val start: uint32 = 1700003600;
    val end: uint32 = 1700007200;
    val digest: uint256 = 0x55 as uint256;
    val h0 = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_CANDLE, 1, 0, start, end, 240000 as uint128, digest, T0 as uint64);
    val body0 = SubmitSignedCandle {
        roundId: 1, candleIndex: 0, periodStart: start, periodEnd: end,
        twapPriceUsdE8: 240000, dataDigest: digest, timestamp: T0 as uint64,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), h0),
    };
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body: body0 })))
        .toHaveSuccessfulTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address });
    expect(state(receiver).candleCount).toEqual(1);
    expect(net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]).lastCandleIndex).toEqual(0);
    // duplicate index 0 rejected
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body: body0 })))
        .toHaveFailedTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address, exitCode: Errors.BadCandleOrder });
}

// C-2 integration: signed candles forwarded to the REAL RoundController, starting at index 0.
get fun `test C-2 real RC accepts adapter candle sequence from index 0`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val rc = deployRoundController(admin.address, adapter.address, admin.address, admin.address);
    expect(setController(adapter, admin.address, rc.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val openHash = signedHash(CHAIN_ID, rc.address, SIGNED_ACTION_OPEN, 1, 0, 0, 0, 300000 as uint128, 0 as uint256, T0 as uint64);
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address,
        body: signedOpenBody(openHash, keys, eqArray3(), 1, 300000, T0 as uint64) })))
        .toHaveSuccessfulTx<SubmitSignedOpenRound>({ from: admin.address, to: adapter.address });
    expect(rcStatus(rc, 1)).toEqual(STATUS_STAKING_OPEN);

    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(rc, admin.address, 0)).toHaveSuccessfulTx<CloseStaking>({ from: admin.address, to: rc.address });
    expect(startObservation(rc, admin.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: admin.address, to: rc.address });
    val start = rcRound(rc, 1).observationStart;
    var i: uint8 = 0;
    while (i < 3) {
        val pStart: uint32 = (start + (i as uint64) * (CANDLE_SECONDS as uint64)) as uint32;
        val pEnd: uint32 = (pStart as uint64 + (CANDLE_SECONDS as uint64)) as uint32;
        testing.setNow(pEnd as int);
        val ts: uint64 = pEnd as uint64;
        val h = signedHash(CHAIN_ID, rc.address, SIGNED_ACTION_CANDLE, 1, i, pStart, pEnd, 300000 as uint128, (i as uint256) + 1, ts);
        val body = SubmitSignedCandle {
            roundId: 1, candleIndex: i, periodStart: pStart, periodEnd: pEnd,
            twapPriceUsdE8: 300000, dataDigest: (i as uint256) + 1, timestamp: ts,
            sigCount: 3, sigs: buildSigs(keys, eqArray3(), h),
        };
        expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
            .toHaveSuccessfulTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address });
        i += 1;
    }
    expect(rcRound(rc, 1).candlesSeen).toEqual(3);
}


// C-3: RC rejects forwarded action -> adapter rolls back marker -> retry succeeds.
get fun `test C-3 rejected CloseStaking rolls back and resubmits successfully`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val rc = deployRoundController(admin.address, adapter.address, admin.address, admin.address);
    expect(setController(adapter, admin.address, rc.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, rc.address, SIGNED_ACTION_CLOSE, 1, 0, 0, 0, 250000 as uint128, 0 as uint256, T0 as uint64);
    val body = SubmitSignedCloseStaking {
        roundId: 1, twap1hUsdE8: 250000, timestamp: T0 as uint64,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), hash),
    };
    // RC has no open round -> rejects; adapter must roll back closeUsed.
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveSuccessfulTx<SubmitSignedCloseStaking>({ from: admin.address, to: adapter.address });
    expect(net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]).closeUsed).toBeFalse();

    // make RC accept: open round 1 directly as admin
    expect(openRound(rc, admin.address, 100000)).toHaveSuccessfulTx<OpenRound>({ from: admin.address, to: rc.address });
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveSuccessfulTx<SubmitSignedCloseStaking>({ from: admin.address, to: adapter.address });
    expect(rcStatus(rc, 1)).toEqual(STATUS_STAKING_CLOSED);
    expect(net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]).closeUsed).toBeTrue();
}

get fun `test C-3 rejected candle rolls back lastCandle and resubmits`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val rc = deployRoundController(admin.address, adapter.address, admin.address, admin.address);
    expect(setController(adapter, admin.address, rc.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    expect(openRound(rc, admin.address, 100000)).toHaveSuccessfulTx<OpenRound>({ from: admin.address, to: rc.address });
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(rc, admin.address, 0)).toHaveSuccessfulTx<CloseStaking>({ from: admin.address, to: rc.address });
    expect(startObservation(rc, admin.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: admin.address, to: rc.address });
    val start = rcRound(rc, 1).observationStart;
    val pStart: uint32 = start as uint32;
    val pEnd: uint32 = (start + (CANDLE_SECONDS as uint64)) as uint32;
    val ts: uint64 = pEnd as uint64;
    testing.setNow((pEnd as int) - 100); // too early for RC
    val h = signedHash(CHAIN_ID, rc.address, SIGNED_ACTION_CANDLE, 1, 0, pStart, pEnd, 300000 as uint128, 0x77 as uint256, ts);
    val body = SubmitSignedCandle {
        roundId: 1, candleIndex: 0, periodStart: pStart, periodEnd: pEnd,
        twapPriceUsdE8: 300000, dataDigest: 0x77 as uint256, timestamp: ts,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), h),
    };
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveSuccessfulTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address });
    expect(net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]).lastCandleIndex).toEqual(0);
    expect(rcRound(rc, 1).candlesSeen).toEqual(0);

    testing.setNow(pEnd as int);
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveSuccessfulTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address });
    expect(rcRound(rc, 1).candlesSeen).toEqual(1);
    expect(net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]).lastCandleIndex).toEqual(0);
}


// C-2 defensive bound: index 255 would wrap index+1 back to 0.
get fun `test C-2 candle index 255 is rejected before uint8 wrap`() {
    testing.setNow(T0 as int);
    val admin = testing.treasury("oa-admin");
    val keys = newKeys();
    val adapter = deployAdapter(admin.address, CHAIN_ID, signerSetView(keys, 3));
    val receiver = deployReceiver();
    expect(setController(adapter, admin.address, receiver.address)).toHaveSuccessfulTx<SetOracleController>({
        from: admin.address, to: adapter.address,
    });
    val hash = signedHash(CHAIN_ID, receiver.address, SIGNED_ACTION_CANDLE, 1, 255, 0, 0, 300000 as uint128, 1 as uint256, T0 as uint64);
    val body = SubmitSignedCandle {
        roundId: 1, candleIndex: 255, periodStart: 0, periodEnd: 0,
        twapPriceUsdE8: 300000, dataDigest: 1 as uint256, timestamp: T0 as uint64,
        sigCount: 3, sigs: buildSigs(keys, eqArray3(), hash),
    };
    expect(net.send(admin.address, createMessage({ bounce: true, value: ton("0.3"), dest: adapter.address, body })))
        .toHaveFailedTx<SubmitSignedCandle>({ from: admin.address, to: adapter.address, exitCode: Errors.BadCandleOrder });
    expect(net.runGetMethod<OracleUsedActions>(adapter.address, "get_used_actions", [1 as uint8]).lastCandleIndex).toEqual(0);
}
