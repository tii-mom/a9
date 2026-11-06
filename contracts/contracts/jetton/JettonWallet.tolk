import "@stdlib/gas-payments"
import "errors"
import "fees-management"
import "jetton-utils"
import "messages"
import "sharding"
import "storage"

contract JettonWallet {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "A9 Jetton Wallet. TEP-74/TEP-89 compatible; forwards forward_payload untouched."
    storage: WalletStorage
    incomingMessages: AllowedMessageToWallet
}

type AllowedMessageToWallet =
    | AskToTransfer
    | AskToBurn
    | InternalTransferStep
    | TopUpTons

type BounceOpToHandle = InternalTransferStep | BurnNotificationForMinter

fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    val op = in.bouncedBody.preloadUint(32);

    // C-4: parse the queryId from a copy before lazy field access consumes the body.
    var querySlice = in.bouncedBody;
    var bouncedQueryId: uint64 = 0;
    if (op == OP_JETTON_INTERNAL_TRANSFER) {
        querySlice.loadUint(32);
        bouncedQueryId = querySlice.loadUint(64) as uint64;
    }

    val msg = lazy BounceOpToHandle.fromSlice(in.bouncedBody);
    val restoreAmount = match (msg) {
        InternalTransferStep => msg.jettonAmount,
        BurnNotificationForMinter => msg.jettonAmount,
    };

    var storage = lazy WalletStorage.load();
    storage.jettonBalance += restoreAmount;
    storage.save();

    // C-4: the second hop (recipient wallet) bounced; the sender wallet only sees
    // the bounce. Notify the owner so RC/TeamVault can roll back their pending
    // claim/release instead of being stuck on ClaimPending forever.
    if (op == OP_JETTON_INTERNAL_TRANSFER) {
        val notice = createMessage({
            bounce: BounceMode.NoBounce,
            value: ton("0.02"),
            dest: storage.ownerAddress,
            body: TransferBounced { queryId: bouncedQueryId },
        });
        // C-4: IGNORE_ERRORS (2) is mandatory here. Without it a failed 0.02 TON
        // notice would abort the whole action phase and roll back the jettonBalance
        // restore above (permanent token loss). If the notice cannot be paid, we
        // skip it and keep the balance rollback; worst case the owner stays pending.
        notice.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
    }
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToWallet.fromSlice(in.body);

    match (msg) {
        InternalTransferStep => {
            var storage = lazy WalletStorage.load();
            if (in.senderAddress != storage.minterAddress) {
                // TEP-74: internal_transfer may come from the master (mint) or from
                // the sender's own wallet (self-transfer). Anything else is forged.
                val initiator = msg.transferInitiator;
                assert (initiator != null) throw JettonErrors.NotValidWallet;
                assert (
                    in.senderAddress ==
                    calcAddressOfJettonWallet(
                        initiator!,
                        storage.minterAddress,
                        contract.getCode(),
                    )
                ) throw JettonErrors.NotValidWallet;
            }
            storage.jettonBalance += msg.jettonAmount;
            storage.save();

            if (msg.forwardTonAmount != 0) {
                val notifyOwnerMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.ownerAddress,
                    value: msg.forwardTonAmount,
                    body: TransferNotificationForRecipient {
                        queryId: msg.queryId,
                        jettonAmount: msg.jettonAmount,
                        transferInitiator: msg.transferInitiator,
                        forwardPayload: msg.forwardPayload,
                    },
                });
                notifyOwnerMsg.send(
                    SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL,
                );
            }

            if (msg.sendExcessesTo != null) {
                val toLeaveOnBalance = contract.getOriginalBalance() - in.valueCoins +
                contract.getStorageDuePayment();
                reserveToncoinsOnBalance(
                    max(toLeaveOnBalance, calculateJettonWalletMinStorageFee()),
                    RESERVE_MODE_AT_MOST,
                );

                val excessesMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.sendExcessesTo,
                    value: 0,
                    body: ReturnExcessesBack { queryId: msg.queryId },
                });
                // SAFETY: It is safe because of reserveToncoinsOnBalance() called earlier
                // F-04/P1-1: never silently drop the completion signal; bounce on action failure.
                excessesMsg.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            }
        }

        AskToTransfer => {
            // A9-CRIT-01: zero-amount transfers are never needed and enable spoofing.
            assert (msg.jettonAmount > 0) throw JettonErrors.BalanceError;
            msg.forwardPayload.checkIsCorrectTlbEither();
            assert (
                msg.transferRecipient.getWorkchain() == MY_WORKCHAIN
            ) throw JettonErrors.WrongWorkchain;
            checkAmountIsEnoughToTransfer(
                in.valueCoins,
                msg.forwardTonAmount,
                in.originalForwardFee,
            );

            var storage = lazy WalletStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw JettonErrors.NotOwner;
            // A9-CRIT-01: only the owner may receive excesses; prevents a third party
            // from using this wallet as a confused deputy to spoof ReturnExcessesBack.
            assert (
                msg.sendExcessesTo == null || msg.sendExcessesTo! == storage.ownerAddress
            ) throw JettonErrors.NotOwner;
            assert (storage.jettonBalance >= msg.jettonAmount) throw JettonErrors.BalanceError;
            storage.jettonBalance -= msg.jettonAmount;
            storage.save();

            val deployMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: calcDeployedJettonWallet(
                    msg.transferRecipient,
                    storage.minterAddress,
                    contract.getCode(),
                ),
                value: 0,
                body: InternalTransferStep {
                    queryId: msg.queryId,
                    jettonAmount: msg.jettonAmount,
                    transferInitiator: storage.ownerAddress,
                    sendExcessesTo: msg.sendExcessesTo,
                    forwardTonAmount: msg.forwardTonAmount,
                    forwardPayload: msg.forwardPayload,
                },
            });
            deployMsg.send(
                SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL,
            );
        }

        AskToBurn => {
            // A9-CRIT-01: zero amount and third-party excess destinations are forbidden.
            assert (msg.jettonAmount > 0) throw JettonErrors.BalanceError;
            checkAmountIsEnoughToBurn(in.valueCoins);

            var storage = lazy WalletStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw JettonErrors.NotOwner;
            assert (
                msg.sendExcessesTo == null || msg.sendExcessesTo! == storage.ownerAddress
            ) throw JettonErrors.NotOwner;
            assert (storage.jettonBalance >= msg.jettonAmount) throw JettonErrors.BalanceError;
            storage.jettonBalance -= msg.jettonAmount;
            storage.save();

            val notifyMinterMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: storage.minterAddress,
                value: 0,
                body: BurnNotificationForMinter {
                    queryId: msg.queryId,
                    jettonAmount: msg.jettonAmount,
                    burnInitiator: storage.ownerAddress,
                    sendExcessesTo: msg.sendExcessesTo,
                },
            });
            notifyMinterMsg.send(
                SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL,
            );
        }

        TopUpTons => {
            // just accept tons
        }

        else => throw 0xFFFF,
    }
}

get fun get_wallet_data(): JettonWalletDataReply {
    val storage = lazy WalletStorage.load();

    return {
        jettonBalance: storage.jettonBalance,
        ownerAddress: storage.ownerAddress,
        minterAddress: storage.minterAddress,
        jettonWalletCode: contract.getCode(),
    };
}
