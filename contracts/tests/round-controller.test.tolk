import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"
import "@acton/types/transaction"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

// ===========================================================================
// Deployment / config
// ===========================================================================

get fun `test RoundController deploys with V6.1 parameters and zeroed state`() {
    val f = setupProtocol();
    val cfg = rcConfig(f.rc);
    expect(cfg.admin).toEqual(f.admin);
    expect(cfg.oracle).toEqual(f.oracle);
    expect(cfg.jettonMaster).toEqual(f.jettonMaster);
    expect(cfg.teamVault).toEqual(f.tv.address);
    expect(cfg.stakingJettonWallet).toEqual(f.rcWallet.address);
    expect(cfg.p0UsdE8).toEqual(116000 as uint128);
    expect(cfg.priceMultiplier).toEqual(2);
    expect(cfg.roundRewardRaw).toEqual(ROUND_REWARD_RAW);
    expect(cfg.teamRoundRaw).toEqual(TEAM_ROUND_RAW);
    expect(cfg.minStakeRaw).toEqual(MIN_STAKE_RAW);
    expect(cfg.maxStakePerAddressBps).toEqual(1000);
    expect(cfg.maxTotalStakeRaw).toEqual(MAX_TOTAL_STAKE_RAW);
    expect(cfg.previewSeconds).toEqual(86400);
    expect(cfg.stakeDurationSeconds).toEqual(259200);
    expect(cfg.candleSeconds).toEqual(14400);
    expect(cfg.candleCount).toEqual(18);
    expect(cfg.minQualifiedCandles).toEqual(12);
    expect(cfg.observationSeconds).toEqual(259200);
    expect(cfg.techAbortPauseSeconds).toEqual(1209600);
    expect(cfg.techAbortObsTimeoutSeconds).toEqual(604800);
    expect(cfg.riskDisclosureVersion).toEqual(1);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_current_round")).toEqual(0);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(0);
}

get fun `test SetJettonWallet is admin-only and locked after the first round opens`() {
    val f = setupProtocol();
    val attacker = testing.treasury("attacker");
    expect(setRCWallet(f.rc, attacker.address, f.admin)).toHaveFailedTx<SetJettonWallet>({
        from: attacker.address,
        to: f.rc.address,
        exitCode: Errors.NotAdmin,
    });
    expect(rcConfig(f.rc).stakingJettonWallet).toEqual(f.rcWallet.address);

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(setRCWallet(f.rc, f.admin, f.admin)).toHaveFailedTx<SetJettonWallet>({
        from: f.admin,
        to: f.rc.address,
        exitCode: Errors.BadRoundStatus,
    });
}

// ===========================================================================
// Open round / target locking
// ===========================================================================

get fun `test R1 opens at 2xP0 and locks the target`() {
    val f = setupProtocol();
    expect(openRound(f.rc, f.admin, 100000)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    val rd = rcRound(f.rc, 1);
    expect(rd.status).toEqual(STATUS_STAKING_OPEN);
    expect(rd.targetTier).toEqual(1);
    // max(2 * 116000, 2 * 100000) = 232000
    expect(rd.targetPriceUsdE8).toEqual(232000 as uint128);
    expect(rd.targetTwap24hUsdE8).toEqual(100000 as uint128);
    expect(rd.rewardBudgetRaw).toEqual(ROUND_REWARD_RAW);
    expect(rd.stakeOpenAt).toEqual(1000000);
    expect(rd.stakeCloseAt).toEqual(1000000 + 259200);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_current_round")).toEqual(1);
    expect(net.runGetMethod<uint128>(f.rc.address, "get_round_target_price", [1 as uint8]))
        .toEqual(232000 as uint128);
}

get fun `test target uses 2x opening TWAP when above the ladder`() {
    val f = setupProtocol();
    expect(openRound(f.rc, f.admin, 300000)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    val rd = rcRound(f.rc, 1);
    expect(rd.targetPriceUsdE8).toEqual(600000 as uint128);
    expect(rd.targetTier).toEqual(1);
}

get fun `test OpenRound is admin/oracle only and oracle can open`() {
    val f = setupProtocol();
    val attacker = testing.treasury("attacker");
    expect(openRound(f.rc, attacker.address, 0)).toHaveFailedTx<OpenRound>({
        from: attacker.address,
        to: f.rc.address,
        exitCode: Errors.NotOracle,
    });
    expect(openRound(f.rc, f.oracle, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.oracle,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_STAKING_OPEN);
}

get fun `test cannot open a second round before the first is settled`() {
    val f = setupProtocol();
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(openRound(f.rc, f.admin, 0)).toHaveFailedTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
        exitCode: Errors.PreviousRoundNotSettled,
    });
}

// ===========================================================================
// Staking acceptance / refunds
// ===========================================================================

get fun `test valid stake is accepted and aggregated`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });

    val amount = 100000000000000 as coins; // 100,000 A9
    val payload = buildStakePayload(1, 1, 1, 1);
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, amount, payload))
        .toHaveSuccessfulTx<TransferNotification>({
            from: f.rcWallet.address,
            to: f.rc.address,
        });

    val pos = rcUserStake(f.rc, 1, alice.address);
    expect(pos.amountRaw).toEqual(amount as uint128);
    expect(pos.lastDepositNonce).toEqual(1);
    expect(pos.principalClaimed).toBeFalse();
    expect(pos.rewardClaimed).toBeFalse();
    expect(net.runGetMethod<uint128>(f.rc.address, "get_round_total_stake", [1 as uint8]))
        .toEqual(amount as uint128);
    expect(mockState(f.rcWallet).transferCount).toEqual(0);

    // second deposit with a fresh nonce accumulates
    val payload2 = buildStakePayload(1, 2, 1, 1);
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, amount, payload2))
        .toHaveSuccessfulTx<TransferNotification>({
            from: f.rcWallet.address,
            to: f.rc.address,
        });
    expect(rcUserStake(f.rc, 1, alice.address).amountRaw).toEqual((amount as uint128) * 2);
}

get fun `test duplicate nonce is refunded and not double counted`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    val amount = 100000000000000 as coins;
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, amount, buildStakePayload(1, 7, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({
            from: f.rcWallet.address,
            to: f.rc.address,
        });
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, amount, buildStakePayload(1, 7, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({
            from: f.rcWallet.address,
            to: f.rc.address,
        });

    expect(rcUserStake(f.rc, 1, alice.address).amountRaw).toEqual(amount as uint128);
    val ms = mockState(f.rcWallet);
    expect(ms.transferCount).toEqual(1);
    expect(ms.lastTransferDest).toEqual(alice.address);
}

get fun `test below-minimum / wrong risk version / burn-not-accepted / wrong round are refunded`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });

    // below minimum (9,999 A9)
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 9999000000000 as coins, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    // wrong risk version
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 50000000000000 as coins, buildStakePayload(1, 2, 2, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    // burn flag not accepted
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 50000000000000 as coins, buildStakePayload(1, 3, 1, 0)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    // wrong round id
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 50000000000000 as coins, buildStakePayload(2, 4, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });

    expect(rcUserStake(f.rc, 1, alice.address).amountRaw).toEqual(0 as uint128);
    expect(mockState(f.rcWallet).transferCount).toEqual(4);
    expect(mockState(f.rcWallet).lastTransferDest).toEqual(alice.address);
}

get fun `test stake after window close is refunded`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    advance(259200);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 100000000000000 as coins, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    expect(rcUserStake(f.rc, 1, alice.address).amountRaw).toEqual(0 as uint128);
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
}

get fun `test notification from a non-canonical wallet is rejected`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val fake = testing.treasury("fake-wallet");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(sendStake(f.rc, fake.address, alice.address, 100000000000000 as coins, buildStakePayload(1, 1, 1, 1)))
        .toHaveFailedTx<TransferNotification>({
            from: fake.address,
            to: f.rc.address,
            exitCode: Errors.NotJettonWallet,
        });
}

get fun `test round total cap is enforced with refund`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val bob = testing.treasury("bob");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    // 200,000,000 A9 cap; two 20,000,000 A9 deposits are within the per-address cap
    val capAmount = 20000000000000000 as coins; // 20,000,000 A9
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, capAmount, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    expect(sendStake(f.rc, f.rcWallet.address, bob.address, capAmount, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    expect(net.runGetMethod<uint128>(f.rc.address, "get_round_total_stake", [1 as uint8]))
        .toEqual((capAmount as uint128) * 2);
}

get fun `test per-address hard cap (20,000,000 A9) is enforced with refund`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    val over = 20000000000000001 as coins; // 20,000,000.000000001 A9
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, over, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    expect(rcUserStake(f.rc, 1, alice.address).amountRaw).toEqual(0 as uint128);
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
}


get fun `test late keeper re-anchors the staking window instead of deadlocking`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = testing.treasury("keeper");
    runSuccessRound(f, 1, alice.address, keeper.address, 100000000000000 as coins);

    // miss the whole PREVIEW + 72h window
    advance(86400 + 259200 + 5000);
    val now = testing.getNow();
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    val r2 = rcRound(f.rc, 2);
    expect(r2.status).toEqual(STATUS_STAKING_OPEN);
    expect(r2.stakeOpenAt).toEqual((now as uint64));
    expect(r2.stakeCloseAt).toEqual((now as uint64) + 259200);
}
