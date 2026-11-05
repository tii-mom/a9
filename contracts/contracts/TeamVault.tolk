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
    | ReturnExcessesBack
    | TopUpTons

fun onInternalMessage(in: InMessage) {
    val msg = lazy TeamVaultAllowedMessage.fromSlice(in.body);

    match (msg) {
        SetJettonWallet => {
            var st = lazy TeamVaultStorage.load();
            assert (in.senderAddress == st.config.admin) throw Errors.NotAdmin;
            assert (msg.wallet != createAddressNone()) throw Errors.BadConfig;
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
                if (state.released) {
                    // Idempotent duplicate: resend the acknowledgement, move nothing.
                    sendTeamReleasedAck(st, roundId, state.amountRaw, msg.queryId);
                    return;
                }
                val kind: uint8 = ((state.queryId >> 8) & 0xff) as uint8;
                if (state.burned || kind == BURN_QUERY_TEAM) {
                    throw Errors.TeamRoundConflict;
                }
                // Pending release already in flight: do not transfer twice.
                return;
            }

            val params = st.params.load();
            val amount = params.teamRoundRaw;
            assert (amount > 0) throw Errors.ZeroTeamQuota;
            val queryId = ((roundId as uint64) << 16) | ((RELEASE_QUERY_TEAM as uint64) << 8);
            st.rounds.set(roundId, TeamRoundState {
                released: false,
                burned: false,
                amountRaw: amount,
                queryId,
            });
            st.save();

            // S-3: pending until the wallet confirms; excesses come back to TV.
            sendJettonTransfer(
                params.jettonWallet,
                queryId,
                amount as coins,
                params.teamWallet,
                contract.getAddress(),
            );
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
                if (state.burned) {
                    // Already confirmed: idempotent ack resend.
                    val burnIdRes = st.pendingBurnIds.get(roundId);
                    assert (burnIdRes.isFound) throw Errors.BadBurnId;
                    sendTeamBurnedAck(st, roundId, state.amountRaw, burnIdRes.loadValue(), msg.queryId);
                }
                // Pending burn: do not burn twice, wait for master confirmation.
                return;
            }

            val params = st.params.load();
            val amount = params.teamRoundRaw;
            assert (amount > 0) throw Errors.ZeroTeamQuota;
            val queryId = ((roundId as uint64) << 16) | ((BURN_QUERY_TEAM as uint64) << 8);
            st.rounds.set(roundId, TeamRoundState {
                released: false,
                burned: false,
                amountRaw: amount,
                queryId,
            });
            st.pendingBurnIds.set(roundId, msg.burnId);
            st.save();

            // P0-2 closure: excesses go back to TeamVault; only the Jetton Master's
            // ReturnExcessesBack confirms the burn and triggers TeamBurnedAck.
            sendJettonBurn(
                params.jettonWallet,
                queryId,
                amount as coins,
                contract.getAddress(),
            );
        }
        ReturnExcessesBack => {
            var st = lazy TeamVaultStorage.load();
            val params = st.params.load();
            val roundId: uint8 = ((msg.queryId >> 16) & 0xff) as uint8;
            val kind: uint8 = ((msg.queryId >> 8) & 0xff) as uint8;
            if (in.senderAddress == params.jettonWallet) {
                // S-3: release transfer completed -> confirm and ack RC.
                if (kind != RELEASE_QUERY_TEAM) {
                    return;
                }
                val prev = st.rounds.get(roundId);
                if (!prev.isFound) {
                    return;
                }
                var rel = prev.loadValue();
                if (rel.released || rel.burned || rel.queryId != msg.queryId) {
                    return;
                }
                rel.released = true;
                st.rounds.set(roundId, rel);
                st.totalReleasedRaw += rel.amountRaw;
                st.releasedCount += 1;
                st.save();
                sendTeamReleasedAck(st, roundId, rel.amountRaw, msg.queryId);
                emitExternalEvent(TeamReleased {
                    roundId,
                    amountRaw: rel.amountRaw,
                    to: params.teamWallet,
                });
                return;
            }
            assert (in.senderAddress == params.jettonMaster) throw Errors.NotJettonMaster;
            assert (kind == BURN_QUERY_TEAM) throw Errors.BurnKindMismatch;
            val prev = st.rounds.get(roundId);
            if (!prev.isFound) {
                return;
            }
            var state = prev.loadValue();
            if (state.released || state.burned || state.queryId != msg.queryId) {
                return;
            }
            state.burned = true;
            st.rounds.set(roundId, state);
            st.totalBurnedRaw += state.amountRaw;
            st.burnedCount += 1;
            val burnIdRes = st.pendingBurnIds.get(roundId);
            assert (burnIdRes.isFound) throw Errors.BadBurnId;
            val burnId = burnIdRes.loadValue();
            // keep burnId in storage so later duplicate BurnTeamQuota can resend the ack
            st.save();

            sendTeamBurnedAck(st, roundId, state.amountRaw, burnId, msg.queryId);
            emitExternalEvent(TeamBurned {
                roundId,
                amountRaw: state.amountRaw,
                burnId,
            });
        }
        TopUpTons => {
            // accept TON top-ups for gas
        }
        else => throw Errors.UnknownMessage,
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // P0-2 closure: a bounced team burn leaves the round retryable.
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 96) {
        return;
    }
    val op = in.bouncedBody.loadUint(32);
    if (op != OP_JETTON_BURN && op != OP_JETTON_TRANSFER) {
        return;
    }
    val queryId: uint64 = in.bouncedBody.loadUint(64) as uint64;
    val roundId: uint8 = ((queryId >> 16) & 0xff) as uint8;
    val kind: uint8 = ((queryId >> 8) & 0xff) as uint8;
    if (op == OP_JETTON_TRANSFER) {
        // S-3: release bounce -> clear pending, no ack, retryable.
        if (kind != RELEASE_QUERY_TEAM) {
            return;
        }
        var st = lazy TeamVaultStorage.load();
        val prev = st.rounds.get(roundId);
        if (!prev.isFound) {
            return;
        }
        val rel = prev.loadValue();
        if (rel.released || rel.burned || rel.queryId != queryId) {
            return;
        }
        st.rounds.delete(roundId);
        st.save();
        return;
    }
    if (kind != BURN_QUERY_TEAM) {
        return;
    }
    var st = lazy TeamVaultStorage.load();
    val prev = st.rounds.get(roundId);
    if (!prev.isFound) {
        return;
    }
    val state = prev.loadValue();
    if (state.released || state.burned || state.queryId != queryId) {
        return;
    }
    st.rounds.delete(roundId);
    st.pendingBurnIds.delete(roundId);
    st.save();
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
