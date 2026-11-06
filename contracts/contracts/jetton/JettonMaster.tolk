// A9 Protocol — Jetton Master (TEP-74 / TEP-89 compatible, Tolk)
//
// A9-specific policy: mint-once-then-close-mint.
//   * op 0x15 "mint" (21, same numeric opcode as the TEP-74 FunC reference)
//   * exactly 10,000,000,000 A9 (100 亿, 9 decimals) can be minted, once
//   * after the successful mint, admin is set to null permanently
//   * total_supply is only decreased by verified burn_notification messages
//
// Reuses the audited-shape TEP-74 reference logic shipped with Acton's
// official "jetton" template (wallet code embedded via @gen/JettonWallet.code).

import "@gen/JettonWallet.code"
import "errors"
import "fees-management"
import "jetton-utils"
import "messages"
import "sharding"
import "storage"

// 100 亿 A9 with 9 decimals = 10_000_000_000 * 1e9
const TOTAL_SUPPLY_RAW: coins = 10000000000000000000;

contract JettonMaster {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "A9 Jetton Master: mint 100e9 once then permanently close mint; TEP-74 transfers/burns."
    storage: MasterStorage
    incomingMessages: MasterAllowedMessage
}

type MasterAllowedMessage =
    | MintOnce
    | BurnNotificationForMinter
    | RequestWalletAddress
    | ChangeMinterAdmin
    | ClaimMinterAdmin
    | DropMinterAdmin
    | ChangeMinterMetadata
    | TopUpTons

fun onBouncedMessage(in: InMessageBounced) {
    // mint is one-shot; a bounced wallet deploy would otherwise leave
    // total_supply inflated, so roll it back (same behaviour as the TEP-74 reference).
    in.bouncedBody.skipBouncedPrefix();
    val msg = lazy InternalTransferStep.fromSlice(in.bouncedBody);

    var storage = lazy MasterStorage.load();
    storage.totalSupply -= msg.jettonAmount;
    storage.save();
}

fun requireAdmin(sender: address, admin: address?) {
    assert (admin != null) throw JettonErrors.MintClosed;
    assert (sender == admin!) throw JettonErrors.NotOwner;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy MasterAllowedMessage.fromSlice(in.body);

    match (msg) {
        MintOnce => {
            var storage = lazy MasterStorage.load();
            // mint is already closed (or this is a second mint attempt)
            assert (storage.adminAddress != null) throw JettonErrors.MintClosed;
            assert (in.senderAddress == storage.adminAddress!) throw JettonErrors.NotOwner;
            assert (storage.totalSupply == 0) throw JettonErrors.MintClosed;
            assert (msg.jettonAmount == TOTAL_SUPPLY_RAW) throw JettonErrors.MintAmountMismatch;
            assert (msg.recipient.getWorkchain() == MY_WORKCHAIN) throw JettonErrors.WrongWorkchain;
            assert (msg.totalTonAmount >= msg.tonAmount) throw JettonErrors.InvalidMintMessage;
            assert (in.valueCoins >= msg.totalTonAmount) throw JettonErrors.InvalidMintMessage;
            // A9-F8: never clear admin/totalSupply unless the mint wallet deploy can
            // definitely be funded; otherwise a later action bounce permanently bricks mint.
            assert (msg.tonAmount >= ton("0.1")) throw JettonErrors.InvalidMintMessage;
            assert (in.valueCoins >= msg.tonAmount + ton("0.05")) throw JettonErrors.InvalidMintMessage;
            msg.forwardPayload.checkIsCorrectTlbEither();
            checkAmountIsEnoughToTransfer(msg.tonAmount, 0, in.originalForwardFee);

            storage.totalSupply = TOTAL_SUPPLY_RAW;
            // mint-once-then-close-mint: admin is cleared in the same transaction
            storage.adminAddress = null;
            storage.nextAdminAddress = null;
            storage.save();

            reserveToncoinsOnBalance(ton("0.01"), RESERVE_MODE_EXACT_AMOUNT);

            val walletCode = jettonWalletCompiledCode();
            val deployMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: calcDeployedJettonWallet(msg.recipient, contract.getAddress(), walletCode),
                value: msg.tonAmount,
                body: InternalTransferStep {
                    queryId: msg.queryId,
                    jettonAmount: msg.jettonAmount,
                    transferInitiator: null,
                    sendExcessesTo: null,
                    forwardTonAmount: 0,
                    forwardPayload: msg.forwardPayload,
                },
            });
            deployMsg.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }

        BurnNotificationForMinter => {
            handleBurnNotification(
                in.senderAddress,
                msg.queryId,
                msg.jettonAmount,
                msg.burnInitiator,
                msg.sendExcessesTo,
            );
        }


        RequestWalletAddress => {
            val ownerAddress: Cell<address>? = msg.includeOwnerAddress
                ? msg.ownerAddress.toCell()
                : null;

            var walletAddress: address? = null;
            if (msg.ownerAddress.getWorkchain() == MY_WORKCHAIN) {
                walletAddress = calcAddressOfJettonWallet(
                    msg.ownerAddress,
                    contract.getAddress(),
                    jettonWalletCompiledCode(),
                );
            }

            val respondMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: ResponseWalletAddress {
                    queryId: msg.queryId,
                    jettonWalletAddress: walletAddress,
                    ownerAddress,
                },
            });
            respondMsg.send(
                SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL,
            );
        }

        ChangeMinterAdmin => {
            var storage = lazy MasterStorage.load();
            requireAdmin(in.senderAddress, storage.adminAddress);
            storage.nextAdminAddress = msg.newAdminAddress;
            storage.save();
        }

        ClaimMinterAdmin => {
            var storage = lazy MasterStorage.load();
            assert (storage.nextAdminAddress != null) throw JettonErrors.NotOwner;
            assert (in.senderAddress == storage.nextAdminAddress!) throw JettonErrors.NotOwner;
            storage.adminAddress = storage.nextAdminAddress;
            storage.nextAdminAddress = null;
            storage.save();
        }

        DropMinterAdmin => {
            var storage = lazy MasterStorage.load();
            requireAdmin(in.senderAddress, storage.adminAddress);
            storage.adminAddress = null;
            storage.nextAdminAddress = null;
            storage.save();
        }

        ChangeMinterMetadata => {
            var storage = lazy MasterStorage.load();
            requireAdmin(in.senderAddress, storage.adminAddress);
            storage.metadata = msg.newMetadata;
            storage.save();
        }

        TopUpTons => {
            // accept TON top-ups for gas/storage
        }

        else => throw JettonErrors.InvalidMessage,
    }
}

fun handleBurnNotification(
    sender: address,
    queryId: uint64,
    jettonAmount: coins,
    burnInitiator: address,
    sendExcessesTo: address?,
) {
    var storage = lazy MasterStorage.load();
    assert (
        sender ==
        calcAddressOfJettonWallet(burnInitiator, contract.getAddress(), jettonWalletCompiledCode())
    ) throw JettonErrors.NotValidWallet;
    assert (storage.totalSupply >= jettonAmount) throw JettonErrors.BalanceError;
    storage.totalSupply -= jettonAmount;
    storage.save();

    if (sendExcessesTo == null) {
        return;
    }

    val excessesMsg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: sendExcessesTo,
        value: 0,
        body: ReturnExcessesBack { queryId },
    });
    excessesMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
}

get fun get_jetton_data(): JettonDataReply {
    val storage = lazy MasterStorage.load();
    return {
        totalSupply: storage.totalSupply,
        mintable: storage.adminAddress != null,
        adminAddress: storage.adminAddress,
        jettonContent: storage.metadata as Cell<OnchainMetadataReply>,
        jettonWalletCode: jettonWalletCompiledCode(),
    };
}

get fun get_wallet_address(ownerAddress: address): address {
    return calcAddressOfJettonWallet(
        ownerAddress,
        contract.getAddress(),
        jettonWalletCompiledCode(),
    );
}

get fun get_next_admin_address(): address? {
    val storage = lazy MasterStorage.load();
    return storage.nextAdminAddress;
}

get fun get_total_supply(): coins {
    val storage = lazy MasterStorage.load();
    return storage.totalSupply;
}
