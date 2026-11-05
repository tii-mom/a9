// Test fixture: records TransferBounced notifications from a real JettonWallet.
import "@contracts/types"
import "@contracts/constants"

contract MockBounceOwner {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "Test-only owner that records TransferBounced from a real Jetton Wallet."
    storage: MockBounceOwnerStorage
    incomingMessages: MockBounceOwnerAllowed
}

struct MockBounceOwnerStorage {
    count: uint8
    lastQueryId: uint64
}

fun MockBounceOwnerStorage.load(): MockBounceOwnerStorage {
    return MockBounceOwnerStorage.fromCell(contract.getData());
}
fun MockBounceOwnerStorage.save(self) {
    contract.setData(self.toCell());
}

struct MockBounceOwnerState {
    count: uint8
    lastQueryId: uint64
}

type MockBounceOwnerAllowed = TransferBounced | TopUpTons

fun onInternalMessage(in: InMessage) {
    val msg = lazy MockBounceOwnerAllowed.fromSlice(in.body);
    match (msg) {
        TransferBounced => {
            var st = lazy MockBounceOwnerStorage.load();
            st.count += 1;
            st.lastQueryId = msg.queryId;
            st.save();
        }
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

fun onBouncedMessage(_in: InMessageBounced) {}

get fun get_state(): MockBounceOwnerState {
    val st = MockBounceOwnerStorage.load();
    return { count: st.count, lastQueryId: st.lastQueryId };
}
