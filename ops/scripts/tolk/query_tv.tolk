import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun main() {
    val tv = env<address>("TEAM_VAULT_ADDRESS");
    if (tv == null) { throw 400; }
    val c = net.runGetMethod<TeamVaultConfig>(tv!, "get_config", []);
    println("TV admin={} controller={} version={}", c.admin, c.controller, c.configVersion);
}
