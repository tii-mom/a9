// Query canonical Jetton Wallet addresses from JettonMaster.get_wallet_address(owner).
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/query_wallets.tolk <master> <owner1> <owner2> <owner3> <owner4> <owner5> <owner6>
import "@stdlib/strings"
import "@acton/emulation/network"
import "@acton/io"

fun main(master: address, owner1: address, owner2: address, owner3: address, owner4: address, owner5: address, owner6: address) {
    println("OWNER1={}", net.runGetMethod<address>(master, "get_wallet_address", [owner1]));
    println("OWNER2={}", net.runGetMethod<address>(master, "get_wallet_address", [owner2]));
    println("OWNER3={}", net.runGetMethod<address>(master, "get_wallet_address", [owner3]));
    println("OWNER4={}", net.runGetMethod<address>(master, "get_wallet_address", [owner4]));
    println("OWNER5={}", net.runGetMethod<address>(master, "get_wallet_address", [owner5]));
    println("OWNER6={}", net.runGetMethod<address>(master, "get_wallet_address", [owner6]));
}
