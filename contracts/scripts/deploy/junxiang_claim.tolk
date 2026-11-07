// Claim 军饷 from the JunxiangDistributor with a cumulative Merkle proof (testnet drills / ops).
// POSITIONAL args (up to 3 sibling hashes = trees of up to 8 leaves; use "-" for unused slots):
//   acton script scripts/deploy/junxiang_claim.tolk <cumulativeRaw> <h1|-> <h2|-> <h3|->
//
// The proof comes from GET /api/social/payout/proof?wallet=<signer address>
// (siblings bottom-up, promoted levels omitted). The signer wallet is the claimant
// (A9_SIGNER_WALLET). Address: JUNXIANG_DISTRIBUTOR_ADDRESS env or deploy/junxiang-distributor.addr.
// Dry-run by default; broadcast with OPS_EXECUTE=1 OPS_CONFIRM=YES + --net <network>.

import "@acton/fmt"
import "@acton/io"
import "@acton/testing/assert"
import "@acton/emulation/scripts"
import "@stdlib/strings"
import "actions"
import "@contracts/junxiang"

const OP_CLAIM_JUNXIANG_CODE: uint32 = 0x4a580002;

fun main(cumulativeRaw: int, h1: string, h2: string, h3: string) {
    if (cumulativeRaw <= 0) {
        Assert.fail("cumulativeRaw must be > 0");
    }
    val distributor = resolveAddress(
        "JUNXIANG_DISTRIBUTOR_ADDRESS",
        "deploy/junxiang-distributor.addr",
        "JunxiangDistributor",
    );
    val signer = scripts.wallet(signerName());

    // Pack the siblings 3 x uint256 into one cell (bottom-up order), as the contract expects.
    var b = beginCell();
    var count = 0;
    val parts = [format("{}", h1), format("{}", h2), format("{}", h3)];
    var i = 0;
    while (i < 3) {
        val text = parts.get(i);
        if (!text.equalTo("-")) {
            b = b.storeUint(parseDigestHex(text, "proof hash"), 256);
            count += 1;
        }
        i += 1;
    }
    val proof: cell? = count == 0 ? null : b.endCell();

    val msg = createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: distributor,
        body: ClaimJunxiang { queryId: 0, cumulativeRaw: cumulativeRaw as uint128, proof },
    });
    println("junxiang_claim:");
    println("  signer      = {}", signer.address);
    println("  cumulative  = {}", cumulativeRaw);
    println("  siblings    = {}", count);
    printSummary("  message", distributor, ton("0.2"), OP_CLAIM_JUNXIANG_CODE, msg);
    broadcastOrDryRun(signer.address, msg);
}
