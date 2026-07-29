// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { FidensurTestBase } from "./helpers/FidensurTestBase.sol";
import { MerkleBuilder } from "./helpers/MerkleBuilder.sol";
import { Fidensur } from "../contracts/Fidensur.sol";
import { TeeResultVerifier } from "../contracts/libraries/TeeResultVerifier.sol";

/// @notice Finalization and TEE-signature verification — threats T2, T3, T8–T11.
///
/// @dev This is the contract's trust hinge: everything downstream assumes a finalized round really
///      carries a root the attested enclave produced. Each test here corresponds to a numbered
///      threat in docs/architecture.md §9.1.
contract FidensurVerificationTest is FidensurTestBase {
    bytes internal ciphertext = hex"c0ffee";

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// @notice Round in `Computing`, with everything needed to finalize it.
    struct Pending {
        uint256 roundId;
        bytes32 actionId;
        bytes32 commitment;
        bytes32 root;
        uint256 total;
        uint32 count;
    }

    function _pending(uint256 _funding) internal returns (Pending memory p) {
        p.roundId = createFundedRound(_funding);
        p.actionId = dispatchCompute(p.roundId, ciphertext);
        p.commitment = keccak256(ciphertext);

        Allocation[] memory allocs = new Allocation[](2);
        allocs[0] = Allocation({recipient: alice, amount: 3 ether});
        allocs[1] = Allocation({recipient: bob, amount: 2 ether});

        p.root = MerkleBuilder.root(buildLeaves(p.roundId, allocs));
        p.total = 5 ether;
        p.count = 2;
    }

    // -----------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------

    function test_finalizeRound_acceptsGenuineSignature() public {
        Pending memory p = _pending(10 ether);

        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);

        Fidensur.Round memory r = fidensur.getRound(p.roundId);
        assertEq(uint8(r.status), uint8(Fidensur.RoundStatus.Finalized));
        assertEq(r.merkleRoot, p.root);
        assertEq(r.totalAllocated, p.total);
        assertEq(r.recipientCount, p.count);
        assertEq(r.engineVersion, ENGINE_VERSION);
        assertEq(r.claimDeadline, uint48(block.timestamp) + CLAIM_WINDOW);
    }

    /// @dev T3 — an organization must not be able to suppress an outcome it dislikes by simply
    ///      never submitting the transaction.
    function test_finalizeRound_isPermissionless() public {
        Pending memory p = _pending(10 ether);

        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.prank(outsider);
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);

        assertEq(uint8(fidensur.getRound(p.roundId).status), uint8(Fidensur.RoundStatus.Finalized));
    }

    // -----------------------------------------------------------------
    // Signature forgery — T11
    // -----------------------------------------------------------------

    function test_finalizeRound_rejectsSignatureFromUnregisteredKey() public {
        Pending memory p = _pending(10 ether);

        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(rogueTeePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                TeeResultVerifier.UnexpectedSigner.selector, vm.addr(rogueTeePk), teeAddr
            )
        );
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }

    function test_finalizeRound_rejectsTamperedResultData() public {
        Pending memory p = _pending(10 ether);

        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        // Inflate the total after signing; the signature no longer covers this payload.
        bytes memory tampered = encodeResult(p.roundId, p.commitment, p.root, 9 ether, p.count);

        vm.expectRevert(); // UnexpectedSigner — recovery yields some other address
        fidensur.finalizeRound(tampered, p.actionId, SUBMIT_TAG, 1, sig);
    }

    function test_finalizeRound_rejectsMalformedSignatureLength() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);

        vm.expectRevert(abi.encodeWithSelector(TeeResultVerifier.BadSignatureLength.selector, uint256(64)));
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, hex"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
    }

    /// @dev The domain separation is what makes the signature specific to this chain and to the FCC
    ///      result format. Signing the bare result hash — the mistake the research notes flag — must
    ///      not verify.
    function test_finalizeRound_rejectsSignatureOverUndomainSeparatedHash() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);

        bytes32 rawResultHash = keccak256(
            abi.encodePacked(keccak256(data), p.actionId, keccak256(bytes(SUBMIT_TAG)), uint8(1))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", rawResultHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teePk, digest);

        vm.expectRevert();
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, abi.encodePacked(r, s, v));
    }

    /// @dev T8 — a signature produced for another chain must not verify here.
    function test_finalizeRound_rejectsSignatureBoundToAnotherChain() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);

        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(data), p.actionId, keccak256(bytes(SUBMIT_TAG)), uint8(1))
        );
        // Same scheme, wrong chain id.
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), uint256(1), resultHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teePk, digest);

        vm.expectRevert();
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, abi.encodePacked(r, s, v));
    }

    /// @dev The submission tag is inside the signed hash, so relaying with a different tag fails.
    function test_finalizeRound_rejectsMismatchedSubmissionTag() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert();
        fidensur.finalizeRound(data, p.actionId, "threshold", 1, sig);
    }

    // -----------------------------------------------------------------
    // Status handling — T10
    // -----------------------------------------------------------------

    function test_finalizeRound_rejectsFailureStatus() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 0);

        vm.expectRevert(abi.encodeWithSelector(TeeResultVerifier.TeeReportedFailure.selector, uint8(0)));
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 0, sig);
    }

    function test_finalizeRound_rejectsPendingStatus() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 2);

        vm.expectRevert(abi.encodeWithSelector(TeeResultVerifier.TeeReportedFailure.selector, uint8(2)));
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 2, sig);
    }

    // -----------------------------------------------------------------
    // Result binding — T9
    // -----------------------------------------------------------------

    /// @dev T9 — a genuinely signed result for one round must not finalize another.
    function test_finalizeRound_rejectsResultBoundToAnotherRound() public {
        Pending memory first = _pending(10 ether);
        Pending memory second = _pending(10 ether);

        // Signed result targeting `second`, but relayed with `first`'s action id.
        bytes memory data = encodeResult(second.roundId, second.commitment, second.root, second.total, second.count);
        bytes memory sig = signResult(teePk, data, first.actionId, SUBMIT_TAG, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.ResultNotForThisRound.selector, first.actionId, second.actionId
            )
        );
        fidensur.finalizeRound(data, first.actionId, SUBMIT_TAG, 1, sig);
    }

    function test_finalizeRound_rejectsResultForAnotherContract() public {
        Pending memory p = _pending(10 ether);

        bytes memory data = abi.encode(
            address(0xBEEF), p.roundId, p.commitment, p.root, p.total, p.count, ENGINE_VERSION
        );
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert(
            abi.encodeWithSelector(Fidensur.ResultNotForThisContract.selector, address(0xBEEF))
        );
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }

    /// @dev Proves the enclave evaluated the committed ciphertext, not a substituted policy.
    function test_finalizeRound_rejectsMismatchedPolicyCommitment() public {
        Pending memory p = _pending(10 ether);

        bytes32 wrongCommitment = keccak256("some other policy");
        bytes memory data = encodeResult(p.roundId, wrongCommitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.PolicyCommitmentMismatch.selector, wrongCommitment, p.commitment
            )
        );
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }

    /// @dev A retry supersedes the instruction id, so a late result from the abandoned attempt is
    ///      rejected — at most one instruction can ever finalize a round.
    function test_finalizeRound_rejectsSupersededInstructionResult() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory staleSig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.warp(block.timestamp + 31 minutes);
        vm.prank(org);
        fidensur.requestCompute(p.roundId, ciphertext);

        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.ResultNotForThisRound.selector, p.actionId, roundInstructionId(p.roundId)
            )
        );
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, staleSig);
    }

    // -----------------------------------------------------------------
    // Solvency — T2
    // -----------------------------------------------------------------

    /// @dev T2 — the contract must never promise more than it holds, whatever the enclave says.
    ///      This is the backstop against an engine bug or an engine compromise.
    function test_finalizeRound_rejectsOverAllocation() public {
        Pending memory p = _pending(4 ether); // funded with less than the 5 ether allocated

        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert(abi.encodeWithSelector(Fidensur.OverAllocated.selector, 5 ether, 4 ether));
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }

    function test_finalizeRound_rejectsEmptyRoot() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, bytes32(0), p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert(Fidensur.EmptyMerkleRoot.selector);
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }

    function test_finalizeRound_rejectsZeroRecipients() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, 0);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert(Fidensur.NoRecipients.selector);
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }

    // -----------------------------------------------------------------
    // Preconditions
    // -----------------------------------------------------------------

    function test_finalizeRound_revertsWhenTeeAddressUnset() public {
        Fidensur fresh = new Fidensur(extRegistry, machineRegistry, owner);
        extRegistry.registerExtension(address(fresh));
        fresh.setExtensionId();

        vm.expectRevert(Fidensur.TeeAddressNotSet.selector);
        fresh.finalizeRound(hex"00", bytes32(0), SUBMIT_TAG, 1, hex"00");
    }

    function test_finalizeRound_cannotFinalizeTwice() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);

        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector,
                p.roundId,
                Fidensur.RoundStatus.Finalized,
                Fidensur.RoundStatus.Computing
            )
        );
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }

    // -----------------------------------------------------------------
    // The off-chain verification helper the explorer calls
    // -----------------------------------------------------------------

    function test_checkTeeResult_reportsValidAndRecoversSigner() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(teePk, data, p.actionId, SUBMIT_TAG, 1);

        (bool valid, address signer) = fidensur.checkTeeResult(data, p.actionId, SUBMIT_TAG, 1, sig);
        assertTrue(valid);
        assertEq(signer, teeAddr);
    }

    function test_checkTeeResult_reportsInvalidForRogueSigner() public {
        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, p.total, p.count);
        bytes memory sig = signResult(rogueTeePk, data, p.actionId, SUBMIT_TAG, 1);

        (bool valid, address signer) = fidensur.checkTeeResult(data, p.actionId, SUBMIT_TAG, 1, sig);
        assertFalse(valid);
        assertEq(signer, vm.addr(rogueTeePk), "still recovers, so the UI can name the wrong signer");
    }

    // -----------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------

    /// @dev Any key other than the registered one must fail, for any result payload.
    function testFuzz_finalizeRound_rejectsAnyOtherSigner(uint256 _pk, uint256 _total) public {
        _pk = bound(_pk, 1, type(uint128).max);
        vm.assume(vm.addr(_pk) != teeAddr);
        _total = bound(_total, 1, 10 ether);

        Pending memory p = _pending(10 ether);
        bytes memory data = encodeResult(p.roundId, p.commitment, p.root, _total, p.count);
        bytes memory sig = signResult(_pk, data, p.actionId, SUBMIT_TAG, 1);

        vm.expectRevert();
        fidensur.finalizeRound(data, p.actionId, SUBMIT_TAG, 1, sig);
    }
}
