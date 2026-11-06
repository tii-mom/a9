// A9 军饷 distributor — shared types (docs/35 §4.4).
//
// Cumulative Merkle model: every published root commits, per wallet, its LIFETIME total
// owed. A per-wallet ClaimRecord stores what was already paid; a claim pays
// cumulative - claimed. Only the latest root matters; storage never grows in the
// distributor (one small record contract per claimant).
//
// Leaf   = sha256( wc:int8 || addrHash:uint256 || cumulative:uint128 )   (49 bytes)
// Parent = sha256( min(a,b) || max(a,b) )                                 (sorted pair)
// Proof  = sibling hashes bottom-up, packed 3 x uint256 per cell, next cell in ref 0.

struct DistributorCodes {
    jettonWalletCode: cell
    recordCode: cell
}

struct DistributorStorage {
    // single hot key that publishes weekly roots (same trust model as the keeper)
    publisher: address
    jettonMaster: address
    codes: Cell<DistributorCodes>
    root: uint256
    listId: uint32
    totalPaidRaw: uint128
}

struct RecordStorage {
    distributor: address
    owner: address
    claimedRaw: uint128
}

fun calcDeployedRecord(distributor: address, owner: address, recordCode: cell): AutoDeployAddress {
    val empty: RecordStorage = { distributor, owner, claimedRaw: 0 };
    return { stateInit: { code: recordCode, data: empty.toCell() } };
}

fun calcRecordAddress(distributor: address, owner: address, recordCode: cell): address {
    return calcDeployedRecord(distributor, owner, recordCode).calculateAddress();
}

fun junxiangLeaf(owner: address, cumulative: uint128): uint256 {
    val (wc, hash) = owner.getWorkchainAndHash();
    return beginCell().storeInt(wc, 8).storeUint(hash, 256).storeUint(cumulative, 128).toSlice().bitsHash();
}

fun hashPair(a: uint256, b: uint256): uint256 {
    val lo = a < b ? a : b;
    val hi = a < b ? b : a;
    return beginCell().storeUint(lo, 256).storeUint(hi, 256).toSlice().bitsHash();
}

// Walks the packed proof; at most 32 levels (2^32 leaves).
fun merkleRootOf(leaf: uint256, proof: cell?): uint256 {
    var node = leaf;
    var next = proof;
    var levels = 0;
    while (next != null) {
        var cs = next!.beginParse();
        while (cs.remainingBitsCount() >= 256) {
            node = hashPair(node, cs.loadUint(256));
            levels += 1;
        }
        next = cs.remainingRefsCount() > 0 ? cs.loadRef() : null;
        assert (levels <= 32) throw 260;
    }
    return node;
}

// publisher -> distributor
struct (0x4a580001) SetRoot {
    queryId: uint64
    listId: uint32
    root: uint256
}

// claimant -> distributor
struct (0x4a580002) ClaimJunxiang {
    queryId: uint64
    cumulativeRaw: uint128
    proof: cell?
}

// distributor -> record (deploys it)
struct (0x4a580003) RecordAdvance {
    queryId: uint64
    cumulativeRaw: uint128
}

// record -> distributor: pay this increase to owner
struct (0x4a580004) RecordPay {
    queryId: uint64
    owner: address
    amountRaw: uint128
    cumulativeRaw: uint128
}

struct (0x4a580101) RootPublished {
    listId: uint32
    root: uint256
}

struct (0x4a580102) JunxiangClaimed {
    owner: address
    amountRaw: uint128
    cumulativeRaw: uint128
}

struct DistributorView {
    publisher: address
    root: uint256
    listId: uint32
    totalPaidRaw: uint128
}

struct RecordView {
    distributor: address
    owner: address
    claimedRaw: uint128
}
