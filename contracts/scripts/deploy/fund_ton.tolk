// Fund TON to a contract/wallet. POSITIONAL args (Acton has no --flags):
//   acton script scripts/deploy/fund_ton.tolk <to_address> <amount_ton_integer>
//
// Dry-run by default. To broadcast:
//   OPS_EXECUTE=1 OPS_CONFIRM=YES acton script ... --net testnet
// Signer wallet name: A9_SIGNER_WALLET (default TON_DEPLOYER_WALLET or "treasury").
//
// Examples: fund_ton.tolk <RC address> 20   /   fund_ton.tolk <TV address> 10

import "@acton/io"
import "@acton/fmt"
import "@acton/testing/assert"
import "@acton/emulation/scripts"
import "actions"

fun main(to: address, amountTon: int) {
    if (amountTon <= 0) {
        Assert.fail("amount_ton must be a positive integer");
    }
    val value: coins = (amountTon as coins) * 1000000000;
    val signer = scripts.wallet(signerName());
    val balance = scripts.fetchAccountBalance(signer.address);
    if (balance < value + ton("0.05")) {
        Assert.fail(
            format(
                "insufficient signer balance: {} nano < requested {} nano + fee",
                balance,
                value,
            ),
        );
    }

    val msg = buildFundTon(to, value);
    println("fund_ton:");
    println("  signer      = {}", signer.address);
    println("  wallet name = {}", signerName());
    printSummary("  message", to, value, 0xd372158c, msg);
    broadcastOrDryRun(signer.address, msg);
}
