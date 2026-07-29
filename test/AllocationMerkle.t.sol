// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { AllocationMerkle } from "../contracts/libraries/AllocationMerkle.sol";
import { MerkleBuilder } from "./helpers/MerkleBuilder.sol";

/// @notice Unit tests for the allocation Merkle scheme, independent of the treasury.
/// @dev The tree builder used here (`MerkleBuilder`) is a separate implementation from the verifier
///      under test, and both must agree with the Go engine. A bug that existed in only one of the
///      three shows up as a failure here.
contract AllocationMerkleTest is Test {
    /// @dev Thin wrapper so the internal library functions can take `calldata` proofs.
    function verify(
        bytes32 _root,
        uint256 _roundId,
        uint256 _index,
        address _recipient,
        uint256 _amount,
        bytes32[] calldata _proof
    ) external pure returns (bool) {
        return AllocationMerkle.verify(_root, _roundId, _index, _recipient, _amount, _proof);
    }

    function _leaves(uint256 _roundId, address[] memory _r, uint256[] memory _a)
        internal
        pure
        returns (bytes32[] memory out)
    {
        out = new bytes32[](_r.length);
        for (uint256 i = 0; i < _r.length; ++i) {
            out[i] = AllocationMerkle.leafHash(_roundId, i, _r[i], _a[i]);
        }
    }

    function _fixture(uint256 _n) internal pure returns (address[] memory r, uint256[] memory a) {
        r = new address[](_n);
        a = new uint256[](_n);
        for (uint256 i = 0; i < _n; ++i) {
            r[i] = address(uint160(0x1000 + i));
            a[i] = (i + 1) * 1e18;
        }
    }

    // -----------------------------------------------------------------
    // Structure
    // -----------------------------------------------------------------

    function test_verify_singleLeafTree() public view {
        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = address(0xA11CE);
        a[0] = 42e18;

        bytes32[] memory leaves = _leaves(7, r, a);
        bytes32 root = MerkleBuilder.root(leaves);

        // A one-leaf tree's root is the leaf, and the proof is empty.
        assertEq(root, leaves[0]);
        assertTrue(this.verify(root, 7, 0, r[0], a[0], MerkleBuilder.proof(leaves, 0)));
    }

    /// @dev Odd levels promote the trailing node unchanged. Sizes 1..17 cover every shape where a
    ///      promotion happens at a different depth.
    function test_verify_everyLeafForSizesOneToSeventeen() public view {
        for (uint256 n = 1; n <= 17; ++n) {
            (address[] memory r, uint256[] memory a) = _fixture(n);
            bytes32[] memory leaves = _leaves(1, r, a);
            bytes32 root = MerkleBuilder.root(leaves);

            for (uint256 i = 0; i < n; ++i) {
                assertTrue(
                    this.verify(root, 1, i, r[i], a[i], MerkleBuilder.proof(leaves, i)),
                    string.concat("failed at size ", vm.toString(n), " index ", vm.toString(i))
                );
            }
        }
    }

    // -----------------------------------------------------------------
    // Binding
    // -----------------------------------------------------------------

    function test_leafHash_isBoundToEveryField() public pure {
        bytes32 base = AllocationMerkle.leafHash(1, 0, address(0xA), 100);

        assertTrue(base != AllocationMerkle.leafHash(2, 0, address(0xA), 100), "roundId not bound");
        assertTrue(base != AllocationMerkle.leafHash(1, 1, address(0xA), 100), "index not bound");
        assertTrue(base != AllocationMerkle.leafHash(1, 0, address(0xB), 100), "recipient not bound");
        assertTrue(base != AllocationMerkle.leafHash(1, 0, address(0xA), 101), "amount not bound");
    }

    function test_verify_rejectsWrongRoundId() public view {
        (address[] memory r, uint256[] memory a) = _fixture(4);
        bytes32[] memory leaves = _leaves(1, r, a);
        bytes32 root = MerkleBuilder.root(leaves);

        assertFalse(this.verify(root, 2, 0, r[0], a[0], MerkleBuilder.proof(leaves, 0)));
    }

    function test_verify_rejectsEmptyRoot() public view {
        (address[] memory r, uint256[] memory a) = _fixture(4);
        bytes32[] memory leaves = _leaves(1, r, a);

        // An unfinalized round has a zero root; an empty proof must not satisfy it.
        assertFalse(this.verify(bytes32(0), 1, 0, r[0], a[0], MerkleBuilder.proof(leaves, 0)));
        assertFalse(this.verify(bytes32(0), 1, 0, r[0], a[0], new bytes32[](0)));
    }

    // -----------------------------------------------------------------
    // Second-preimage resistance
    // -----------------------------------------------------------------

    /// @dev The reason leaves are double-hashed. Without the outer hash, an internal node's 64-byte
    ///      preimage could be presented as leaf data and verify against the same root. Here we take
    ///      a real internal node and confirm it is not itself a valid leaf.
    function test_internalNodeIsNotAValidLeaf() public view {
        (address[] memory r, uint256[] memory a) = _fixture(4);
        bytes32[] memory leaves = _leaves(1, r, a);
        bytes32 root = MerkleBuilder.root(leaves);

        bytes32 internalNode = MerkleBuilder.hashPair(leaves[0], leaves[1]);

        // The internal node's sibling would complete a path to the root if the node were accepted
        // as a leaf. It cannot be, because every real leaf carries the extra keccak wrapper.
        bytes32[] memory forged = new bytes32[](1);
        forged[0] = MerkleBuilder.hashPair(leaves[2], leaves[3]);
        assertEq(MerkleBuilder.hashPair(internalNode, forged[0]), root, "fixture sanity: path is real");

        // No (roundId, index, recipient, amount) hashes to the internal node, so no claim can use it.
        assertTrue(
            AllocationMerkle.leafHash(1, 0, r[0], a[0]) != internalNode,
            "leaf domain must not collide with node domain"
        );
    }

    // -----------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------

    function testFuzz_verify_acceptsGenuineProof(uint8 _size, uint8 _target, uint256 _roundId) public view {
        uint256 n = bound(_size, 1, 32);
        uint256 idx = bound(_target, 0, n - 1);

        (address[] memory r, uint256[] memory a) = _fixture(n);
        bytes32[] memory leaves = _leaves(_roundId, r, a);
        bytes32 root = MerkleBuilder.root(leaves);

        assertTrue(this.verify(root, _roundId, idx, r[idx], a[idx], MerkleBuilder.proof(leaves, idx)));
    }

    function testFuzz_verify_rejectsForeignRecipient(uint8 _size, address _stranger) public view {
        uint256 n = bound(_size, 1, 32);
        (address[] memory r, uint256[] memory a) = _fixture(n);
        for (uint256 i = 0; i < n; ++i) {
            vm.assume(_stranger != r[i]);
        }

        bytes32[] memory leaves = _leaves(1, r, a);
        bytes32 root = MerkleBuilder.root(leaves);

        assertFalse(this.verify(root, 1, 0, _stranger, a[0], MerkleBuilder.proof(leaves, 0)));
    }
}
