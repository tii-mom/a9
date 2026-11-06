// Query JettonMaster.get_wallet_address(owner) for one owner.
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/query_one_wallet.tolk <master> <owner>
import "@stdlib/strings"
import "@acton/emulation/network"
import "@acton/io"

fun main(master: address, owner: address) {
    println("JETTON_WALLET={}", net.runGetMethod<address>(master, "get_wallet_address", [owner]));
}
