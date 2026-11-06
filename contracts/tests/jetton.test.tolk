// A9 Jetton Master / Wallet tests (TEP-74 / TEP-89 compatible subset + A9 mint-once).
//
// These tests intentionally import ONLY the jetton modules (not the A9 protocol
// modules) so the jetton implementation can be verified in isolation.

import "@stdlib/strings"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/transaction"

import "@contracts/jetton/errors"
import "@contracts/jetton/messages"
import "@contracts/jetton/storage"
import "@contracts/jetton/jetton-utils"

const TOTAL_SUPPLY_RAW: coins = 10000000000000000000; // 100 亿 A9 (9 decimals)

fun makeMetadata(uri: string): cell {
    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), uri.prefixWith00());
    return metadata.toCell();
}

fun emptyForwardPayload(): slice {
    return beginCell().storeUint(0, 1).toSlice();
}

fun refForwardPayload(payload: cell): slice {
    return beginCell().storeUint(1, 1).storeRef(payload).toSlice();
}

// StakePayload-shaped cell (136 bit) used to verify forward_payload passthrough.
fun makeStakeLikePayload(): cell {
    return beginCell()
        .storeUint(0x5254000F, 32)
        .storeUint(1, 8)
        .storeUint(1, 8)
        .storeUint(42, 64)
        .storeUint(1, 16)
        .storeUint(1, 8)
        .endCell();
}

struct MasterHandle {
    address: address
}

fun deployMaster(admin: address): MasterHandle {
    val deployer = testing.treasury("jetton-deployer");
    val storage = MasterStorage {
        totalSupply: 0,
        adminAddress: admin,
        nextAdminAddress: null,
        metadata: makeMetadata("https://a9.lat/a9.json"),
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
    return { address: addr };
}

fun masterData(master: MasterHandle): JettonDataReply {
    return net.runGetMethod<JettonDataReply>(master.address, "get_jetton_data");
}

fun walletAddressOf(master: MasterHandle, owner: address): address {
    return net.runGetMethod<address>(master.address, "get_wallet_address", [owner]);
}

fun walletData(wallet: address): JettonWalletDataReply {
    return net.runGetMethod<JettonWalletDataReply>(wallet, "get_wallet_data");
}

fun mintOnce(
    master: MasterHandle,
    from: address,
    recipient: address,
    jettonAmount: coins,
    tonAmount: coins,
    totalTonAmount: coins,
    forwardPayload: slice,
): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: totalTonAmount,
        dest: master.address,
        body: MintOnce {
            queryId: 1,
            recipient,
            tonAmount,
            jettonAmount,
            totalTonAmount,
            forwardPayload,
        },
    }));
}

fun defaultMint(master: MasterHandle, admin: address, recipient: address): SendResultList {
    return mintOnce(
        master,
        admin,
        recipient,
        TOTAL_SUPPLY_RAW,
        ton("0.4"),
        ton("0.5"),
        emptyForwardPayload(),
    );
}

fun sendTransfer(
    wallet: address,
    from: address,
    amount: coins,
    recipient: address,
    forwardTonAmount: coins,
    forwardPayload: slice,
    value: coins = ton("0.3"),
): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value,
        dest: wallet,
        body: AskToTransfer {
            queryId: 7,
            jettonAmount: amount,
            transferRecipient: recipient,
            sendExcessesTo: from,
            customPayload: null,
            forwardTonAmount,
            forwardPayload,
        },
    }));
}

fun sendBurn(wallet: address, from: address, amount: coins, value: coins = ton("0.2")): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value,
        dest: wallet,
        body: AskToBurn {
            queryId: 9,
            jettonAmount: amount,
            sendExcessesTo: from,
            customPayload: null,
        },
    }));
}

// ===========================================================================
// Deployment + getters
// ===========================================================================

get fun `test master deploys with zero supply, admin and embedded wallet code`() {
    val admin = testing.treasury("jetton-admin");
    val master = deployMaster(admin.address);
    val data = masterData(master);
    expect(data.totalSupply).toEqual(0);
    expect(data.mintable).toBeTrue();
    expect(data.adminAddress).toEqual(admin.address);
    expect(data.jettonWalletCode.depth()).toBeGreater(0);
}

get fun `test get_wallet_address is deterministic and owner-specific`() {
    val admin = testing.treasury("jetton-admin");
    val alice = testing.treasury("jetton-alice");
    val bob = testing.treasury("jetton-bob");
    val master = deployMaster(admin.address);

    val aliceWallet = walletAddressOf(master, alice.address);
    val aliceWallet2 = walletAddressOf(master, alice.address);
    val bobWallet = walletAddressOf(master, bob.address);
    expect(aliceWallet).toEqual(aliceWallet2);
    expect(aliceWallet).toNotEqual(bobWallet);
    // matches the off-chain calculation helper used by the master itself
    expect(aliceWallet).toEqual(calcAddressOfJettonWallet(alice.address, master.address, build("JettonWallet")));
}

get fun `test provide_wallet_address answers with owner and wallet address`() {
    val admin = testing.treasury("jetton-admin");
    val asker = testing.treasury("jetton-asker");
    val owner = testing.treasury("jetton-owner");
    val master = deployMaster(admin.address);

    val res = net.send(asker.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: master.address,
        body: RequestWalletAddress {
            queryId: 5,
            ownerAddress: owner.address,
            includeOwnerAddress: true,
        },
    }));
    expect(res).toHaveSuccessfulTx<RequestWalletAddress>({
        from: asker.address,
        to: master.address,
    });
    val tx = res.findTransaction<ResponseWalletAddress>({
        from: master.address,
        to: asker.address,
        success: true,
    });
    expect(tx).toBeNotNull();
    val body = tx!.loadBody<ResponseWalletAddress>();
    expect(body.queryId).toEqual(5);
    expect(body.jettonWalletAddress!).toEqual(walletAddressOf(master, owner.address));
    expect(body.ownerAddress!).toEqual(owner.address.toCell());
}

// ===========================================================================
// Mint-once policy
// ===========================================================================

get fun `test non-admin cannot mint`() {
    val admin = testing.treasury("jetton-admin");
    val attacker = testing.treasury("jetton-attacker");
    val recipient = testing.treasury("jetton-recipient");
    val master = deployMaster(admin.address);

    expect(defaultMint(master, attacker.address, recipient.address)).toHaveFailedTx<MintOnce>({
        from: attacker.address,
        to: master.address,
        exitCode: JettonErrors.NotOwner,
    });
    expect(masterData(master).totalSupply).toEqual(0);
}

get fun `test mint amount must be exactly 100e9`() {
    val admin = testing.treasury("jetton-admin");
    val recipient = testing.treasury("jetton-recipient");
    val master = deployMaster(admin.address);

    expect(mintOnce(master, admin.address, recipient.address, 999 as coins, ton("0.4"), ton("0.5"), emptyForwardPayload()))
        .toHaveFailedTx<MintOnce>({
            from: admin.address,
            to: master.address,
            exitCode: JettonErrors.MintAmountMismatch,
        });
    expect(masterData(master).totalSupply).toEqual(0);
}

get fun `test admin mints 100e9 once and mint closes permanently`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val master = deployMaster(admin.address);

    val res = defaultMint(master, admin.address, treasury.address);
    expect(res).toHaveSuccessfulTx<MintOnce>({ from: admin.address, to: master.address });

    val data = masterData(master);
    expect(data.totalSupply).toEqual(TOTAL_SUPPLY_RAW);
    expect(data.mintable).toBeFalse();
    expect(data.adminAddress).toBeNull();

    val wallet = walletAddressOf(master, treasury.address);
    val wd = walletData(wallet);
    expect(wd.jettonBalance).toEqual(TOTAL_SUPPLY_RAW);
    expect(wd.ownerAddress).toEqual(treasury.address);
    expect(wd.minterAddress).toEqual(master.address);

    // second mint (even from the ex-admin) is rejected: mint is closed forever
    expect(defaultMint(master, admin.address, treasury.address)).toHaveFailedTx<MintOnce>({
        from: admin.address,
        to: master.address,
        exitCode: JettonErrors.MintClosed,
    });
    expect(masterData(master).totalSupply).toEqual(TOTAL_SUPPLY_RAW);
}

// ===========================================================================
// Transfers (TEP-74) + forward payload passthrough (A9 seam)
// ===========================================================================

get fun `test owner transfer moves balance and deploys recipient wallet`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val alice = testing.treasury("jetton-alice");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });

    val treasuryWallet = walletAddressOf(master, treasury.address);
    val aliceWallet = walletAddressOf(master, alice.address);
    val amount = 2500000000000000000 as coins; // 2.5e9 A9

    expect(sendTransfer(treasuryWallet, treasury.address, amount, alice.address, 0, emptyForwardPayload(), ton("0.3")))
        .toHaveSuccessfulTx<AskToTransfer>({ from: treasury.address, to: treasuryWallet });

    expect(walletData(treasuryWallet).jettonBalance).toEqual(TOTAL_SUPPLY_RAW - amount);
    expect(walletData(aliceWallet).jettonBalance).toEqual(amount);
    expect(walletData(aliceWallet).ownerAddress).toEqual(alice.address);
}

get fun `test transfer forwards forward_payload and forward_ton_amount untouched`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val alice = testing.treasury("jetton-alice");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });

    val treasuryWallet = walletAddressOf(master, treasury.address);
    val aliceWallet = walletAddressOf(master, alice.address);
    val payloadCell = makeStakeLikePayload();
    val amount = 1000000000 as coins; // 1 A9

    val res = sendTransfer(
        treasuryWallet,
        treasury.address,
        amount,
        alice.address,
        ton("0.05"),
        refForwardPayload(payloadCell),
        ton("0.3"),
    );
    expect(res).toHaveSuccessfulTx<AskToTransfer>({ from: treasury.address, to: treasuryWallet });

    val notifyTx = res.findTransaction<TransferNotificationForRecipient>({
        from: aliceWallet,
        to: alice.address,
        success: true,
    });
    expect(notifyTx).toBeNotNull();
    val notification = notifyTx!.loadBody<TransferNotificationForRecipient>();
    expect(notification.jettonAmount).toEqual(amount);
    expect(notification.transferInitiator!).toEqual(treasury.address);

    var fp = notification.forwardPayload;
    val payloadRef = fp.loadMaybeRef();
    expect(payloadRef).toBeNotNull();
    expect(payloadRef!.hash()).toEqual(payloadCell.hash());
}

get fun `test non-owner cannot transfer and balance is unchanged`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val attacker = testing.treasury("jetton-attacker");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });
    val treasuryWallet = walletAddressOf(master, treasury.address);

    expect(sendTransfer(treasuryWallet, attacker.address, 1 as coins, attacker.address, 0, emptyForwardPayload()))
        .toHaveFailedTx<AskToTransfer>({
            from: attacker.address,
            to: treasuryWallet,
            exitCode: JettonErrors.NotOwner,
        });
    expect(walletData(treasuryWallet).jettonBalance).toEqual(TOTAL_SUPPLY_RAW);
}

get fun `test transfer more than balance is rejected`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val alice = testing.treasury("jetton-alice");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });
    val treasuryWallet = walletAddressOf(master, treasury.address);

    expect(sendTransfer(treasuryWallet, treasury.address, TOTAL_SUPPLY_RAW + 1, alice.address, 0, emptyForwardPayload()))
        .toHaveFailedTx<AskToTransfer>({
            from: treasury.address,
            to: treasuryWallet,
            exitCode: JettonErrors.BalanceError,
        });
}

// ===========================================================================
// Burns (TEP-74) + total_supply accounting
// ===========================================================================

get fun `test owner burn decreases wallet balance and master total_supply`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });
    val treasuryWallet = walletAddressOf(master, treasury.address);
    val burnAmount = 7000000000000000 as coins; // 7,000,000 A9

    expect(sendBurn(treasuryWallet, treasury.address, burnAmount)).toHaveSuccessfulTx<AskToBurn>({
        from: treasury.address,
        to: treasuryWallet,
    });

    expect(walletData(treasuryWallet).jettonBalance).toEqual(TOTAL_SUPPLY_RAW - burnAmount);
    expect(masterData(master).totalSupply).toEqual(TOTAL_SUPPLY_RAW - burnAmount);
}

get fun `test non-owner cannot burn`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val attacker = testing.treasury("jetton-attacker");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });
    val treasuryWallet = walletAddressOf(master, treasury.address);

    expect(sendBurn(treasuryWallet, attacker.address, 1 as coins)).toHaveFailedTx<AskToBurn>({
        from: attacker.address,
        to: treasuryWallet,
        exitCode: JettonErrors.NotOwner,
    });
    expect(masterData(master).totalSupply).toEqual(TOTAL_SUPPLY_RAW);
}

get fun `test burn more than balance is rejected`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });
    val treasuryWallet = walletAddressOf(master, treasury.address);

    expect(sendBurn(treasuryWallet, treasury.address, TOTAL_SUPPLY_RAW + 1)).toHaveFailedTx<AskToBurn>({
        from: treasury.address,
        to: treasuryWallet,
        exitCode: JettonErrors.BalanceError,
    });
    expect(masterData(master).totalSupply).toEqual(TOTAL_SUPPLY_RAW);
}

// ===========================================================================
// Message source validation
// ===========================================================================

get fun `test internal_transfer from an unauthorized sender is rejected`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val attacker = testing.treasury("jetton-attacker");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });
    val treasuryWallet = walletAddressOf(master, treasury.address);

    val res = net.send(attacker.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: treasuryWallet,
        body: InternalTransferStep {
            queryId: 3,
            jettonAmount: 1 as coins,
            transferInitiator: null,
            sendExcessesTo: null,
            forwardTonAmount: 0,
            forwardPayload: emptyForwardPayload(),
        },
    }));
    expect(res).toHaveFailedTx<InternalTransferStep>({
        from: attacker.address,
        to: treasuryWallet,
        exitCode: JettonErrors.NotValidWallet,
    });
    expect(walletData(treasuryWallet).jettonBalance).toEqual(TOTAL_SUPPLY_RAW);
}

get fun `test master rejects burn_notification from a fake wallet`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val fake = testing.treasury("jetton-fake-wallet");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });

    val res = net.send(fake.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: master.address,
        body: BurnNotificationForMinter {
            queryId: 4,
            jettonAmount: 1 as coins,
            burnInitiator: fake.address,
            sendExcessesTo: fake.address,
        },
    }));
    expect(res).toHaveFailedTx<BurnNotificationForMinter>({
        from: fake.address,
        to: master.address,
        exitCode: JettonErrors.NotValidWallet,
    });
    expect(masterData(master).totalSupply).toEqual(TOTAL_SUPPLY_RAW);
}

get fun `test unknown message is rejected with TEP-74 invalid message code`() {
    val admin = testing.treasury("jetton-admin");
    val treasury = testing.treasury("jetton-treasury");
    val master = deployMaster(admin.address);
    expect(defaultMint(master, admin.address, treasury.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address,
        to: master.address,
    });
    val treasuryWallet = walletAddressOf(master, treasury.address);

    val res = net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: treasuryWallet,
        body: beginCell().storeUint(0xdeadbeef, 32).endCell(),
    }));
    expect(res).toHaveFailedTx({
        from: admin.address,
        to: treasuryWallet,
        exitCode: 0xFFFF,
    });
}

// ===========================================================================
// Admin / content management before mint
// ===========================================================================

get fun `test change_content is admin-only and visible in get_jetton_data`() {
    val admin = testing.treasury("jetton-admin");
    val notAdmin = testing.treasury("jetton-not-admin");
    val master = deployMaster(admin.address);
    val newContent = makeMetadata("https://a9.lat/a9-v2.json");

    expect(net.send(notAdmin.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: master.address,
        body: ChangeMinterMetadata { queryId: 1, newMetadata: newContent },
    }))).toHaveFailedTx<ChangeMinterMetadata>({
        from: notAdmin.address,
        to: master.address,
        exitCode: JettonErrors.NotOwner,
    });

    expect(net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: master.address,
        body: ChangeMinterMetadata { queryId: 2, newMetadata: newContent },
    }))).toHaveSuccessfulTx<ChangeMinterMetadata>({
        from: admin.address,
        to: master.address,
    });
    expect(masterData(master).jettonContent.hash()).toEqual(newContent.hash());
}

get fun `test change_admin + claim_admin handover before mint`() {
    val admin = testing.treasury("jetton-admin");
    val nextAdmin = testing.treasury("jetton-next-admin");
    val master = deployMaster(admin.address);

    expect(net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: master.address,
        body: ChangeMinterAdmin { queryId: 1, newAdminAddress: nextAdmin.address },
    }))).toHaveSuccessfulTx<ChangeMinterAdmin>({ from: admin.address, to: master.address });
    expect(net.runGetMethod<address?>(master.address, "get_next_admin_address")).toEqual(nextAdmin.address);

    // only the nominated next admin can claim
    expect(net.send(admin.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: master.address,
        body: ClaimMinterAdmin { queryId: 2 },
    }))).toHaveFailedTx<ClaimMinterAdmin>({
        from: admin.address,
        to: master.address,
        exitCode: JettonErrors.NotOwner,
    });
    expect(net.send(nextAdmin.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: master.address,
        body: ClaimMinterAdmin { queryId: 3 },
    }))).toHaveSuccessfulTx<ClaimMinterAdmin>({ from: nextAdmin.address, to: master.address });
    expect(masterData(master).adminAddress).toEqual(nextAdmin.address);
}


get fun `test F8 MintOnce rejects underfunded wallet deploy without clearing admin`() {
    val admin = testing.treasury("jetton-admin");
    val master = deployMaster(admin.address);
    val bad = mintOnce(master, admin.address, admin.address, TOTAL_SUPPLY_RAW, ton("0.05"), ton("0.2"), emptyForwardPayload());
    expect(bad).toHaveFailedTx<MintOnce>({
        from: admin.address, to: master.address, exitCode: JettonErrors.InvalidMintMessage,
    });
    val data = masterData(master);
    expect(data.totalSupply).toEqual(0);
    expect(data.adminAddress).toEqual(admin.address);
    // a correctly funded mint still works
    expect(defaultMint(master, admin.address, admin.address)).toHaveSuccessfulTx<MintOnce>({
        from: admin.address, to: master.address,
    });
}
