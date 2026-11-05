// Deploy the A9 Jetton Master (TEP-74). Positional CLI (Acton):
//   acton script scripts/deploy/deploy_jetton_master.tolk <treasury_address> <amount_raw>
//
// treasury_address becomes the master admin until the one-shot mint closes it.
// After a successful deploy the address is also written to deploy/jetton-master.addr.

import "@stdlib/strings"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@acton/fs"
import "@contracts/jetton/storage"

const TOTAL_SUPPLY_RAW: coins = 10000000000000000000; // 100 亿 A9

fun main(treasury: address, amount: int) {
    assert (amount == TOTAL_SUPPLY_RAW) throw 100;

    val deployer = scripts.wallet("deployer");
    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("uri".sha256(), "https://a9.lat/a9.json".prefixWith00());

    val storage = MasterStorage {
        totalSupply: 0,
        adminAddress: treasury,
        nextAdminAddress: null,
        metadata: metadata.toCell(),
    };
    val init = ContractState { code: build("JettonMaster"), data: storage.toCell() };
    val addr = AutoDeployAddress { stateInit: init }.calculateAddress();

    val ok = fs.writeString("deploy/jetton-master.addr", format("{}\n", addr));
    net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("5"),
        dest: { stateInit: init },
        body: beginCell().storeUint(0xd372158c, 32).endCell(),
    })).waitForTrace();

    println("JettonMaster deployed at {}", addr);
    println("address file written: {}", ok);
}
