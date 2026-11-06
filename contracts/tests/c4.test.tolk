// C-4: two-hop Jetton bounce recovery (wallet -> owner notification -> rollback).
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"

import "@contracts/constants"
import "@contracts/types"
import "@contracts/jetton/storage"
import "@contracts/mocks/MockBounceOwner"
import "test-utils"

const AMOUNT: coins = 100000000000000;

fun hasPendingClaim(rc: RoundControllerHandle, queryId: uint64): bool {
    return net.runGetMethod<bool>(rc.address, "has_pending_claim", [queryId]);
}

fun claimQ(roundId: uint8, kind: uint8, counter: uint64): uint64 {
    return ((roundId as uint64) << 32) | ((kind as uint64) << 24) | counter;
}

fun sendBouncedOwnerNotice(owner: address, from: address, queryId: uint64): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: owner,
        body: TransferBounced { queryId },
    }));
}

get fun `test C-4 RC accepts wallet TransferBounced and rolls back the pending claim`() {
    val f = setupProtocol();
    val alice = testing.treasury("c4-alice");
    openRound(f.rc, f.admin, 0);
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, AMOUNT, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, 1, 16, rcRound(f.rc, 1).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });

    setMockAutoAck(f.rcWallet, false);
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({ from: alice.address, to: f.rc.address });
    val q = claimQ(1, CLAIM_KIND_PRINCIPAL, 0);
    expect(hasPendingClaim(f.rc, q)).toBeTrue();
    expect(sendBouncedOwnerNotice(f.rc.address, f.rcWallet.address, q)).toHaveSuccessfulTx<TransferBounced>({
        from: f.rcWallet.address,
        to: f.rc.address,
    });
    expect(hasPendingClaim(f.rc, q)).toBeFalse();
    expect(rcUserStake(f.rc, 1, alice.address).principalClaimed).toBeFalse();
    // can claim again after recovery
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({ from: alice.address, to: f.rc.address });
}

get fun `test C-4 TV accepts wallet TransferBounced and clears the pending release`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    setMockAutoAck(f.wallet, false);
    expect(sendRelease(f.vault, f.rc, 1)).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    expect(teamRoundState(f.vault, 1).released).toBeFalse();
    val releaseQ: uint64 = (1 as uint64) << 16 | ((RELEASE_QUERY_TEAM as uint64) << 8);
    expect(sendBouncedOwnerNotice(f.vault.address, f.wallet.address, releaseQ)).toHaveSuccessfulTx<TransferBounced>({
        from: f.wallet.address,
        to: f.vault.address,
    });
    expect(teamRoundState(f.vault, 1).amountRaw).toEqual(0 as uint128);
    expect(teamVaultState(f.vault).totalReleasedRaw).toEqual(0 as uint128);
    // retry succeeds after recovery
    setMockAutoAck(f.wallet, true);
    expect(sendRelease(f.vault, f.rc, 1)).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    expect(teamVaultState(f.vault).totalReleasedRaw).toEqual(TEAM_ROUND_RAW);
}

get fun `test C-4 real JettonWallet notifies owner after a second-hop bounce`() {
    val deployer = testing.treasury("c4-deployer");
    val admin = testing.treasury("c4-admin");
    // mock owner
    val ownerInit = ContractState {
        code: build("MockBounceOwner"),
        data: MockBounceOwnerStorage { count: 0, lastQueryId: 0 }.toCell(),
    };
    val ownerAddr = AutoDeployAddress { stateInit: ownerInit }.calculateAddress();
    expect(net.send(deployer.address, createMessage({
        bounce: false, value: ton("1"), dest: { stateInit: ownerInit }, body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: ownerAddr });
    // real JettonWallet owned by the mock owner
    val walletStorage = WalletStorage {
        jettonBalance: 0,
        ownerAddress: ownerAddr,
        minterAddress: admin.address,
    };
    val walletInit = ContractState { code: build("JettonWallet"), data: walletStorage.toCell() };
    val walletAddr = AutoDeployAddress { stateInit: walletInit }.calculateAddress();
    expect(net.send(deployer.address, createMessage({
        bounce: false, value: ton("2"), dest: { stateInit: walletInit }, body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: walletAddr });

    // second-hop bounce simulated: bounced InternalTransferStep arriving at sender wallet
    val bounced = beginCell()
        .storeUint(0xFFFFFFFF, 32)
        .storeUint(0x178d4519, 32) // InternalTransferStep
        .storeUint(4242, 64)       // queryId
        .storeCoins(1000)          // jettonAmount
        .storeUint(0, 1)           // transferInitiator: null
        .storeUint(0, 1)           // sendExcessesTo: null
        .storeCoins(0)             // forwardTonAmount
        .storeUint(0, 1)           // forwardPayload: inline empty
        .endCell();
    val msg = createMessage({ bounce: false, value: ton("0.2"), dest: walletAddr, body: bounced }).bounced();
    net.send(admin.address, msg);
    val st = net.runGetMethod<MockBounceOwnerState>(ownerAddr, "get_state");
    expect(st.count).toEqual(1);
    expect(st.lastQueryId).toEqual(4242 as uint64);
}


// C-4 follow-up: low-TON wallet must still restore jetton balance when the
// owner notification cannot be paid (SEND_MODE_IGNORE_ERRORS), with no bounce loop.
get fun `test C-4 low-TON wallet keeps jetton rollback when owner notice fails`() {
    val deployer = testing.treasury("c4b-deployer");
    val admin = testing.treasury("c4b-admin");
    val ownerInit = ContractState {
        code: build("MockBounceOwner"),
        data: MockBounceOwnerStorage { count: 0, lastQueryId: 0 }.toCell(),
    };
    val ownerAddr = AutoDeployAddress { stateInit: ownerInit }.calculateAddress();
    expect(net.send(deployer.address, createMessage({
        bounce: false, value: ton("1"), dest: { stateInit: ownerInit }, body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: ownerAddr });

    // deliberately under-funded wallet: 0.01 TON cannot pay the 0.02 TON notice
    val walletStorage = WalletStorage {
        jettonBalance: 0,
        ownerAddress: ownerAddr,
        minterAddress: admin.address,
    };
    val walletInit = ContractState { code: build("JettonWallet"), data: walletStorage.toCell() };
    val walletAddr = AutoDeployAddress { stateInit: walletInit }.calculateAddress();
    expect(net.send(deployer.address, createMessage({
        bounce: false, value: ton("0.01"), dest: { stateInit: walletInit }, body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: walletAddr });

    val bounced = beginCell()
        .storeUint(0xFFFFFFFF, 32)
        .storeUint(0x178d4519, 32) // InternalTransferStep
        .storeUint(5150, 64)       // queryId
        .storeCoins(1000)          // jettonAmount
        .storeUint(0, 1)           // transferInitiator: null
        .storeUint(0, 1)           // sendExcessesTo: null
        .storeCoins(0)             // forwardTonAmount
        .storeUint(0, 1)           // forwardPayload: inline empty
        .endCell();
    val res = net.send(admin.address, createMessage({
        bounce: false, value: ton("0.001"), dest: walletAddr, body: bounced,
    }).bounced());
    // only the wallet transaction: the notice failed and was ignored (no owner tx, no loop)
    expect(res.size()).toEqual(1);
    val wd = net.runGetMethod<JettonWalletDataReply>(walletAddr, "get_wallet_data");
    expect(wd.jettonBalance).toEqual(1000 as coins);
    expect(net.runGetMethod<MockBounceOwnerState>(ownerAddr, "get_state").count).toEqual(0);
}


// A9-CRIT-01: forged master ReturnExcesses must not confirm an un-dispatched burn.
get fun `test CRIT-01 forged burn confirmation after bounce is rejected`() {
    val f = setupProtocol();
    val alice = testing.treasury("crit01-alice");
    openRound(f.rc, f.admin, 0);
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, AMOUNT, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, 1, 15, rcRound(f.rc, 1).targetPriceUsdE8);
    confirmTeamBurn(f, 1);
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_SETTLING_FAILURE);

    // bounce the reward burn: onBouncedMessage clears rewardBurnDispatched
    val q: uint64 = ((1 as uint64) << 16) | ((BURN_QUERY_REWARD as uint64) << 8);
    val body = beginCell().storeUint(0xFFFFFFFF, 32).storeUint(OP_JETTON_BURN, 32).storeUint(q, 64).endCell();
    val bounced = createMessage({ bounce: false, value: ton("0.1"), dest: f.rc.address, body }).bounced();
    testing.processSingleTraceStep(f.rcWallet.address, bounced);

    // forged master confirmation for the un-dispatched burn
    val forged = net.send(f.jettonMaster, createMessage({
        bounce: true, value: ton("0.1"), dest: f.rc.address,
        body: ReturnExcessesBack { queryId: q },
    }));
    expect(forged).toHaveFailedTx<ReturnExcessesBack>({
        from: f.jettonMaster, to: f.rc.address, exitCode: Errors.BadRoundStatus,
    });
    expect(burnStatus(f.rc, 1).rewardBurnConfirmed).toBeFalse();
}


// A9-HIGH-03/F4: near-zero wallet still delivers the bounce notice.
get fun `test F4 low balance wallet still delivers TransferBounced with reserve`() {
    val deployer = testing.treasury("f4-deployer");
    val admin = testing.treasury("f4-admin");
    val ownerInit = ContractState {
        code: build("MockBounceOwner"),
        data: MockBounceOwnerStorage { count: 0, lastQueryId: 0 }.toCell(),
    };
    val ownerAddr = AutoDeployAddress { stateInit: ownerInit }.calculateAddress();
    expect(net.send(deployer.address, createMessage({
        bounce: false, value: ton("1"), dest: { stateInit: ownerInit }, body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: ownerAddr });
    val walletStorage = WalletStorage {
        jettonBalance: 0,
        ownerAddress: ownerAddr,
        minterAddress: admin.address,
    };
    val walletInit = ContractState { code: build("JettonWallet"), data: walletStorage.toCell() };
    val walletAddr = AutoDeployAddress { stateInit: walletInit }.calculateAddress();
    expect(net.send(deployer.address, createMessage({
        bounce: false, value: ton("0.05"), dest: { stateInit: walletInit }, body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: walletAddr });

    val bounced = beginCell()
        .storeUint(0xFFFFFFFF, 32)
        .storeUint(0x178d4519, 32)
        .storeUint(6161, 64)
        .storeCoins(1000)
        .storeUint(0, 1)
        .storeUint(0, 1)
        .storeCoins(0)
        .storeUint(0, 1)
        .endCell();
    net.send(admin.address, createMessage({
        bounce: false, value: ton("0.2"), dest: walletAddr, body: bounced,
    }).bounced());
    val st = net.runGetMethod<MockBounceOwnerState>(ownerAddr, "get_state");
    expect(st.count).toEqual(1);
    expect(st.lastQueryId).toEqual(6161 as uint64);
    expect(testing.getAccountBalance(walletAddr) >= ton("0.015")).toBeTrue();
}
