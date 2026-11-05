// Test fixture: records the last forwarded RC message for exact-field assertions.
import "@contracts/types"
import "@contracts/constants"

contract MockOracleReceiver {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "Test-only receiver for OracleAdapter forwarding assertions."
    storage: OracleReceiverStorage
    incomingMessages: OracleReceiverAllowedMessage
}

struct OracleReceiverStorage {
    openCount: uint8
    closeCount: uint8
    candleCount: uint8
    lastRoundId: uint8
    lastCandleIndex: uint8
    lastPeriodStart: uint32
    lastPeriodEnd: uint32
    lastTwap: uint128
    lastDigest: uint256
    lastQueryId: uint64
}

fun OracleReceiverStorage.load(): OracleReceiverStorage {
    return OracleReceiverStorage.fromCell(contract.getData());
}

fun OracleReceiverStorage.save(self) {
    contract.setData(self.toCell());
}

struct OracleReceiverState {
    openCount: uint8
    closeCount: uint8
    candleCount: uint8
    lastRoundId: uint8
    lastCandleIndex: uint8
    lastPeriodStart: uint32
    lastPeriodEnd: uint32
    lastTwap: uint128
    lastDigest: uint256
    lastQueryId: uint64
}

type OracleReceiverAllowedMessage = OpenRound | CloseStaking | SubmitCandle | TopUpTons

fun onInternalMessage(in: InMessage) {
    val msg = lazy OracleReceiverAllowedMessage.fromSlice(in.body);
    match (msg) {
        OpenRound => {
            var st = lazy OracleReceiverStorage.load();
            st.openCount += 1;
            st.lastQueryId = msg.queryId;
            st.lastTwap = msg.twap24hUsdE8;
            st.save();
        }
        CloseStaking => {
            var st = lazy OracleReceiverStorage.load();
            st.closeCount += 1;
            st.lastQueryId = msg.queryId;
            st.lastTwap = msg.twap1hUsdE8;
            st.save();
        }
        SubmitCandle => {
            var st = lazy OracleReceiverStorage.load();
            st.candleCount += 1;
            st.lastQueryId = msg.queryId;
            st.lastRoundId = msg.roundId;
            st.lastCandleIndex = msg.candleIndex;
            st.lastPeriodStart = msg.periodStart;
            st.lastPeriodEnd = msg.periodEnd;
            st.lastTwap = msg.twapPriceUsdE8;
            st.lastDigest = msg.dataDigest;
            st.save();
        }
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

fun onBouncedMessage(_in: InMessageBounced) {}

get fun get_state(): OracleReceiverState {
    val st = OracleReceiverStorage.load();
    return {
        openCount: st.openCount,
        closeCount: st.closeCount,
        candleCount: st.candleCount,
        lastRoundId: st.lastRoundId,
        lastCandleIndex: st.lastCandleIndex,
        lastPeriodStart: st.lastPeriodStart,
        lastPeriodEnd: st.lastPeriodEnd,
        lastTwap: st.lastTwap,
        lastDigest: st.lastDigest,
        lastQueryId: st.lastQueryId,
    };
}
