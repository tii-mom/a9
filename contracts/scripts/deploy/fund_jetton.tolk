// Fund A9 Jettons to an OWNER address (standard TEP-74 transfer).
// POSITIONAL args:
//   acton script scripts/deploy/fund_jetton.tolk <to_owner> <amount_raw>
//
// TEP-74 IMPORTANT: <to_owner> is the jetton OWNER (e.g. the RoundController or
// TeamVault CONTRACT address), NOT the owner's Jetton Wallet. The source wallet
// derives the destination wallet from the owner via calcDeployedJettonWallet().
// Passing a Jetton Wallet address here creates a wallet owned by that wallet
// contract (unspendable) — do not do it.
//
// Source: the signer wallet's own Jetton Wallet, resolved from the Jetton Master.
//   Jetton Master: JETTON_MASTER_ADDRESS env or deploy/jetton-master.addr
//   Signer wallet: A9_SIGNER_WALLET env (default TON_DEPLOYER_WALLET or "treasury")
// Dry-run by default; broadcast with OPS_EXECUTE=1 OPS_CONFIRM=YES + --net testnet.
// For local emulation dry-run set JETTON_SOURCE_WALLET_ADDRESS to skip RPC resolution.
//
// The script always prints "owner -> expected wallet" so the operator can verify
// the TEP-74 derivation before broadcasting. In broadcast mode the address is
// queried from master.get_wallet_address(owner) and compared with the local
// build("JettonWallet") derivation (mismatch => hard failure).
//
// Examples: fund_jetton.tolk <RC owner address> 700000000000000000
//           fund_jetton.tolk <TV owner address> 120000000000000000

import "@acton/env"
import "@acton/build"
import "@acton/io"
import "@acton/fmt"
import "@acton/testing/assert"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@contracts/jetton/storage"
import "@contracts/jetton/jetton-utils"
import "actions"

fun main(toOwner: address, amountRaw: int) {
    if (amountRaw <= 0) {
        Assert.fail("amount_raw must be positive (raw units, 9 decimals)");
    }
    val master = resolveAddress(
        "JETTON_MASTER_ADDRESS",
        "deploy/jetton-master.addr",
        "A9 Jetton Master",
    );
    val signer = scripts.wallet(signerName());

    // Defensive TEP-74 check: print the owner -> derived wallet mapping.
    // This is the only place the operator can catch a wallet-vs-owner mixup.
    val computedWallet = calcAddressOfJettonWallet(toOwner, master, build("JettonWallet"));
    var expectedWallet: address = computedWallet;
    if (net.isBroadcasting()) {
        val onchainWallet = net.runGetMethod<address>(master, "get_wallet_address", [toOwner]);
        if (onchainWallet != computedWallet) {
            Assert.fail(
                format(
                    "master.get_wallet_address(owner) mismatch: on-chain={} local build={} (wallet code differs from build/JettonWallet)",
                    onchainWallet,
                    computedWallet,
                ),
            );
        }
        expectedWallet = onchainWallet;
    }

    var sourceWallet: address? = null;
    if (net.isBroadcasting()) {
        val resolved = net.runGetMethod<address>(master, "get_wallet_address", [signer.address]);
        val data = net.runGetMethod<JettonWalletDataReply>(resolved, "get_wallet_data");
        if (data.jettonBalance < amountRaw) {
            Assert.fail(
                format(
                    "insufficient A9 balance: source wallet {} has {} raw, requested {} raw",
                    resolved,
                    data.jettonBalance,
                    amountRaw,
                ),
            );
        }
        sourceWallet = resolved;
    } else {
        sourceWallet = env<address>("JETTON_SOURCE_WALLET_ADDRESS");
    }
    if (sourceWallet == null) {
        Assert.fail(
            "cannot resolve the source Jetton Wallet in local dry-run: set JETTON_SOURCE_WALLET_ADDRESS=<wallet> (or run with --net testnet)",
        );
    }

    val msg = buildFundJetton(sourceWallet!, signer.address, toOwner, amountRaw as coins);
    println("fund_jetton:");
    println("  signer      = {}", signer.address);
    println("  wallet name = {}", signerName());
    println("  master      = {}", master);
    println("  from wallet = {}", sourceWallet!);
    println("  transfer to OWNER = {}", toOwner);
    println("  owner -> expected wallet = {}", expectedWallet);
    printSummary("  message", sourceWallet!, ton("0.3"), 0x0f8a7ea5, msg);
    println("  jetton amount = {} raw", amountRaw);
    broadcastOrDryRun(signer.address, msg);
}
