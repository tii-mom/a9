// REAL Jetton integration tests for the P0 ReturnExcessesBack sender fix.
// Uses the real JettonMaster + JettonWallet (no MockJettonWallet).
import "@stdlib/strings"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/jetton/storage"
import "@contracts/jetton/jetton-utils"
import "@contracts/constants"
import "@contracts/types"
import "test-utils"

// Local copy of the TEP-74 mint message (jetton/messages.tolk duplicates symbols
// already defined in @contracts/types).
struct (0x00000015) MintOnce {
    queryId: uint64
    recipient: address
    tonAmount: coins
    jettonAmount: coins
    totalTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

const SUPPLY: coins = 10000000000000000000; // 100e9 A9 raw
const STAKE_AMOUNT: coins = 100000000000000; // 100,000 A9

struct RealSetup {
    master: address
    code: cell
    rc: RoundControllerHandle
    tv: TeamVaultHandle
    admin: address
    teamWallet: address
    user: address
    rcWallet: address
    tvWallet: address
    teamWalletWallet: address
    userWallet: address
    adminWallet: address
}

fun claimQ(roundId: uint8, kind: uint8, counter: uint64): uint64 {
    return ((roundId as uint64) << 32) | ((kind as uint64) << 24) | counter;
}

fun hasPendingClaim(rc: RoundControllerHandle, queryId: uint64): bool {
    return net.runGetMethod<bool>(rc.address, "has_pending_claim", [queryId]);
}

fun emptyPayload(): slice {
    return beginCell().storeUint(0, 1).toSlice();
}

fun deployRealMaster(admin: address): address {
    val deployer = testing.treasury("real-jetton-deployer");
    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), "https://a9.lat/a9.json".prefixWith00());
    val storage = MasterStorage {
        totalSupply: 0,
        adminAddress: admin,
        nextAdminAddress: null,
        metadata: metadata.toCell(),
    };
    val init = ContractState { code: build("JettonMaster"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    val res = net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("5"),
        dest: { stateInit: init },
        body: TopUpTons {},
    }));
    expect(res).toHaveSuccessfulDeploy({ to: addr });
    return addr;
}

fun walletOf(master: address, owner: address): address {
    return net.runGetMethod<address>(master, "get_wallet_address", [owner]);
}

fun mintTo(master: address, admin: address): SendResultList {
    return net.send(admin, createMessage({
        bounce: true,
        value: ton("1"),
        dest: master,
        body: MintOnce {
            queryId: 1,
            recipient: admin,
            tonAmount: ton("0.3"),
            jettonAmount: SUPPLY,
            totalTonAmount: ton("0.5"),
            forwardPayload: emptyPayload(),
        },
    }));
}

fun askTransfer(
    owner: address,
    wallet: address,
    recipient: address,
    amount: coins,
    forwardTon: coins,
    payload: slice,
    value: coins,
): SendResultList {
    return net.send(owner, createMessage({
        bounce: true,
        value,
        dest: wallet,
        body: AskToTransfer {
            queryId: 1,
            jettonAmount: amount,
            transferRecipient: recipient,
            sendExcessesTo: null,
            customPayload: null,
            forwardTonAmount: forwardTon,
            forwardPayload: payload,
        },
    }));
}

fun setupReal(): RealSetup {
    testing.setNow(1000000);
    val admin = testing.treasury("real-admin");
    val teamWallet = testing.treasury("real-team");
    val user = testing.treasury("real-user");
    val code = build("JettonWallet");
    val master = deployRealMaster(admin.address);
    expect(mintTo(master, admin.address)).toHaveSuccessfulTx<MintOnce>({ from: admin.address, to: master });

    val tv = deployTeamVault(admin.address, teamWallet.address, master);
    val rc = deployRoundController(admin.address, admin.address, master, tv.address);
    val rcWallet = calcAddressOfJettonWallet(rc.address, master, code);
    val tvWallet = calcAddressOfJettonWallet(tv.address, master, code);
    val teamWalletWallet = calcAddressOfJettonWallet(teamWallet.address, master, code);
    val userWallet = calcAddressOfJettonWallet(user.address, master, code);
    val adminWallet = walletOf(master, admin.address);

    expect(setTeamVaultWallet(tv, admin.address, tvWallet)).toHaveSuccessfulTx<SetJettonWallet>({ from: admin.address, to: tv.address });
    expect(setTeamWalletJettonWallet(tv, admin.address, teamWalletWallet)).toHaveSuccessfulTx<SetTeamWalletJettonWallet>({ from: admin.address, to: tv.address });
    expect(sendInitController(tv, admin.address, rc.address)).toHaveSuccessfulTx<InitController>({ from: admin.address, to: tv.address });
    expect(setRcWallet(rc, admin.address, rcWallet)).toHaveSuccessfulTx<SetJettonWallet>({ from: admin.address, to: rc.address });
    expect(setRcWalletCode(rc, admin.address, code)).toHaveSuccessfulTx<SetJettonWalletCode>({ from: admin.address, to: rc.address });

    // fund RC (7e9 A9 raw), TV (1.2e9) and the user
    expect(askTransfer(admin.address, adminWallet, rc.address, 7000000000000000000, 0, emptyPayload(), ton("1")))
        .toHaveSuccessfulTx<AskToTransfer>({ from: admin.address, to: adminWallet });
    expect(askTransfer(admin.address, adminWallet, tv.address, 1200000000000000000, 0, emptyPayload(), ton("1")))
        .toHaveSuccessfulTx<AskToTransfer>({ from: admin.address, to: adminWallet });
    expect(askTransfer(admin.address, adminWallet, user.address, 5000000000000000, 0, emptyPayload(), ton("1")))
        .toHaveSuccessfulTx<AskToTransfer>({ from: admin.address, to: adminWallet });

    net.registerAddress(master, "REAL-Master");
    net.registerAddress(rc.address, "REAL-RC");
    net.registerAddress(tv.address, "REAL-TV");
    net.registerAddress(rcWallet, "REAL-RC-Wallet");
    net.registerAddress(tvWallet, "REAL-TV-Wallet");
    net.registerAddress(adminWallet, "REAL-Admin-Wallet");
    net.registerAddress(userWallet, "REAL-User-Wallet");
    net.registerAddress(teamWalletWallet, "REAL-Team-Wallet");
    net.registerAddress(admin.address, "REAL-Admin");
    net.registerAddress(teamWallet.address, "REAL-TeamTreasury");
    net.registerAddress(user.address, "REAL-User");
    return {
        master,
        code,
        rc,
        tv,
        admin: admin.address,
        teamWallet: teamWallet.address,
        user: user.address,
        rcWallet,
        tvWallet,
        teamWalletWallet,
        userWallet,
        adminWallet,
    };
}

fun stakeReal(r: RealSetup, roundId: uint8, nonce: uint64): SendResultList {
    val risk = rcConfig(r.rc).riskDisclosureVersion;
    return askTransfer(
        r.user,
        r.userWallet,
        r.rc.address,
        STAKE_AMOUNT,
        ton("0.2"),
        beginCell().storeUint(1, 1).storeRef(buildStakePayload(roundId, nonce, risk, 1)).toSlice(),
        ton("0.8"),
    );
}

fun topUp(admin: address, addr: address, value: coins) {
    net.send(admin, createMessage({ bounce: false, value, dest: addr, body: TopUpTons {} }));
}

fun currentRound(r: RealSetup): uint8 {
    return net.runGetMethod<uint8>(r.rc.address, "get_current_round");
}

fun openRoundReal(r: RealSetup, twap: uint128) {
    if (currentRound(r) > 0) {
        advance((PREVIEW_SECONDS as int) + 1);
    }
    expect(openRound(r.rc, r.admin, twap)).toHaveSuccessfulTx<OpenRound>({ from: r.admin, to: r.rc.address });
}

fun finishSuccessReal(r: RealSetup, roundId: uint8) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(r.rc, r.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: r.admin, to: r.rc.address });
    expect(startObservation(r.rc, r.admin, roundId)).toHaveSuccessfulTx<StartObservation>({ from: r.admin, to: r.rc.address });
    submitAllCandles(r.rc, r.admin, roundId, 16, rcRound(r.rc, roundId).targetPriceUsdE8);
    expect(rcStatus(r.rc, roundId)).toEqual(STATUS_SETTLING_SUCCESS);
    // the team release acknowledgement must have arrived through real wallets
    expect(rcRound(r.rc, roundId).teamReleaseConfirmed).toBeTrue();
    expect(finalizeRound(r.rc, r.admin, roundId)).toHaveSuccessfulTx<FinalizeRound>({ from: r.admin, to: r.rc.address });
}

// ===========================================================================
// P0: real successful round + real ReturnExcessesBack for RC/TV
// ===========================================================================

get fun `test REAL jetton: success round release ack + principal/early claims settle pending`() {
    val r = setupReal();
    expect(openRound(r.rc, r.admin, 300000)).toHaveSuccessfulTx<OpenRound>({ from: r.admin, to: r.rc.address });
    val stakeRes = stakeReal(r, 1, 1);
    expect(stakeRes).toHaveSuccessfulTx<AskToTransfer>({ from: r.user, to: r.userWallet });
    expect(stakeRes).toHaveSuccessfulTx<TransferNotification>({ from: r.rcWallet, to: r.rc.address });
    expect(rcRound(r.rc, 1).totalAcceptedStakeRaw).toEqual(STAKE_AMOUNT as uint128);

    finishSuccessReal(r, 1);
    expect(rcStatus(r.rc, 1)).toEqual(STATUS_SUCCEEDED);

    // ClaimPrincipal: real RC wallet -> user wallet, user wallet returns excesses
    val principal = net.send(r.user, createMessage({
        bounce: true,
        value: ton("0.5"),
        dest: r.rc.address,
        body: ClaimPrincipal { queryId: 0, roundId: 1 },
    }));
    expect(principal).toHaveSuccessfulTx<ClaimPrincipal>({ from: r.user, to: r.rc.address });
    expect(rcUserStake(r.rc, 1, r.user).principalClaimed).toBeTrue();
    val q1 = claimQ(1, CLAIM_KIND_PRINCIPAL, 0);
    expect(hasPendingClaim(r.rc, q1)).toBeFalse();

    // ClaimRewardEarly: same real two-hop return path, pending must clear
    val early = net.send(r.user, createMessage({
        bounce: true,
        value: ton("0.5"),
        dest: r.rc.address,
        body: ClaimRewardEarly { queryId: 0, roundId: 1 },
    }));
    expect(early).toHaveSuccessfulTx<ClaimRewardEarly>({ from: r.user, to: r.rc.address });
    expect(rcRewardState(r.rc, r.user, 1).state).toEqual(REWARD_STATE_EARLY);
    val q2 = claimQ(1, CLAIM_KIND_REWARD, 1);
    expect(hasPendingClaim(r.rc, q2)).toBeFalse();
}


// ===========================================================================
// P0: real failure round -> three burns confirmed by real master/TV
// ===========================================================================

get fun `test REAL jetton: failed round burns confirm via real master and TV`() {
    val r = setupReal();
    openRoundReal(r, 300000);
    expect(stakeReal(r, 1, 1)).toHaveSuccessfulTx<AskToTransfer>({ from: r.user, to: r.userWallet });

    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(r.rc, r.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: r.admin, to: r.rc.address });
    expect(startObservation(r.rc, r.admin, 1)).toHaveSuccessfulTx<StartObservation>({ from: r.admin, to: r.rc.address });
    submitAllCandles(r.rc, r.admin, 1, 15, rcRound(r.rc, 1).targetPriceUsdE8);

    expect(rcStatus(r.rc, 1)).toEqual(STATUS_SETTLING_FAILURE);
    // real ReturnExcessesBack from the real master/TV wallet must confirm all three burns
    val burn = burnStatus(r.rc, 1);
    expect(burn.rewardBurnConfirmed).toBeTrue();
    expect(burn.principalBurnConfirmed).toBeTrue();
    expect(burn.teamBurnConfirmed).toBeTrue();
    expect(finalizeRound(r.rc, r.admin, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: r.admin, to: r.rc.address });
    expect(rcStatus(r.rc, 1)).toEqual(STATUS_FAILED_PERMANENT);
}

// ===========================================================================
// P0: real 10 rounds -> ClaimUnlocked settles through real wallet return
// ===========================================================================

get fun `test REAL jetton: ClaimUnlocked after 10 rounds settles pending`() {
    val r = setupReal();
    var roundId: uint8 = 1;
    while (roundId <= 10) {
        openRoundReal(r, 300000);
        expect(stakeReal(r, roundId, roundId as uint64)).toHaveSuccessfulTx<AskToTransfer>({ from: r.user, to: r.userWallet });
        finishSuccessReal(r, roundId);
        roundId += 1;
    }
    expect(rcStatus(r.rc, 10)).toEqual(STATUS_SUCCEEDED);
    expect(rcUnlockInfo(r.rc, r.user).totalLockedRaw > 0).toBeTrue();

    topUp(r.admin, r.rc.address, ton("5"));
    topUp(r.admin, r.userWallet, ton("3"));
    advance(2592000); // one month -> 1/12 vested
    val counter = net.runGetMethod<uint64>(r.rc.address, "get_claim_counter");
    val q = claimQ(10, CLAIM_KIND_UNLOCK, counter);
    val res = net.send(r.user, createMessage({
        bounce: true,
        value: ton("0.5"),
        dest: r.rc.address,
        body: ClaimUnlocked { queryId: 0 },
    }));
    expect(res).toHaveSuccessfulTx<ClaimUnlocked>({ from: r.user, to: r.rc.address });
    expect(hasPendingClaim(r.rc, q)).toBeFalse();
    expect(rcUnlockInfo(r.rc, r.user).claimedRaw > 0).toBeTrue();
}
