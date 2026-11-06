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
struct (0x7bdd97de) BurnNotificationForMinterLocal {
    queryId: uint64
    jettonAmount: coins
    burnInitiator: address
    sendExcessesTo: address?
}

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


// ===========================================================================
// A9-CRIT-01: ReturnExcessesBack confused-deputy prevention (real wallets)
// ===========================================================================

get fun `test CRIT-01 real wallet rejects foreign excess destination`() {
    val r = setupReal();
    val badTransfer = net.send(r.user, createMessage({
        bounce: true,
        value: ton("0.5"),
        dest: r.userWallet,
        body: AskToTransfer {
            queryId: 11,
            jettonAmount: 1000,
            transferRecipient: r.rc.address,
            sendExcessesTo: r.rc.address,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: emptyPayload(),
        },
    }));
    expect(badTransfer).toHaveFailedTx<AskToTransfer>({
        from: r.user, to: r.userWallet, exitCode: 73,
    });
    val badBurn = net.send(r.user, createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: r.userWallet,
        body: AskToBurn {
            queryId: ((1 as uint64) << 16) | ((BURN_QUERY_REWARD as uint64) << 8),
            jettonAmount: 1000,
            sendExcessesTo: r.rc.address,
            customPayload: null,
        },
    }));
    expect(badBurn).toHaveFailedTx<AskToBurn>({
        from: r.user, to: r.userWallet, exitCode: 73,
    });
    // zero amount is rejected too
    val zeroTransfer = net.send(r.user, createMessage({
        bounce: true, value: ton("0.3"), dest: r.userWallet,
        body: AskToTransfer {
            queryId: 12, jettonAmount: 0, transferRecipient: r.rc.address,
            sendExcessesTo: null, customPayload: null, forwardTonAmount: 0,
            forwardPayload: emptyPayload(),
        },
    }));
    expect(zeroTransfer).toHaveFailedTx<AskToTransfer>({
        from: r.user, to: r.userWallet, exitCode: 47,
    });
    val zeroBurn = net.send(r.user, createMessage({
        bounce: true, value: ton("0.3"), dest: r.userWallet,
        body: AskToBurn {
            queryId: 13, jettonAmount: 0, sendExcessesTo: null, customPayload: null,
        },
    }));
    expect(zeroBurn).toHaveFailedTx<AskToBurn>({
        from: r.user, to: r.userWallet, exitCode: 47,
    });
}

get fun `test CRIT-01 owner/null excess destinations still work`() {
    val r = setupReal();
    // response_destination = owner (the normal frontend body shape)
    expect(net.send(r.user, createMessage({
        bounce: true, value: ton("0.5"), dest: r.userWallet,
        body: AskToTransfer {
            queryId: 21, jettonAmount: 1000, transferRecipient: r.admin,
            sendExcessesTo: r.user, customPayload: null, forwardTonAmount: 0,
            forwardPayload: emptyPayload(),
        },
    }))).toHaveSuccessfulTx<AskToTransfer>({ from: r.user, to: r.userWallet });
    // sendExcessesTo = null is also allowed
    expect(net.send(r.user, createMessage({
        bounce: true, value: ton("0.5"), dest: r.userWallet,
        body: AskToTransfer {
            queryId: 22, jettonAmount: 1000, transferRecipient: r.admin,
            sendExcessesTo: null, customPayload: null, forwardTonAmount: 0,
            forwardPayload: emptyPayload(),
        },
    }))).toHaveSuccessfulTx<AskToTransfer>({ from: r.user, to: r.userWallet });
}

get fun `test CRIT-01 master rejects forged burn excess destination and zero amount`() {
    val r = setupReal();
    val q: uint64 = ((1 as uint64) << 16) | ((BURN_QUERY_REWARD as uint64) << 8);
    val forged = net.send(r.userWallet, createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: r.master,
        body: BurnNotificationForMinterLocal {
            queryId: q,
            jettonAmount: 1,
            burnInitiator: r.user,
            sendExcessesTo: r.rc.address,
        },
    }));
    expect(forged).toHaveFailedTx<BurnNotificationForMinterLocal>({
        from: r.userWallet, to: r.master, exitCode: 73,
    });
    val zero = net.send(r.userWallet, createMessage({
        bounce: true,
        value: ton("0.3"),
        dest: r.master,
        body: BurnNotificationForMinterLocal {
            queryId: q,
            jettonAmount: 0,
            burnInitiator: r.user,
            sendExcessesTo: null,
        },
    }));
    expect(zero).toHaveFailedTx<BurnNotificationForMinterLocal>({
        from: r.userWallet, to: r.master, exitCode: 47,
    });
}


// ===========================================================================
// A9-CRIT-02: refund ledger, zero TON subsidy, real-wallet refunds
// ===========================================================================

fun notificationBody(owner: address, amount: coins): cell {
    return beginCell()
        .storeUint(0x7362d09c, 32) // transfer_notification
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(owner)
        .storeUint(0, 1) // forward_payload: inline empty
        .endCell();
}

fun refundQueryId(counter: uint64): uint64 {
    return ((CLAIM_KIND_REFUND as uint64) << 24) | counter;
}

fun createPendingRefund(r: RealSetup, owner: address): uint64 {
    val counter = net.runGetMethod<uint64>(r.rc.address, "get_claim_counter");
    testing.processSingleTraceStep(r.rcWallet, createMessage({
        bounce: false,
        value: ton("0.2"),
        dest: r.rc.address,
        body: notificationBody(owner, 1000),
    }));
    return refundQueryId(counter);
}

get fun `test CRIT-02 real wallet low-gas invalid stake records ledger without spending RC TON`() {
    val r = setupReal();
    openRoundReal(r, 300000);
    val before = testing.getAccountBalance(r.rc.address);
    // 0.02 TON forward -> RC receives a low-value notification (below 0.12 threshold)
    expect(askTransfer(r.user, r.userWallet, r.rc.address, 1000, ton("0.02"), emptyPayload(), ton("0.4")))
        .toHaveSuccessfulTx<AskToTransfer>({ from: r.user, to: r.userWallet });
    val after = testing.getAccountBalance(r.rc.address);
    expect(after >= before).toBeTrue();
    val ledger = rcUserStake(r.rc, 0, r.user);
    expect(ledger.amountRaw).toEqual(1000 as uint128);
    expect(ledger.principalClaimed).toBeFalse();
    // user pulls the refund ledger entry by paying gas
    val userBefore = net.runGetMethod<JettonWalletDataReply>(r.userWallet, "get_wallet_data").jettonBalance;
    expect(net.send(r.user, createMessage({
        bounce: true, value: ton("0.5"), dest: r.rc.address,
        body: ClaimPrincipal { queryId: 0, roundId: 0 },
    }))).toHaveSuccessfulTx<ClaimPrincipal>({ from: r.user, to: r.rc.address });
    val userAfter = net.runGetMethod<JettonWalletDataReply>(r.userWallet, "get_wallet_data").jettonBalance;
    expect(userAfter).toEqual(userBefore + (1000 as coins));
    expect(rcUserStake(r.rc, 0, r.user).principalClaimed).toBeTrue();
}

get fun `test CRIT-02 real wallet sufficient-gas refund round-trips and does not drain RC`() {
    val r = setupReal();
    openRoundReal(r, 300000);
    val before = testing.getAccountBalance(r.rc.address);
    val userBefore = net.runGetMethod<JettonWalletDataReply>(r.userWallet, "get_wallet_data").jettonBalance;
    expect(askTransfer(r.user, r.userWallet, r.rc.address, 1000, ton("0.15"), emptyPayload(), ton("0.5")))
        .toHaveSuccessfulTx<AskToTransfer>({ from: r.user, to: r.userWallet });
    // automatic refund: tokens go back, ledger is debited, RC keeps the inbound gas
    val userAfter = net.runGetMethod<JettonWalletDataReply>(r.userWallet, "get_wallet_data").jettonBalance;
    expect(userAfter).toEqual(userBefore);
    expect(rcUserStake(r.rc, 0, r.user).amountRaw).toEqual(0 as uint128);
    val after = testing.getAccountBalance(r.rc.address);
    expect(after >= before).toBeTrue();
}

get fun `test CRIT-02 first-hop refund bounce lands in ledger`() {
    val r = setupReal();
    // dedicated zero-balance real JettonWallet owned by RC: refund transfer first hop
    // rejects with BalanceError and bounces back to RC.
    val zeroWalletStorage = WalletStorage {
        jettonBalance: 0,
        ownerAddress: r.rc.address,
        minterAddress: r.master,
    };
    val zeroWalletInit = ContractState { code: build("JettonWallet"), data: zeroWalletStorage.toCell() };
    val zeroWallet = AutoDeployAddress { stateInit: zeroWalletInit }.calculateAddress();
    expect(net.send(testing.treasury("crit02-firsthop-deployer").address, createMessage({
        bounce: false, value: ton("2"), dest: { stateInit: zeroWalletInit }, body: TopUpTons {},
    }))).toHaveSuccessfulDeploy({ to: zeroWallet });
    expect(setRcWallet(r.rc, r.admin, zeroWallet)).toHaveSuccessfulTx<SetJettonWallet>({
        from: r.admin, to: r.rc.address,
    });
    openRoundReal(r, 300000);
    val counter = net.runGetMethod<uint64>(r.rc.address, "get_claim_counter");
    val q = refundQueryId(counter);
    // real wallet notification path: sender = zero wallet, value 0.2 -> RC refunds,
    // wallet rejects (0 token balance), bounce returns to RC and rollback REFUND runs.
    net.send(zeroWallet, createMessage({
        bounce: false,
        value: ton("0.2"),
        dest: r.rc.address,
        body: notificationBody(r.user, 1000),
    }));
    expect(net.runGetMethod<bool>(r.rc.address, "has_pending_claim", [q])).toBeFalse();
    expect(rcUserStake(r.rc, 0, r.user).amountRaw).toEqual(1000 as uint128);
}

get fun `test CRIT-02 second-hop bounce via real JettonWallet lands in ledger`() {
    val r = setupReal();
    openRoundReal(r, 300000);
    val q = createPendingRefund(r, r.user);
    // bounced InternalTransferStep reaches the real RC Jetton Wallet, which restores
    // the balance and notifies RC with TransferBounced(queryId).
    val bounceBody = beginCell()
        .storeUint(0xFFFFFFFF, 32)
        .storeUint(0x178d4519, 32) // InternalTransferStep
        .storeUint(q, 64)
        .storeCoins(1000)
        .storeUint(0, 1) // transferInitiator null
        .storeUint(0, 1) // sendExcessesTo null
        .storeCoins(0)
        .storeUint(0, 1)
        .endCell();
    val fakeRecipientWallet = testing.treasury("crit02-recipient-wallet").address;
    net.send(fakeRecipientWallet, createMessage({
        bounce: false, value: ton("0.2"), dest: r.rcWallet, body: bounceBody,
    }).bounced());
    expect(rcUserStake(r.rc, 0, r.user).amountRaw).toEqual(1000 as uint128);
}
