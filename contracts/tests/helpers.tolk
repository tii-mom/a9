// v11 test fixtures: real JettonMaster + JettonWallet + RoundController + StakeTicket.
import "@stdlib/strings"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/jetton/storage"
import "@contracts/constants"
import "@contracts/types"
import "@contracts/ticket"

// Local copies of jetton messages (jetton/messages.tolk would clash with @contracts/types).
struct (0x00000015) MintOnceMsg {
    queryId: uint64
    recipient: address
    tonAmount: coins
    jettonAmount: coins
    totalTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

struct (0x0f8a7ea5) AskToTransferMsg {
    queryId: uint64
    jettonAmount: coins
    transferRecipient: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

const SUPPLY: coins = 10000000000000000000;            // 100e9 A9
const A9: coins = 1000000000;                          // 1 A9 raw
const ROUND_REWARD: coins = 700000000000000000;        // 7e8 A9
const TEAM_ROUND: coins = 120000000000000000;          // 1.2e8 A9
const RC_FUNDING: coins = 8200000000000000000;         // 7e9 + 1.2e9
const MIN_STAKE: coins = 1000000000000;                // 1,000 A9 (v11)
const IMMEDIATE_SHARE: coins = 2000;                   // bps, mirrors IMMEDIATE_REWARD_BPS
const FALLBACK: uint64 = 2592000;
const P0: uint128 = 116000;
const PREVIEW: uint32 = 43200;
const STAKE_WINDOW: uint32 = 129600;
const CANDLE: uint32 = 3600;
const CANDLES: uint8 = 24;
const MIN_QUALIFIED: uint8 = 16;
const ABORT_TIMEOUT: uint32 = 604800;
const T0: uint32 = 1000000;

struct Env {
    master: address
    rc: address
    rcWallet: address
    keeper: address
    treasury: address
    treasuryWallet: address
    teamWallet: address
}

fun emptyPayload(): slice {
    return beginCell().storeUint(0, 1).toSlice();
}

fun walletOf(master: address, owner: address): address {
    return net.runGetMethod<address>(master, "get_wallet_address", [owner]);
}

fun balanceOf(env: Env, owner: address): coins {
    val w = walletOf(env.master, owner);
    if (testing.getAccountState(w) == null) {
        return 0;
    }
    return net.runGetMethod<JettonWalletDataReply>(w, "get_wallet_data").jettonBalance;
}

fun totalSupply(env: Env): coins {
    return net.runGetMethod<coins>(env.master, "get_total_supply");
}

fun deployMaster(admin: address): address {
    val deployer = testing.treasury("v10-jetton-deployer");
    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), "https://a9.lat/a9.json".prefixWith00());
    val storage = MasterStorage { totalSupply: 0, adminAddress: admin, nextAdminAddress: null, metadata: metadata.toCell() };
    val init = ContractState { code: build("JettonMaster"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();
    expect(net.send(deployer.address, createMessage({ bounce: false, value: ton("5"), dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: addr });
    return addr;
}

fun rcStorage(keeper: address, master: address, teamWallet: address): Storage {
    val cfg = ProtocolConfig {
        addresses: ProtocolAddresses { keeper, jettonMaster: master, teamWallet }.toCell(),
        econ: ProtocolEcon {
            p0UsdE8: P0,
            roundRewardRaw: ROUND_REWARD as uint128,
            teamRoundRaw: TEAM_ROUND as uint128,
            minStakeRaw: MIN_STAKE as uint128,
        }.toCell(),
        timing: ProtocolTiming {
            previewSeconds: PREVIEW,
            stakeDurationSeconds: STAKE_WINDOW,
            candleSeconds: CANDLE,
            candleCount: CANDLES,
            minQualifiedCandles: MIN_QUALIFIED,
            abortTimeoutSeconds: ABORT_TIMEOUT,
            fallbackUnlockSeconds: FALLBACK as uint32,
            riskDisclosureVersion: 1,
            configVersion: 1,
        }.toCell(),
        codes: ProtocolCodes { jettonWalletCode: build("JettonWallet"), ticketCode: build("StakeTicket") }.toCell(),
    };
    return {
        config: cfg.toCell(),
        currentRoundId: 0,
        successCount: 0,
        rounds: [],
        carryRaw: 0,
        lastSuccessRound: 0,
        teamPendingRaw: 0,
        endAt: 0,
    };
}

fun transfer(from: address, wallet: address, to: address, amount: coins, forwardTon: coins, payload: slice, value: coins): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value,
        dest: wallet,
        body: AskToTransferMsg {
            queryId: 7,
            jettonAmount: amount,
            transferRecipient: to,
            sendExcessesTo: from,
            customPayload: null,
            forwardTonAmount: forwardTon,
            forwardPayload: payload,
        },
    }));
}

// Deploys master (mints 100e9 to treasury), RC, and funds RC with `funding` (no notification).
fun setupWith(funding: coins): Env {
    testing.setNow(T0);
    val treasury = testing.treasury("v10-treasury");
    val keeper = testing.treasury("v10-keeper");
    val team = testing.treasury("v10-team");
    val master = deployMaster(treasury.address);
    expect(net.send(treasury.address, createMessage({
        bounce: true,
        value: ton("1"),
        dest: master,
        body: MintOnceMsg { queryId: 1, recipient: treasury.address, tonAmount: ton("0.3"), jettonAmount: SUPPLY, totalTonAmount: ton("0.5"), forwardPayload: emptyPayload() },
    }))).toHaveSuccessfulTx<MintOnceMsg>({ to: master });

    val deployer = testing.treasury("v10-rc-deployer");
    val init = ContractState { code: build("RoundController"), data: rcStorage(keeper.address, master, team.address).toCell() };
    val rc = AutoDeployAddress { stateInit: init }.calculateAddress();
    expect(net.send(deployer.address, createMessage({ bounce: false, value: ton("10"), dest: { stateInit: init }, body: TopUpTons {} })))
        .toHaveSuccessfulDeploy({ to: rc });

    val env = Env {
        master,
        rc,
        rcWallet: walletOf(master, rc),
        keeper: keeper.address,
        treasury: treasury.address,
        treasuryWallet: walletOf(master, treasury.address),
        teamWallet: team.address,
    };
    expect(net.runGetMethod<address>(rc, "get_jetton_wallet_address")).toEqual(env.rcWallet);
    // funding with forward_ton_amount = 0: no transfer_notification reaches RC
    transfer(treasury.address, env.treasuryWallet, rc, funding, 0, emptyPayload(), ton("0.2"));
    expect(balanceOf(env, rc)).toEqual(funding);
    return env;
}

fun setup(): Env {
    return setupWith(RC_FUNDING);
}

// A funded staker: receives `amount` A9 from the treasury.
fun user(env: Env, name: string, amount: coins): address {
    val u = testing.treasury(name).address;
    transfer(env.treasury, env.treasuryWallet, u, amount, 0, emptyPayload(), ton("0.2"));
    return u;
}

fun stakePayloadFor(roundId: uint8, riskVersion: uint16, accept: uint8, beneficiary: address?): slice {
    var b = beginCell()
        .storeUint(OP_STAKE_DEPOSIT, 32)
        .storeUint(2, 8)
        .storeUint(roundId, 8)
        .storeUint(riskVersion, 16)
        .storeUint(accept, 8);
    if (beneficiary == null) {
        b = b.storeUint(0, 2);
    } else {
        b = b.storeAddress(beneficiary!);
    }
    return beginCell().storeUint(1, 1).storeRef(b.endCell()).toSlice();
}

fun stakePayload(roundId: uint8, riskVersion: uint16, accept: uint8): slice {
    return stakePayloadFor(roundId, riskVersion, accept, null);
}

fun stakeRaw(env: Env, owner: address, amount: coins, payload: slice, forwardTon: coins): SendResultList {
    return transfer(owner, walletOf(env.master, owner), env.rc, amount, forwardTon, payload, forwardTon + ton("0.15"));
}

fun stake(env: Env, owner: address, roundId: uint8, amount: coins): SendResultList {
    return stakeRaw(env, owner, amount, stakePayload(roundId, 1, 1), ton("0.15"));
}

fun stakeFor(env: Env, payer: address, beneficiary: address, roundId: uint8, amount: coins): SendResultList {
    return stakeRaw(env, payer, amount, stakePayloadFor(roundId, 1, 1, beneficiary), ton("0.15"));
}

fun ticketOf(env: Env, owner: address, roundId: uint8): address {
    return net.runGetMethod<address>(env.rc, "get_ticket_address", [owner, roundId]);
}

fun ticketData(env: Env, owner: address, roundId: uint8): TicketView {
    return net.runGetMethod<TicketView>(ticketOf(env, owner, roundId), "get_ticket_data");
}

fun ticketExists(env: Env, owner: address, roundId: uint8): bool {
    return testing.getAccountState(ticketOf(env, owner, roundId)) != null;
}

fun stakedAmount(env: Env, roundId: uint8, owner: address): uint128 {
    if (!ticketExists(env, owner, roundId)) {
        return 0;
    }
    return ticketData(env, owner, roundId).amountRaw;
}

fun claimTicket(env: Env, owner: address, roundId: uint8): SendResultList {
    return net.send(owner, createMessage({ bounce: true, value: ton("0.2"), dest: ticketOf(env, owner, roundId), body: TicketClaim { queryId: 1 } }));
}

fun restakeTicket(env: Env, owner: address, roundId: uint8): SendResultList {
    return net.send(owner, createMessage({ bounce: true, value: ton("0.3"), dest: ticketOf(env, owner, roundId), body: TicketRestake { queryId: 1 } }));
}

fun preview(env: Env, roundId: uint8, weight: uint128): RewardPreview {
    return net.runGetMethod<RewardPreview>(env.rc, "get_reward_preview", [roundId, weight]);
}

fun pstate(env: Env): ProtocolStateView {
    return net.runGetMethod<ProtocolStateView>(env.rc, "get_protocol_state");
}

fun round(env: Env, roundId: uint8): RoundView {
    return net.runGetMethod<RoundView>(env.rc, "get_round", [roundId]);
}

fun currentRound(env: Env): uint8 {
    return net.runGetMethod<uint8>(env.rc, "get_current_round");
}

fun openRound(env: Env, from: address, twap24h: uint128): SendResultList {
    return net.send(from, createMessage({ bounce: true, value: ton("0.2"), dest: env.rc, body: OpenRound { queryId: 1, twap24hUsdE8: twap24h } }));
}

fun advanceTo(t: uint64) {
    testing.setNow(t as uint32);
}

fun submitCandle(env: Env, from: address, roundId: uint8, index: uint8, twap: uint128): SendResultList {
    val rd = round(env, roundId);
    val start = rd.observationStart + (index as uint64) * (CANDLE as uint64);
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.5"),
        dest: env.rc,
        body: SubmitCandle {
            queryId: 1,
            roundId,
            candleIndex: index,
            periodStart: start as uint32,
            periodEnd: (start + (CANDLE as uint64)) as uint32,
            twapPriceUsdE8: twap,
            dataDigest: 0 as uint256,
        },
    }));
}

// Runs the whole observation of the current round with `qualified` candles at the target.
fun observe(env: Env, qualified: uint8): SendResultList {
    val roundId = currentRound(env);
    val rd = round(env, roundId);
    advanceTo(rd.stakeCloseAt + (CANDLE as uint64) * (CANDLES as uint64));
    var last: SendResultList = submitCandle(env, env.keeper, roundId, 0, qualified > 0 ? rd.targetPriceUsdE8 : 1);
    var i: uint8 = 1;
    while (i < CANDLES) {
        last = submitCandle(env, env.keeper, roundId, i, i < qualified ? rd.targetPriceUsdE8 : rd.targetPriceUsdE8 - 1);
        i += 1;
    }
    return last;
}

// Opens the next round as soon as its preview has finished.
fun openNext(env: Env, twap24h: uint128) {
    val cur = currentRound(env);
    if (cur != 0) {
        advanceTo(round(env, cur + 1).stakeOpenAt);
    }
    expect(openRound(env, env.keeper, twap24h)).toHaveSuccessfulTx<OpenRound>({ to: env.rc });
}

