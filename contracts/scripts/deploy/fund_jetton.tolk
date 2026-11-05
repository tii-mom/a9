// Fund A9 Jettons to a target Jetton Wallet (standard TEP-74 transfer).
// POSITIONAL args:
//   acton script scripts/deploy/fund_jetton.tolk <to_jetton_wallet> <amount_raw>
//
// Source: the signer wallet's own Jetton Wallet, resolved from the Jetton Master.
//   Jetton Master: JETTON_MASTER_ADDRESS env or deploy/jetton-master.addr
//   Signer wallet: A9_SIGNER_WALLET env (default TON_DEPLOYER_WALLET or "treasury")
// Dry-run by default; broadcast with OPS_EXECUTE=1 OPS_CONFIRM=YES + --net testnet.
// For local emulation dry-run set JETTON_SOURCE_WALLET_ADDRESS to skip RPC resolution.
//
// Examples: fund_jetton.tolk <RC Jetton Wallet> 700000000000000000
//           fund_jetton.tolk <TV Jetton Wallet> 120000000000000000

import "@acton/env"
import "@acton/io"
import "@acton/fmt"
import "@acton/testing/assert"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@contracts/jetton/storage"
import "actions"

fun main(toJettonWallet: address, amountRaw: int) {
    if (amountRaw <= 0) {
        Assert.fail("amount_raw must be positive (raw units, 9 decimals)");
    }
    val master = resolveAddress(
        "JETTON_MASTER_ADDRESS",
        "deploy/jetton-master.addr",
        "A9 Jetton Master",
    );
    val signer = scripts.wallet(signerName());

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

    val msg = buildFundJetton(sourceWallet!, signer.address, toJettonWallet, amountRaw as coins);
    println("fund_jetton:");
    println("  signer      = {}", signer.address);
    println("  wallet name = {}", signerName());
    println("  master      = {}", master);
    println("  from wallet = {}", sourceWallet!);
    printSummary("  message", sourceWallet!, ton("0.3"), 0x0f8a7ea5, msg);
    println("  jetton amount = {} raw", amountRaw);
    println("  transfer to   = {}", toJettonWallet);
    broadcastOrDryRun(signer.address, msg);
}
