// TEP-74 / TEP-89 exit codes + A9 mint-once guards
enum JettonErrors {
    BalanceError = 47
    NotEnoughGas = 48
    InvalidMessage = 49
    InvalidOp = 72
    NotOwner = 73
    NotValidWallet = 74
    WrongWorkchain = 333
    // A9: mint 100 亿 exactly once, then admin is cleared
    MintClosed = 75
    MintAmountMismatch = 76
    InvalidMintMessage = 77
}
