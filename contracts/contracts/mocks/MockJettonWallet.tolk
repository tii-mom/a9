// TEST FIXTURE ONLY — not part of the production deployment.
// A minimal TEP-74 Jetton Wallet that records the transfer/burn requests sent by
// RoundController / TeamVault so integration tests can assert amounts and recipients.
// It does not implement Jetton Master notifications / total supply accounting.

import "@contracts/types"
import "@contracts/constants"

contract MockJettonWallet {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "Test-only mock Jetton wallet that records outbound requests."
    storage: MockWalletStorage
    incomingMessages: MockAllowedMessage
}

struct MockWalletStorage {
    owner: address
    balance: coins
    transferCount: uint32
    lastTransferDest: address?
    lastTransferAmount: coins
    burnCount: uint32
    lastBurnAmount: coins
    autoAck: bool
}

fun MockWalletStorage.load(): MockWalletStorage {
    return MockWalletStorage.fromCell(contract.getData());
}

fun MockWalletStorage.save(self) {
    contract.setData(self.toCell());
}

struct MockWalletState {
    owner: address
    balance: coins
    transferCount: uint32
    lastTransferDest: address?
    lastTransferAmount: coins
    burnCount: uint32
    lastBurnAmount: coins
    autoAck: bool
}

struct (0x7e57a0c1) SetMockAutoAck {
    autoAck: bool
}

type MockAllowedMessage = AskToTransfer | AskToBurn | SetMockAutoAck | TopUpTons

fun onInternalMessage(in: InMessage) {
    val msg = lazy MockAllowedMessage.fromSlice(in.body);
    match (msg) {
        AskToTransfer => {
            var st = lazy MockWalletStorage.load();
            assert (in.senderAddress == st.owner) throw Errors.NotOwner;
            assert (st.balance >= msg.jettonAmount) throw Errors.ZeroAmount;
            st.balance -= msg.jettonAmount;
            st.transferCount += 1;
            st.lastTransferDest = msg.transferRecipient;
            st.lastTransferAmount = msg.jettonAmount;
            st.save();
            // Real-wallet behaviour used by tracked claims: confirm via excess return.
            if (st.autoAck && msg.sendExcessesTo != null && msg.sendExcessesTo! == st.owner) {
                val ack = createMessage({
                    bounce: BounceMode.NoBounce,
                    value: ton("0.01"),
                    dest: st.owner,
                    body: ReturnExcessesBack { queryId: msg.queryId },
                });
                ack.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
        }
        SetMockAutoAck => {
            var st = lazy MockWalletStorage.load();
            st.autoAck = msg.autoAck;
            st.save();
        }
        AskToBurn => {
            var st = lazy MockWalletStorage.load();
            assert (in.senderAddress == st.owner) throw Errors.NotOwner;
            assert (st.balance >= msg.jettonAmount) throw Errors.ZeroAmount;
            st.balance -= msg.jettonAmount;
            st.burnCount += 1;
            st.lastBurnAmount = msg.jettonAmount;
            st.save();
        }
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

fun onBouncedMessage(_in: InMessageBounced) {}

get fun get_mock_state(): MockWalletState {
    val st = MockWalletStorage.load();
    return {
        owner: st.owner,
        balance: st.balance,
        transferCount: st.transferCount,
        lastTransferDest: st.lastTransferDest,
        lastTransferAmount: st.lastTransferAmount,
        burnCount: st.burnCount,
        lastBurnAmount: st.lastBurnAmount,
        autoAck: st.autoAck,
    };
}
