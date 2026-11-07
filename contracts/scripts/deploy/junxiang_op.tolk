// JunxiangDistributor publisher operation (v11, contracts/README §7.1).
// POSITIONAL args:
//   acton script scripts/deploy/junxiang_op.tolk junxiang-set-root <listId> <rootHex>
//
//   listId   strictly greater than the distributor's current listId (contract rejects otherwise)
//   rootHex  64 hex chars (optionally 0x-prefixed): the cumulative Merkle root of this list
//
// Signer must be the distributor's publisher (default: keeper; A9_SIGNER_WALLET selects the wallet).
// Address: JUNXIANG_DISTRIBUTOR_ADDRESS env or deploy/junxiang-distributor.addr.
// Ops rule: fund the distributor's A9 jetton wallet with >= the new list total BEFORE publishing
// the root (a short wallet makes payouts bounce). 80_admin_ops.mjs checks this before broadcast.
// Dry-run by default; broadcast with OPS_EXECUTE=1 OPS_CONFIRM=YES + --net <network>.
//
// Example (dry run):
//   acton script scripts/deploy/junxiang_op.tolk junxiang-set-root 3 0x<64 hex>

import "@acton/fmt"
import "@acton/io"
import "@acton/testing/assert"
import "@acton/emulation/scripts"
import "@stdlib/strings"
import "actions"

const OP_JUNXIANG_SET_ROOT_CODE: uint32 = 0x4a580001; // SetRoot (publisher -> distributor)

fun main(op: string, listId: int, rootHex: string) {
    // Acton passes script string args as slices; format() materialises a real string.
    val opName = format("{}", op);
    if (!opName.equalTo("junxiang-set-root")) {
        Assert.fail(format("unknown op: {} (expected junxiang-set-root)", opName));
    }
    if (listId <= 0 || listId > 4294967295) {
        Assert.fail(format("listId must be 1..4294967295, got {}", listId));
    }
    val distributor = resolveAddress(
        "JUNXIANG_DISTRIBUTOR_ADDRESS",
        "deploy/junxiang-distributor.addr",
        "JunxiangDistributor",
    );
    val signer = scripts.wallet(signerName());
    val root = parseDigestHex(format("{}", rootHex), "rootHex");
    val msg = buildJunxiangSetRoot(distributor, listId as uint32, root);

    println("junxiang_op:");
    println("  signer      = {}", signer.address);
    println("  wallet name = {}", signerName());
    println("  op          = {} (SetRoot)", opName);
    println("  listId      = {}", listId);
    println("  root        = 0x{:x}", root);
    printSummary("  message", distributor, ton("0.1"), OP_JUNXIANG_SET_ROOT_CODE, msg);
    broadcastOrDryRun(signer.address, msg);
}
