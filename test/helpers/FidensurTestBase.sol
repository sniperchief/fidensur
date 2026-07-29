// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";

import { Fidensur } from "../../contracts/Fidensur.sol";
import { AllocationMerkle } from "../../contracts/libraries/AllocationMerkle.sol";
import { MockTeeExtensionRegistry, MockTeeMachineRegistry } from "../mocks/MockTeeRegistry.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";
import { MerkleBuilder } from "./MerkleBuilder.sol";

/// @notice Shared fixture: a deployed Fidensur wired to mock registries, with a registered TEE
///         machine whose private key the tests hold so they can produce genuine signatures.
abstract contract FidensurTestBase is Test {
    Fidensur internal fidensur;
    MockTeeExtensionRegistry internal extRegistry;
    MockTeeMachineRegistry internal machineRegistry;
    MockERC20 internal token;

    address internal owner = makeAddr("owner");
    address internal org = makeAddr("organization");
    address internal outsider = makeAddr("outsider");

    // The TEE machine's signing identity. Tests sign with `teePk`; the contract is told `teeAddr`.
    uint256 internal teePk = 0xA11CE;
    address internal teeAddr;

    uint256 internal rogueTeePk = 0xBAD;

    uint48 internal constant CLAIM_WINDOW = 7 days;
    string internal constant SUBMIT_TAG = "submit";

    /// @dev The extension's version string, as the engine reports it in `ActionResult.Data`.
    bytes32 internal constant ENGINE_VERSION = bytes32("0.1.0");

    function setUp() public virtual {
        teeAddr = vm.addr(teePk);

        extRegistry = new MockTeeExtensionRegistry();
        machineRegistry = new MockTeeMachineRegistry();
        token = new MockERC20("Mock USD", "mUSD", 18);

        fidensur = new Fidensur(extRegistry, machineRegistry, owner);

        // Registration order mirrors the real deployment: deploy the sender, register it, then let
        // the contract discover the ID it was assigned.
        extRegistry.registerExtension(address(fidensur));
        fidensur.setExtensionId();

        address[] memory machines = new address[](1);
        machines[0] = teeAddr;
        machineRegistry.setMachines(machines);

        vm.prank(owner);
        fidensur.setTeeAddress(teeAddr);

        vm.deal(org, 1_000 ether);
        vm.deal(outsider, 1_000 ether);
        token.mint(org, 1_000_000e18);
    }

    // -----------------------------------------------------------------
    // TEE result construction
    // -----------------------------------------------------------------

    /// @notice ABI-encodes an allocation result exactly as the Go engine does.
    function encodeResult(
        uint256 _roundId,
        bytes32 _policyCommitment,
        bytes32 _merkleRoot,
        uint256 _totalAllocated,
        uint32 _recipientCount
    ) internal view returns (bytes memory) {
        return abi.encode(
            address(fidensur),
            _roundId,
            _policyCommitment,
            _merkleRoot,
            _totalAllocated,
            _recipientCount,
            ENGINE_VERSION
        );
    }

    /// @notice Reproduces the TEE node's signing scheme over an ActionResult.
    /// @dev Written out longhand rather than calling `TeeResultVerifier`, so a bug in the library
    ///      cannot cancel itself out in the tests.
    function signResult(
        uint256 _pk,
        bytes memory _resultData,
        bytes32 _actionId,
        string memory _tag,
        uint8 _status
    ) internal view returns (bytes memory) {
        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(_resultData), _actionId, keccak256(bytes(_tag)), _status)
        );
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), block.chainid, resultHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // -----------------------------------------------------------------
    // Allocation table helpers
    // -----------------------------------------------------------------

    struct Allocation {
        address recipient;
        uint256 amount;
    }

    /// @notice Builds the leaves for an allocation table, in engine order.
    function buildLeaves(uint256 _roundId, Allocation[] memory _allocs)
        internal
        pure
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](_allocs.length);
        for (uint256 i = 0; i < _allocs.length; ++i) {
            leaves[i] = AllocationMerkle.leafHash(_roundId, i, _allocs[i].recipient, _allocs[i].amount);
        }
    }

    function totalOf(Allocation[] memory _allocs) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < _allocs.length; ++i) {
            total += _allocs[i].amount;
        }
    }

    // -----------------------------------------------------------------
    // Round lifecycle shortcuts
    // -----------------------------------------------------------------

    /// @notice Creates and funds a native-token round.
    function createFundedRound(uint256 _amount) internal returns (uint256 roundId) {
        vm.startPrank(org);
        roundId = fidensur.createRound(address(0), CLAIM_WINDOW);
        fidensur.fund{value: _amount}(roundId, _amount);
        vm.stopPrank();
    }

    /// @notice Creates and funds an ERC-20 round.
    function createFundedTokenRound(uint256 _amount) internal returns (uint256 roundId) {
        vm.startPrank(org);
        roundId = fidensur.createRound(address(token), CLAIM_WINDOW);
        token.approve(address(fidensur), _amount);
        fidensur.fund(roundId, _amount);
        vm.stopPrank();
    }

    /// @notice Drives a round from funded to `Computing`, returning the dispatched instruction id.
    function dispatchCompute(uint256 _roundId, bytes memory _ciphertext)
        internal
        returns (bytes32 instructionId)
    {
        vm.startPrank(org);
        fidensur.submitPolicy(_roundId, keccak256(_ciphertext));
        fidensur.requestCompute(_roundId, _ciphertext);
        vm.stopPrank();

        return roundInstructionId(_roundId);
    }

    /// @notice The instruction id currently bound to a round.
    function roundInstructionId(uint256 _roundId) internal view returns (bytes32) {
        return fidensur.getRound(_roundId).computeInstructionId;
    }

    /// @notice Full path from funded round to `Finalized`, using a real signature.
    function finalizeWith(
        uint256 _roundId,
        bytes memory _ciphertext,
        Allocation[] memory _allocs
    ) internal returns (bytes32 root, bytes32[] memory leaves) {
        vm.startPrank(org);
        fidensur.submitPolicy(_roundId, keccak256(_ciphertext));
        fidensur.requestCompute(_roundId, _ciphertext);
        vm.stopPrank();

        bytes32 actionId = roundInstructionId(_roundId);

        leaves = buildLeaves(_roundId, _allocs);
        root = MerkleBuilder.root(leaves);

        bytes memory resultData = encodeResult(
            _roundId, keccak256(_ciphertext), root, totalOf(_allocs), uint32(_allocs.length)
        );
        bytes memory sig = signResult(teePk, resultData, actionId, SUBMIT_TAG, 1);

        fidensur.finalizeRound(resultData, actionId, SUBMIT_TAG, 1, sig);
    }
}
