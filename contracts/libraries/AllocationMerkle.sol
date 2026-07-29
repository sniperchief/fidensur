// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title AllocationMerkle
/// @notice Leaf encoding and proof verification for confidential allocation tables.
///
/// @dev The Merkle root is the only thing about an allocation table that reaches the chain. It
///      commits to every (recipient, amount) pair while revealing none of them, and lets a single
///      recipient prove their own entry without touching anybody else's.
///
///      **Leaf encoding.** Leaves are double-hashed:
///
///      ```
///      leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, index, recipient, amount))))
///      ```
///
///      The outer hash is the standard second-preimage defence. Internal nodes are the hash of two
///      concatenated 32-byte words, so without it an attacker could present a 64-byte internal node
///      as if it were leaf preimage data. Double-hashing makes the leaf domain structurally
///      distinct from the node domain.
///
///      `roundId` is inside the leaf so a proof valid in one round cannot be replayed against
///      another round that happens to share a root. `recipient` is inside the leaf so a leaked
///      proof is worthless to anyone but its owner — the claim function passes `msg.sender`, not a
///      caller-supplied address.
///
///      **Internal nodes** use sorted-pair hashing (the OpenZeppelin convention), so a proof is a
///      bare sibling list with no direction bits. The Go engine builds trees the same way; see
///      `extension/internal/engine/merkle.go`.
library AllocationMerkle {
    /// @notice Computes the leaf hash for one allocation table entry.
    /// @param _roundId   Round the allocation belongs to.
    /// @param _index     Position assigned by the engine, after sorting recipients by address.
    /// @param _recipient Address entitled to claim.
    /// @param _amount    Allocation, in the round's token units.
    function leafHash(
        uint256 _roundId,
        uint256 _index,
        address _recipient,
        uint256 _amount
    ) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(_roundId, _index, _recipient, _amount))));
    }

    /// @notice Verifies a Merkle proof against a root.
    /// @param _proof Sibling hashes, leaf level first.
    function verifyLeaf(
        bytes32 _root,
        bytes32 _leaf,
        bytes32[] calldata _proof
    ) internal pure returns (bool) {
        bytes32 computed = _leaf;
        uint256 length = _proof.length;
        for (uint256 i = 0; i < length; ++i) {
            computed = _hashPair(computed, _proof[i]);
        }
        return computed == _root;
    }

    /// @notice Verifies that `_recipient` is entitled to `_amount` at `_index` in `_root`.
    function verify(
        bytes32 _root,
        uint256 _roundId,
        uint256 _index,
        address _recipient,
        uint256 _amount,
        bytes32[] calldata _proof
    ) internal pure returns (bool) {
        // A zero root means "not finalized"; treat it as unverifiable rather than letting an empty
        // proof against an empty root succeed.
        if (_root == bytes32(0)) return false;
        return verifyLeaf(_root, leafHash(_roundId, _index, _recipient, _amount), _proof);
    }

    /// @notice Commutative pair hash — order-independent, so proofs need no direction bits.
    function _hashPair(bytes32 _a, bytes32 _b) private pure returns (bytes32) {
        return _a < _b ? _efficientHash(_a, _b) : _efficientHash(_b, _a);
    }

    /// @notice `keccak256(abi.encodePacked(a, b))` without allocating memory.
    function _efficientHash(bytes32 _a, bytes32 _b) private pure returns (bytes32 value) {
        assembly {
            mstore(0x00, _a)
            mstore(0x20, _b)
            value := keccak256(0x00, 0x40)
        }
    }
}
