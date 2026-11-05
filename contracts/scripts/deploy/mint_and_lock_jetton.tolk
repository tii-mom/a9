// Mint 100 亿 A9 once and permanently close mint (TEP-74 master policy).
// Positional CLI (Acton):
//   acton script scripts/deploy/mint_and_lock_jetton.tolk <master_address> <treasury_address> <amount_raw>
//
// <treasury_address> must be the current master admin; <amount_raw> must be exactly 100 亿 A9.

import "@acton/emulation/network"
import "@acton/io"
import "@contracts/jetton/storage"

const TOTAL_SUPPLY_RAW: coins = 10000000000000000000; // 100 亿 A9

fun main(master: address, treasury: address, amount: int) {
    assert (amount == TOTAL_SUPPLY_RAW) throw 100;

    val body = beginCell()
        .storeUint(0x00000015, 32) // MintOnce (TEP-74 mint op 21)
        .storeUint(0, 64)
        .storeAddress(treasury)
        .storeCoins(ton("0.4"))
        .storeCoins(TOTAL_SUPPLY_RAW)
        .storeCoins(ton("0.5"))
        .storeUint(0, 1) // forward_payload inline empty
        .endCell();

    val res = net.send(treasury, createMessage({
        bounce: true,
        value: ton("0.55"),
        dest: master,
        body,
    }));
    res.waitForTrace();

    val data = net.runGetMethod<JettonDataReply>(master, "get_jetton_data");
    println("total_supply = {}", data.totalSupply);
    println("mintable     = {}", data.mintable);
    assert (data.totalSupply == TOTAL_SUPPLY_RAW) throw 101;
    assert (!data.mintable) throw 102;
}
