// A9 Protocol — TeamVault (docs/04 §2.6, docs/11 §4.2)
//
// Holds the 12% team allocation (1,200,000,000 A9) in its own Jetton Wallet.
// Accepts instructions ONLY from RoundController:
//   * ReleaseTeamQuota(roundId) -> transfer 1.2e8 A9 to the team hot wallet
//   * BurnTeamQuota(roundId)    -> burn 1.2e8 A9
// Same-round release/burn are mutually exclusive and idempotent: repeating an
// instruction resends the acknowledgement but never moves funds twice.
//
// Deploy order: deploy TeamVault with controller = null, deploy RoundController,
// then call InitController(roundControllerAddress) from the deployer exactly once.

import "types"
import "constants"
import "jetton"

contract TeamVault {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "Team 12% quota vault, RoundController-only, per-round release/burn, idempotent."
    storage: TeamVaultStorage
    incomingMessages: TeamVaultAllowedMessage
}

type TeamVaultAllowedMessage =
    | SetJettonWallet
    | InitController
    | ReleaseTeamQuota
    | BurnTeamQuota
    | TopUpTons

fun onInternalMessage(in: InMessage) {
    val msg = lazy TeamVaultAllowedMessage.fromSlice(in.body);

    match (msg) {
        SetJettonWallet => {
            var st = lazy TeamVaultStorage.load();
            assert (in.senderAddress == st.config.admin) throw Errors.NotAdmin;
            // one-time: only before the controller is wired up
            assert (st.config.controller == null) throw Errors.AlreadyInitialized;
            var params = st.params.load();
            params.jettonWallet = msg.wallet;
            st.params = params.toCell();
            st.save();
        }
        InitController => {
            var st = lazy TeamVaultStorage.load();
            assert (in.senderAddress == st.config.admin) throw Errors.NotAdmin;
            assert (st.config.controller == null) throw Errors.AlreadyInitialized;
            assert (msg.controller != createAddressNone()) throw Errors.BadConfig;
            st.config.controller = msg.controller;
            st.save();
        }
        ReleaseTeamQuota => {
            var st = lazy TeamVaultStorage.load();
            requireController(st, in.senderAddress);
            val roundId = msg.roundId;
            assert (roundId >= 1 && roundId <= MAX_ROUNDS) throw Errors.BadRoundId;

            val prev = st.rounds.get(roundId);
            if (prev.isFound) {
                val state = prev.loadValue();
                if (state.burned) {
                    throw Errors.TeamRoundConflict;
                }
                // Idempotent duplicate: resend the acknowledgement, move nothing.
                sendTeamReleasedAck(st, roundId, state.amountRaw, msg.queryId);
                return;
            }

            val params = st.params.load();
            val amount = params.teamRoundRaw;
            assert (amount > 0) throw Errors.ZeroTeamQuota;
            st.rounds.set(roundId, TeamRoundState {
                released: true,
                burned: false,
                amountRaw: amount,
                queryId: msg.queryId,
            });
            st.totalReleasedRaw += amount;
            st.releasedCount += 1;
            st.save();

            sendJettonTransfer(
                params.jettonWallet,
                msg.queryId,
                amount as coins,
                params.teamWallet,
                params.teamWallet,
            );
            sendTeamReleasedAck(st, roundId, amount, msg.queryId);
            emitExternalEvent(TeamReleased {
                roundId,
                amountRaw: amount,
                to: params.teamWallet,
            });
        }
        BurnTeamQuota => {
            var st = lazy TeamVaultStorage.load();
            requireController(st, in.senderAddress);
            val roundId = msg.roundId;
            assert (roundId >= 1 && roundId <= MAX_ROUNDS) throw Errors.BadRoundId;

            val prev = st.rounds.get(roundId);
            if (prev.isFound) {
                val state = prev.loadValue();
                if (state.released) {
                    throw Errors.TeamRoundConflict;
                }
                sendTeamBurnedAck(st, roundId, state.amountRaw, msg.burnId, msg.queryId);
                return;
            }

            val params = st.params.load();
            val amount = params.teamRoundRaw;
            assert (amount > 0) throw Errors.ZeroTeamQuota;
            st.rounds.set(roundId, TeamRoundState {
                released: false,
                burned: true,
                amountRaw: amount,
                queryId: msg.queryId,
            });
            st.totalBurnedRaw += amount;
            st.burnedCount += 1;
            st.save();

            sendJettonBurn(
                params.jettonWallet,
                msg.queryId,
                amount as coins,
                params.teamWallet,
            );
            sendTeamBurnedAck(st, roundId, amount, msg.burnId, msg.queryId);
            emitExternalEvent(TeamBurned {
                roundId,
                amountRaw: amount,
                burnId: msg.burnId,
            });
        }
        TopUpTons => {
            // accept TON top-ups for gas
        }
        else => throw Errors.UnknownMessage,
    }
}

fun onBouncedMessage(_in: InMessageBounced) {
    // TeamVault state is written before outgoing messages are sent and every
    // instruction is idempotent, so a bounced child message is recovered by
    // resending the same instruction from RoundController.
}

fun requireController(st: TeamVaultStorage, sender: address) {
    assert (st.config.controller != null) throw Errors.NotInitialized;
    assert (sender == st.config.controller!) throw Errors.NotController;
}

fun sendTeamReleasedAck(st: TeamVaultStorage, roundId: uint8, amountRaw: uint128, queryId: uint64) {
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: ton("0.02"),
        dest: st.config.controller!,
        body: TeamReleasedAck { queryId, roundId, amountRaw },
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun sendTeamBurnedAck(
    st: TeamVaultStorage,
    roundId: uint8,
    amountRaw: uint128,
    burnId: uint256,
    queryId: uint64,
) {
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: ton("0.02"),
        dest: st.config.controller!,
        body: TeamBurnedAck { queryId, roundId, amountRaw, burnId },
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

get fun get_team_vault_state(): TeamVaultState {
    val st = lazy TeamVaultStorage.load();
    val params = st.params.load();
    return {
        controller: st.config.controller,
        jettonWallet: params.jettonWallet,
        teamWallet: params.teamWallet,
        teamRoundRaw: params.teamRoundRaw,
        totalReleasedRaw: st.totalReleasedRaw,
        totalBurnedRaw: st.totalBurnedRaw,
        releasedCount: st.releasedCount,
        burnedCount: st.burnedCount,
    };
}

get fun get_round_state(roundId: uint8): TeamRoundState {
    val st = lazy TeamVaultStorage.load();
    val r = st.rounds.get(roundId);
    if (!r.isFound) {
        return TeamRoundState { released: false, burned: false, amountRaw: 0, queryId: 0 };
    }
    return r.loadValue();
}

get fun get_config(): TeamVaultConfig {
    val st = lazy TeamVaultStorage.load();
    return st.config;
}
