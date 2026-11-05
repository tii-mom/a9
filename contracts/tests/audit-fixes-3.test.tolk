// Audit fixes F-07..F-09 regression tests (task-25).
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/testing/assert"
import "@acton/tlb/either"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT: coins = 100000000000000;
const REWARD_RAW: uint128 = 700000000000000000;

fun openF(f: ProtocolFixture) {
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
}
fun stakeAccount(f: ProtocolFixture, roundId: uint8, owner: address, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, AMOUNT, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
}
fun finishSuccess(f: ProtocolFixture, roundId: uint8) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, roundId, 16, rcRound(f.rc, roundId).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });
}
fun rewardEstimate(f: ProtocolFixture, roundId: uint8, owner: address): uint128 {
    return net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [roundId, owner]);
}

// ============================== F-07 ==============================

get fun `test F-07 reward state keeps full amount after roll`() {
    val f = setupProtocol();
    val alice = testing.treasury("f07-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);
    val full = rewardEstimate(f, 1, alice.address);
    expect(full).toEqual(REWARD_RAW);
    advance((PREVIEW_SECONDS as int) + 1);
    openF(f);
    expect(rollReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<RollReward>({ from: alice.address, to: f.rc.address });

    val st = rcRewardState(f.rc, alice.address, 1);
    expect(st.state).toEqual(REWARD_STATE_ROLLED);
    expect(st.amountRaw).toEqual(full);       // F-07: no longer 0 after roll
    expect(st.rollableRaw).toEqual(0 as uint128);
    expect(st.earlyAmountRaw).toEqual(full / 2);
}

get fun `test F-07 reward state keeps full amount after early claim`() {
    val f = setupProtocol();
    val alice = testing.treasury("f07-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);
    val full = rewardEstimate(f, 1, alice.address);
    expect(claimRewardEarly(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimRewardEarly>({ from: alice.address, to: f.rc.address });

    val st = rcRewardState(f.rc, alice.address, 1);
    expect(st.state).toEqual(REWARD_STATE_EARLY);
    expect(st.amountRaw).toEqual(full);
    expect(st.rollableRaw).toEqual(0 as uint128);
    expect(st.earlyAmountRaw).toEqual(full / 2);
}

get fun `test F-07 roll referral uses unified multiplication formula`() {
    val f = setupProtocol();
    val alice = testing.treasury("f07-alice");
    val bob = testing.treasury("f07-bob");
    openF(f);
    expect(setReferrer(f.rc, bob.address, alice.address)).toHaveSuccessfulTx<SetReferrer>({ from: bob.address, to: f.rc.address });
    stakeAccount(f, 1, alice.address, 1);
    stakeAccount(f, 1, bob.address, 2);
    finishSuccess(f, 1);
    advance((PREVIEW_SECONDS as int) + 1);
    openF(f);
    expect(rollReward(f.rc, bob.address, 1)).toHaveSuccessfulTx<RollReward>({ from: bob.address, to: f.rc.address });
    expect(rollReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<RollReward>({ from: alice.address, to: f.rc.address });

    val info = rcReferral(f.rc, alice.address);
    // floor(20% * referredShare) capped by alice own rolled stake; exact integer math
    val expected = info.referredStakeThisRound * (REFERRAL_BPS as uint128) / 10000;
    expect(info.bonusThisRound).toEqual(expected);
    expect(info.bonusThisRound).toEqual(4000000000000000 as uint128);
}

// ============================== F-08 ==============================

get fun `test F-08 ClaimAll emits RewardEarly for the early-claimed round`() {
    val f = setupProtocol();
    val alice = testing.treasury("f08-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);
    val full = rewardEstimate(f, 1, alice.address);
    val res = claimAll(f.rc, alice.address, 0);
    expect(res).toHaveSuccessfulTx<ClaimAll>({ from: alice.address, to: f.rc.address });

    val ev = res.findExternalOutMessage<RewardEarly>({ from: f.rc.address });
    expect(ev).toBeNotNull();
    if (ev != null) {
        val body = match (ev!.body) {
            TlbEitherLeft => ev!.body.value,
            TlbEitherRight => { Assert.fail("expected inline external-out body"); },
        };
        expect(body.roundId).toEqual(1);
        expect(body.owner).toEqual(alice.address);
        expect(body.paidRaw).toEqual(full / 2);
        expect(body.lockedRaw).toEqual(full - full / 2);
    }
}

// ============================== F-09 ==============================

get fun `test F-09 empty SetReferrer is rejected and leaves no binding`() {
    val f = setupProtocol();
    val bob = testing.treasury("f09-bob");
    // addr_none cannot be represented by the typed address field, so send the
    // raw body: it must be rejected before the handler can write a binding.
    val body = beginCell().storeUint(OP_SET_REFERRER, 32).storeUint(0, 2).endCell();
    val res = net.send(bob.address, createMessage({ bounce: true, value: ton("0.2"), dest: f.rc.address, body }));
    expect(res).toHaveFailedTx<SetReferrer>({ from: bob.address, to: f.rc.address, exitCode: 9 });
    expect(rcReferral(f.rc, bob.address).referrer).toBeNull();
}

get fun `test F-09 empty RC SetJettonWallet is rejected`() {
    val f = setupProtocol();
    val before = rcConfig(f.rc).stakingJettonWallet;
    val body = beginCell().storeUint(OP_SET_JETTON_WALLET, 32).storeUint(0, 2).endCell();
    val res = net.send(f.admin, createMessage({ bounce: true, value: ton("0.2"), dest: f.rc.address, body }));
    expect(res).toHaveFailedTx<SetJettonWallet>({ from: f.admin, to: f.rc.address, exitCode: 9 });
    expect(rcConfig(f.rc).stakingJettonWallet).toEqual(before);
    expect(rcConfig(f.rc).stakingJettonWallet != createAddressNone()).toBeTrue();
}

get fun `test F-09 empty TeamVault SetJettonWallet is rejected`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    val before = teamVaultState(f.vault).jettonWallet;
    val body = beginCell().storeUint(OP_SET_JETTON_WALLET, 32).storeUint(0, 2).endCell();
    val res = net.send(f.admin, createMessage({ bounce: true, value: ton("0.2"), dest: f.vault.address, body }));
    expect(res).toHaveFailedTx<SetJettonWallet>({ from: f.admin, to: f.vault.address, exitCode: 9 });
    expect(teamVaultState(f.vault).jettonWallet).toEqual(before);
}
