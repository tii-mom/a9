import "@stdlib/strings"

struct WalletStorage {
    jettonBalance: coins
    ownerAddress: address
    minterAddress: address
}

// Jetton Master storage. wallet code is embedded in the master code via
// @gen/JettonWallet.code (TEP-89 style), so it is not duplicated in data.
struct MasterStorage {
    totalSupply: coins
    adminAddress: address?
    nextAdminAddress: address?
    metadata: cell
}

fun MasterStorage.load(): MasterStorage {
    return MasterStorage.fromCell(contract.getData());
}

fun MasterStorage.save(self) {
    contract.setData(self.toCell());
}

fun WalletStorage.load(): WalletStorage {
    return WalletStorage.fromCell(contract.getData());
}

fun WalletStorage.save(self) {
    contract.setData(self.toCell());
}

struct JettonWalletDataReply {
    jettonBalance: coins
    ownerAddress: address
    minterAddress: address
    jettonWalletCode: cell
}

struct JettonDataReply {
    totalSupply: int
    mintable: bool
    adminAddress: address?
    jettonContent: Cell<OnchainMetadataReply>
    jettonWalletCode: cell
}

struct (0x00) OnchainMetadataReply {
    contentDict: map<uint256, string_prefixed0x>
}
