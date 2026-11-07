// 军饷 JunxiangDistributor + ClaimRecord: cumulative merkle claims (real Jetton).
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@contracts/constants"
import "@contracts/types"
import "@contracts/junxiang"
import "helpers"

struct Dist {
    env: Env
    dist: address
    distWallet: address
}

fun deployDist(): Dist {
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
    val deployer = testing.treasury("jx-deployer");
    expect(net.send(deployer.address, createMessage({ bounce: false, value: ton("2"), dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: dist });
    transfer(env.treasury, env.treasuryWallet, dist, MIN_STAKE * 1000, 0, emptyPayload(), ton("0.2"));
    return { env, dist, distWallet: walletOf(env.master, dist) };
}

fun setRoot(d: Dist, from: address, listId: uint32, root: uint256): SendResultList {
    return net.send(from, createMessage({ bounce: true, value: ton("0.1"), dest: d.dist, body: SetRoot { queryId: 1, listId, root } }));
}

fun proofCell(hashes: array<uint256>): cell? {
    if (hashes.size() == 0) {
        return null;
    }
    var b = beginCell();
    var i = 0;
    while (i < hashes.size()) {
        b = b.storeUint(hashes.get(i), 256);
        i += 1;
    }
    return b.endCell(); // <= 3 hashes fit in one cell
}

fun claimJx(d: Dist, from: address, cumulative: coins, proof: cell?): SendResultList {
    return net.send(from, createMessage({ bounce: true, value: ton("0.2"), dest: d.dist, body: ClaimJunxiang { queryId: 7, cumulativeRaw: cumulative as uint128, proof } }));
}

// 3-leaf tree per the off-chain spec: sort leaves, pair the first two, promote the odd one.
struct Tree3 {
    root: uint256
    a: uint256
    b: uint256
    c: uint256
}

fun tree3(x: uint256, y: uint256, z: uint256): Tree3 {
    var a = x; var b = y; var c = z;
    if (a > b) { val t = a; a = b; b = t; }
    if (b > c) { val t = b; b = c; c = t; }
    if (a > b) { val t = a; a = b; b = t; }
    return { root: hashPair(hashPair(a, b), c), a, b, c };
}

fun proofFor(t: Tree3, leaf: uint256): array<uint256> {
    if (leaf == t.a) { return [t.b, t.c]; }
    if (leaf == t.b) { return [t.a, t.c]; }
    return [hashPair(t.a, t.b)];
}

get fun `test only the publisher sets roots, with increasing list ids`() {
    val d = deployDist();
    val alice = testing.treasury("alice").address;
    expect(setRoot(d, alice, 1, 123)).toHaveFailedTx<SetRoot>({ to: d.dist, exitCode: Errors.NotKeeper });
    expect(setRoot(d, d.env.keeper, 1, 123)).toHaveSuccessfulTx<SetRoot>({ to: d.dist });
    expect(setRoot(d, d.env.keeper, 1, 456)).toHaveFailedTx<SetRoot>({ to: d.dist, exitCode: Errors.BadRoundId });
    expect(net.runGetMethod<DistributorView>(d.dist, "get_distributor").root).toEqual(123);
}

get fun `test cumulative claims pay only the increase, once`() {
    val d = deployDist();
    val alice = testing.treasury("alice").address;
    val bob = testing.treasury("bob").address;
    val carol = testing.treasury("carol").address;
    val la = junxiangLeaf(alice, (MIN_STAKE * 10) as uint128);
    val lb = junxiangLeaf(bob, (MIN_STAKE * 3) as uint128);
    val lc = junxiangLeaf(carol, (MIN_STAKE * 5) as uint128);
    val t = tree3(la, lb, lc);
    setRoot(d, d.env.keeper, 1, t.root);

    expect(claimJx(d, alice, MIN_STAKE * 10, proofCell(proofFor(t, la)))).toHaveSuccessfulTx<RecordPay>({ to: d.dist });
    expect(balanceOf(d.env, alice)).toEqual(MIN_STAKE * 10);
    expect(claimJx(d, carol, MIN_STAKE * 5, proofCell(proofFor(t, lc)))).toHaveSuccessfulTx<RecordPay>({ to: d.dist });
    expect(balanceOf(d.env, carol)).toEqual(MIN_STAKE * 5);
    // replay: the record refuses, nothing is paid
    claimJx(d, alice, MIN_STAKE * 10, proofCell(proofFor(t, la)));
    expect(balanceOf(d.env, alice)).toEqual(MIN_STAKE * 10);

    // next week: alice's lifetime total grows to 14 -> pays 4 more
    val la2 = junxiangLeaf(alice, (MIN_STAKE * 14) as uint128);
    val t2 = tree3(la2, lb, lc);
    setRoot(d, d.env.keeper, 2, t2.root);
    expect(claimJx(d, alice, MIN_STAKE * 14, proofCell(proofFor(t2, la2)))).toHaveSuccessfulTx<RecordPay>({ to: d.dist });
    expect(balanceOf(d.env, alice)).toEqual(MIN_STAKE * 14);
    // the old root is no longer valid
    expect(claimJx(d, bob, MIN_STAKE * 3, proofCell(proofFor(t, lb)))).toHaveFailedTx<ClaimJunxiang>({ to: d.dist, exitCode: Errors.NothingToClaim });
    expect(claimJx(d, bob, MIN_STAKE * 3, proofCell(proofFor(t2, lb)))).toHaveSuccessfulTx<RecordPay>({ to: d.dist });
    expect(net.runGetMethod<DistributorView>(d.dist, "get_distributor").totalPaidRaw).toEqual((MIN_STAKE * 22) as uint128);
}

get fun `test wrong amount, wrong sender or stale proof is rejected`() {
    val d = deployDist();
    val alice = testing.treasury("alice").address;
    val bob = testing.treasury("bob").address;
    val carol = testing.treasury("carol").address;
    val la = junxiangLeaf(alice, (MIN_STAKE * 10) as uint128);
    val lb = junxiangLeaf(bob, (MIN_STAKE * 3) as uint128);
    val lc = junxiangLeaf(carol, (MIN_STAKE * 5) as uint128);
    val t = tree3(la, lb, lc);
    setRoot(d, d.env.keeper, 1, t.root);
    expect(claimJx(d, alice, MIN_STAKE * 11, proofCell(proofFor(t, la)))).toHaveFailedTx<ClaimJunxiang>({ to: d.dist, exitCode: Errors.NothingToClaim });
    expect(claimJx(d, bob, MIN_STAKE * 10, proofCell(proofFor(t, la)))).toHaveFailedTx<ClaimJunxiang>({ to: d.dist, exitCode: Errors.NothingToClaim });
    val cheap = createMessage({ bounce: true, value: ton("0.05"), dest: d.dist, body: ClaimJunxiang { queryId: 1, cumulativeRaw: (MIN_STAKE * 10) as uint128, proof: proofCell(proofFor(t, la)) } });
    expect(net.send(alice, cheap)).toHaveFailedTx<ClaimJunxiang>({ to: d.dist, exitCode: Errors.NotEnoughValue });
    expect(balanceOf(d.env, alice)).toEqual(0);
}

get fun `test a forged RecordPay is rejected`() {
    val d = deployDist();
    val mallory = testing.treasury("mallory").address;
    val forged = createMessage({ bounce: true, value: ton("0.2"), dest: d.dist, body: RecordPay { queryId: 1, owner: mallory, amountRaw: (MIN_STAKE * 100) as uint128, cumulativeRaw: (MIN_STAKE * 100) as uint128 } });
    expect(net.send(mallory, forged)).toHaveFailedTx<RecordPay>({ to: d.dist, exitCode: Errors.NotTicket });
    expect(balanceOf(d.env, mallory)).toEqual(0);
}
