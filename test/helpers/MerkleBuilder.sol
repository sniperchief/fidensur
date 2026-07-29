// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Builds sorted-pair Merkle trees and proofs in tests.
/// @dev This is a deliberate second implementation of the tree construction, independent of both
///      `AllocationMerkle` (which only verifies) and the Go engine (which only builds). A proof
///      generated here and accepted by the contract confirms the two agree.
///
///      Conventions that must stay identical to `extension/internal/engine/merkle.go`:
///        - internal nodes hash the sorted pair, so proofs carry no direction bits;
///        - a level with an odd number of nodes promotes the last node unchanged to the next level
///          (it is not duplicated, and it is not paired with a zero hash).
library MerkleBuilder {
    /// @notice Computes the root of a tree over `_leaves`.
    function root(bytes32[] memory _leaves) internal pure returns (bytes32) {
        require(_leaves.length > 0, "MerkleBuilder: no leaves");
        bytes32[] memory level = _leaves;
        while (level.length > 1) {
            level = _nextLevel(level);
        }
        return level[0];
    }

    /// @notice Produces the proof for the leaf at `_index`.
    function proof(bytes32[] memory _leaves, uint256 _index) internal pure returns (bytes32[] memory) {
        require(_index < _leaves.length, "MerkleBuilder: index out of range");

        bytes32[] memory scratch = new bytes32[](256);
        uint256 count = 0;

        bytes32[] memory level = _leaves;
        uint256 idx = _index;

        while (level.length > 1) {
            uint256 sibling = idx ^ 1;
            // A promoted odd node has no sibling at this level, so it contributes nothing.
            if (sibling < level.length) {
                scratch[count++] = level[sibling];
            }
            level = _nextLevel(level);
            idx >>= 1;
        }

        bytes32[] memory out = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            out[i] = scratch[i];
        }
        return out;
    }

    function _nextLevel(bytes32[] memory _level) private pure returns (bytes32[] memory next) {
        uint256 n = (_level.length + 1) / 2;
        next = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 left = 2 * i;
            uint256 right = left + 1;
            next[i] = right < _level.length ? hashPair(_level[left], _level[right]) : _level[left];
        }
    }

    function hashPair(bytes32 _a, bytes32 _b) internal pure returns (bytes32) {
        return _a < _b ? keccak256(abi.encodePacked(_a, _b)) : keccak256(abi.encodePacked(_b, _a));
    }
}
