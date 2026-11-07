// Regression tests for the v11 external audit (docs/36_V11_SECURITY_AUDIT_REPORT.md), one per finding.
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@contracts/constants"
import "@contracts/types"
import "@contracts/junxiang"
import "@contracts/ticket"
import "helpers"

fun tonOf(a: address): coins {
    return testing.getAccountState(a)!.storage.balance.grams;
}

struct Dx {
    env: Env
    dist: address
}

// Distributor deployed with only `deployTon` of its own TON (A9-V11-01 drain scenario).
fun deployDistWith(deployTon: coins): Dx {
    val env = setup();
    val st = DistributorStorage {
        publisher: env.keeper,
        jettonMaster: env.master,
        codes: DistributorCodes { jettonWalletCode: build("JettonWallet"), recordCode: build("ClaimRecord") }.toCell(),
        root: 0 as uint256,
        listId: 0,
        totalPaidRaw: 0,
    };
    val init = ContractState { code: build("JunxiangDistributor"), data: st.toCell() };
    val dist = AutoDeployAddress { stateInit: init }.calculateAddress();
    val deployer = testing.treasury("ax-deployer");
    expect(net.send(deployer.address, createMessage({ bounce: false, value: deployTon, dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: dist });
    transfer(env.treasury, env.treasuryWallet, dist, MIN_STAKE * 1000, 0, emptyPayload(), ton("0.2"));
    return { env, dist };
}

fun claimX(d: Dx, from: address, cumulative: coins, proof: cell?): SendResultList {
    return net.send(from, createMessage({ bounce: true, value: ton("0.2"), dest: d.dist, body: ClaimJunxiang { queryId: 7, cumulativeRaw: cumulative as uint128, proof } }));
}

// two-leaf tree: root = hashPair(a, b); the proof of one leaf is the other leaf
fun root2(a: uint256, b: uint256): uint256 { return hashPair(a, b); }
fun proof1(h: uint256): cell { return beginCell().storeUint(h, 256).endCell(); }

// A9-V11-01: a distributor with almost no TON of its own still pays claims; the claimant pays
// the event fee, so the distributor's balance does not go down.
get fun `test audit 01 claims are paid by the claimant even when the distributor holds almost no TON`() {
    val d = deployDistWith(ton("0.02"));
    val alice = testing.treasury("alice").address;
    val bob = testing.treasury("bob").address;
    val la = junxiangLeaf(alice, (MIN_STAKE * 2) as uint128);
    val lb = junxiangLeaf(bob, (MIN_STAKE * 3) as uint128);
    net.send(d.env.keeper, createMessage({ bounce: true, value: ton("0.1"), dest: d.dist, body: SetRoot { queryId: 1, listId: 1, root: root2(la, lb) } }));
    val before = tonOf(d.dist);
    expect(claimX(d, alice, MIN_STAKE * 2, proof1(lb))).toHaveSuccessfulTx<RecordPay>({ to: d.dist });
    expect(claimX(d, bob, MIN_STAKE * 3, proof1(la))).toHaveSuccessfulTx<RecordPay>({ to: d.dist });
    expect(balanceOf(d.env, alice)).toEqual(MIN_STAKE * 2);
    expect(balanceOf(d.env, bob)).toEqual(MIN_STAKE * 3);
    expect(tonOf(d.dist) >= before).toEqual(true);
}

// A9-V11-01: an accepted deposit and an instant refund do not spend the RC's own TON.
get fun `test audit 01 deposits and refunds do not spend the RC balance`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE * 3);
    val before = tonOf(env.rc);
    expect(stake(env, alice, 1, MIN_STAKE)).toHaveSuccessfulTx<TicketAddStake>({ to: ticketOf(env, alice, 1) });
    stake(env, alice, 1, MIN_STAKE - 1); // below minimum -> instant refund
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE * 2);
    expect(tonOf(env.rc) >= before).toEqual(true);
}

// A9-V11-01: dust notifications (kept deposits) cannot drain the RC through event fees.
get fun `test audit 01 guard: a kept dust deposit is accepted without errors and RC TON does not drop`() {
    val env = setup();
    openNext(env, 0);
    val bob = user(env, "bob", MIN_STAKE);
    val before = tonOf(env.rc);
    stakeRaw(env, bob, MIN_STAKE, stakePayload(1, 1, 1), 1); // 1 nanoton forward: kept, not logged
    expect(tonOf(env.rc) >= before).toEqual(true);
}

// A9-V11-03: a duplicate claim returns the claimant's TON instead of leaving it in the record.
get fun `test audit 03 a duplicate claim refunds the TON to the claimant`() {
    val d = deployDistWith(ton("1"));
    val alice = testing.treasury("alice").address;
    val bob = testing.treasury("bob").address;
    val la = junxiangLeaf(alice, (MIN_STAKE * 2) as uint128);
    val lb = junxiangLeaf(bob, (MIN_STAKE * 3) as uint128);
    net.send(d.env.keeper, createMessage({ bounce: true, value: ton("0.1"), dest: d.dist, body: SetRoot { queryId: 1, listId: 1, root: root2(la, lb) } }));
    claimX(d, alice, MIN_STAKE * 2, proof1(lb));
    val record = net.runGetMethod<address>(d.dist, "get_record_address", [alice]);
    claimX(d, alice, MIN_STAKE * 2, proof1(lb)); // nothing new
    expect(balanceOf(d.env, alice)).toEqual(MIN_STAKE * 2);
    expect(tonOf(record) <= ton("0.011")).toEqual(true);
}

// A9-V11-07: proof cells must be canonical (whole hashes, at most one ref).
get fun `test audit 07 a proof with trailing bits is rejected`() {
    val d = deployDistWith(ton("1"));
    val alice = testing.treasury("alice").address;
    val bob = testing.treasury("bob").address;
    val la = junxiangLeaf(alice, (MIN_STAKE * 2) as uint128);
    val lb = junxiangLeaf(bob, (MIN_STAKE * 3) as uint128);
    net.send(d.env.keeper, createMessage({ bounce: true, value: ton("0.1"), dest: d.dist, body: SetRoot { queryId: 1, listId: 1, root: root2(la, lb) } }));
    val padded = beginCell().storeUint(lb, 256).storeUint(1, 7).endCell();
    expect(claimX(d, alice, MIN_STAKE * 2, padded)).toHaveFailedTx<ClaimJunxiang>({ to: d.dist, exitCode: Errors.BadProof });
    expect(claimX(d, alice, MIN_STAKE * 2, proof1(lb))).toHaveSuccessfulTx<RecordPay>({ to: d.dist });
}

// A9-V11-08: an anycast beneficiary is malformed -> refunded, not stuck.
get fun `test audit 08 an anycast beneficiary is refunded`() {
    val env = setup();
    openNext(env, 0);
    val bob = user(env, "bob", MIN_STAKE);
    val inner = beginCell()
        .storeUint(OP_STAKE_DEPOSIT, 32).storeUint(2, 8).storeUint(1, 8).storeUint(1, 16).storeUint(1, 8)
        .storeUint(5, 3)            // addr_std (10) with anycast = 1
        .storeUint(0, 8).storeUint(4242, 256)
        .endCell();
    stakeRaw(env, bob, MIN_STAKE, beginCell().storeUint(1, 1).storeRef(inner).toSlice(), ton("0.15"));
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE);
}

// A9-V11-09: a technical abort must carry gas.
get fun `test audit 09 a technical abort without gas is rejected`() {
    val env = setup();
    openNext(env, 0);
    val rd = round(env, 1);
    advanceTo(rd.observationEnd + (ABORT_TIMEOUT as uint64));
    val alice = testing.treasury("alice").address;
    val cheap = createMessage({ bounce: true, value: ton("0.05"), dest: env.rc, body: AbortTechnical { queryId: 1 } });
    expect(net.send(alice, cheap)).toHaveFailedTx<AbortTechnical>({ to: env.rc, exitCode: Errors.NotEnoughValue });
    val ok = createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: AbortTechnical { queryId: 1 } });
    expect(net.send(alice, ok)).toHaveSuccessfulTx<AbortTechnical>({ to: env.rc });
}
