// Deploy an Acton-configured wallet account (v4r2) by sending state init from deployer.
// Usage: acton script --manifest-path contracts/Acton.toml --net <net> ops/scripts/tolk/deploy_wallet.tolk <walletName>
import "@stdlib/strings"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@stdlib/tvm-dicts"
import "@stdlib/common"
import "@contracts/types"

const WALLET_CODE_BASE64: string = "te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIDAgFIBAUE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNBgcCASAICQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAKCwBZvSQrb2omhAgKBrkPoCGEcNQICEekk30pkQzmkD6f+YN4EoAbeBAUiYcVnzGEAgFYDA0AEbjJftRNDXCx+AA9sp37UTQgQFA1yH0BDACyMoHy//J0AGBAQj0Cm+hMYAIBIA4PABmtznaiaEAga5Drhf/AABmvHfaiaEAQa5DrhY/AAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVGliJeU=";

fun main(walletName: string) {
    val deployer = scripts.wallet("deployer");
    val target = scripts.wallet(walletName);
    val code = parseCellFromBase64(WALLET_CODE_BASE64);
    val data = beginCell()
        .storeUint(0, 32) // seqno
        .storeUint(target.walletId(), 32)
        .storeUint(target.publicKey(), 256)
        .storeDict(createEmptyDict())
        .endCell();
    net.send(deployer.address, createMessage({
        bounce: false,
        value: ton("0.1"),
        dest: { stateInit: ContractState { code, data } },
        body: TopUpTons {},
    })).waitForTrace();
    println("wallet {} deployed/initialized at {}", walletName, target.address);
}
