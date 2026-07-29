// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { FidensurTestBase } from "./helpers/FidensurTestBase.sol";
import { Fidensur } from "../contracts/Fidensur.sol";
import { Ownable } from "../contracts/utils/Ownable.sol";
import { ITeeExtensionRegistry } from "../contracts/interfaces/ITeeExtensionRegistry.sol";
import { MockTeeExtensionRegistry } from "./mocks/MockTeeRegistry.sol";

/// @notice Round lifecycle: creation, funding, commitment, dispatch, retry, cancellation.
contract FidensurLifecycleTest is FidensurTestBase {
    bytes internal ciphertext = hex"deadbeefcafe";

    // -----------------------------------------------------------------
    // Setup and configuration
    // -----------------------------------------------------------------

    function test_setUp_discoversExtensionIdAboveReservedRange() public view {
        // Public extension IDs begin at 0x10000; anything at or below that means the discovery scan
        // started in the reserved range.
        assertGe(fidensur.extensionId(), 0x10000, "extension id must be in the public range");
    }

    function test_setExtensionId_revertsOnSecondCall() public {
        vm.expectRevert(Fidensur.ExtensionIdAlreadySet.selector);
        fidensur.setExtensionId();
    }

    function test_setExtensionId_revertsWhenSenderNotRegistered() public {
        Fidensur fresh = new Fidensur(extRegistry, machineRegistry, owner);
        vm.expectRevert(Fidensur.ExtensionIdNotFound.selector);
        fresh.setExtensionId();
    }

    function test_setTeeAddress_onlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.NotOwner.selector, outsider));
        fidensur.setTeeAddress(outsider);
    }

    function test_setTeeAddress_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(Fidensur.ZeroAddress.selector);
        fidensur.setTeeAddress(address(0));
    }

    function test_constructor_rejectsRegistryWithoutCode() public {
        vm.expectRevert(abi.encodeWithSelector(Fidensur.NoCode.selector, address(0xdead)));
        new Fidensur(ITeeExtensionRegistry(address(0xdead)), machineRegistry, owner);
    }

    // -----------------------------------------------------------------
    // Creation and funding
    // -----------------------------------------------------------------

    function test_createRound_setsOpenStatus() public {
        vm.prank(org);
        uint256 id = fidensur.createRound(address(0), CLAIM_WINDOW);

        Fidensur.Round memory r = fidensur.getRound(id);
        assertEq(uint8(r.status), uint8(Fidensur.RoundStatus.Open));
        assertEq(r.organization, org);
        assertEq(r.token, address(0));
        assertEq(r.claimWindow, CLAIM_WINDOW);
        assertEq(r.funded, 0);
    }

    function test_createRound_rejectsOutOfRangeClaimWindow() public {
        vm.startPrank(org);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.InvalidClaimWindow.selector, uint48(1 minutes)));
        fidensur.createRound(address(0), 1 minutes);

        vm.expectRevert(abi.encodeWithSelector(Fidensur.InvalidClaimWindow.selector, uint48(400 days)));
        fidensur.createRound(address(0), 400 days);
        vm.stopPrank();
    }

    function test_fund_native_accumulatesAndTracksOutstanding() public {
        vm.startPrank(org);
        uint256 id = fidensur.createRound(address(0), CLAIM_WINDOW);
        fidensur.fund{value: 3 ether}(id, 3 ether);
        fidensur.fund{value: 2 ether}(id, 2 ether);
        vm.stopPrank();

        assertEq(fidensur.getRound(id).funded, 5 ether);
        assertEq(fidensur.outstanding(address(0)), 5 ether);
        assertEq(address(fidensur).balance, 5 ether);
    }

    function test_fund_native_rejectsValueMismatch() public {
        vm.startPrank(org);
        uint256 id = fidensur.createRound(address(0), CLAIM_WINDOW);
        vm.expectRevert(); // SafeTransfer.UnexpectedNativeValue
        fidensur.fund{value: 1 ether}(id, 2 ether);
        vm.stopPrank();
    }

    function test_fund_erc20_rejectsAttachedNativeValue() public {
        vm.startPrank(org);
        uint256 id = fidensur.createRound(address(token), CLAIM_WINDOW);
        token.approve(address(fidensur), 100e18);
        vm.expectRevert(); // SafeTransfer.UnexpectedNativeValue
        fidensur.fund{value: 1 wei}(id, 100e18);
        vm.stopPrank();
    }

    function test_fund_isPermissionless() public {
        vm.prank(org);
        uint256 id = fidensur.createRound(address(0), CLAIM_WINDOW);

        // A round may be sponsored by a third party; only allocation is organization-gated.
        vm.prank(outsider);
        fidensur.fund{value: 1 ether}(id, 1 ether);

        assertEq(fidensur.getRound(id).funded, 1 ether);
    }

    function test_fund_rejectsZeroAmount() public {
        uint256 id = createFundedRound(1 ether);
        vm.prank(org);
        vm.expectRevert(Fidensur.ZeroAmount.selector);
        fidensur.fund{value: 0}(id, 0);
    }

    // -----------------------------------------------------------------
    // Policy commitment
    // -----------------------------------------------------------------

    function test_submitPolicy_movesToCommitted() public {
        uint256 id = createFundedRound(10 ether);

        vm.prank(org);
        fidensur.submitPolicy(id, keccak256(ciphertext));

        Fidensur.Round memory r = fidensur.getRound(id);
        assertEq(uint8(r.status), uint8(Fidensur.RoundStatus.Committed));
        assertEq(r.policyCommitment, keccak256(ciphertext));
    }

    function test_submitPolicy_onlyOrganization() public {
        uint256 id = createFundedRound(10 ether);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.NotOrganization.selector, outsider, org));
        fidensur.submitPolicy(id, keccak256(ciphertext));
    }

    function test_submitPolicy_requiresFunding() public {
        vm.startPrank(org);
        uint256 id = fidensur.createRound(address(0), CLAIM_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.NothingFunded.selector, id));
        fidensur.submitPolicy(id, keccak256(ciphertext));
        vm.stopPrank();
    }

    function test_submitPolicy_rejectsEmptyCommitment() public {
        uint256 id = createFundedRound(10 ether);
        vm.prank(org);
        vm.expectRevert(Fidensur.EmptyCommitment.selector);
        fidensur.submitPolicy(id, bytes32(0));
    }

    // -----------------------------------------------------------------
    // Dispatch — T1: the policy cannot be swapped after commitment
    // -----------------------------------------------------------------

    function test_requestCompute_dispatchesCorrectInstruction() public {
        uint256 id = createFundedRound(10 ether);
        dispatchCompute(id, ciphertext);

        MockTeeExtensionRegistry.SentInstruction memory sent = extRegistry.lastSent();
        assertEq(sent.caller, address(fidensur), "registry must see the contract as caller");
        assertEq(sent.opType, fidensur.OP_TYPE_ALLOC());
        assertEq(sent.opCommand, fidensur.OP_COMMAND_COMPUTE());
        assertEq(sent.message, ciphertext, "raw ciphertext is the instruction payload");
        assertEq(sent.claimBackAddress, org, "fee refunds return to the caller");

        Fidensur.Round memory r = fidensur.getRound(id);
        assertEq(uint8(r.status), uint8(Fidensur.RoundStatus.Computing));
        assertTrue(r.computeInstructionId != bytes32(0));
    }

    /// @dev T1 — an organization must not be able to substitute the policy after committing.
    function test_requestCompute_rejectsCiphertextThatDoesNotMatchCommitment() public {
        uint256 id = createFundedRound(10 ether);

        vm.startPrank(org);
        fidensur.submitPolicy(id, keccak256(ciphertext));

        bytes memory swapped = hex"0badc0de";
        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.CiphertextMismatch.selector, keccak256(swapped), keccak256(ciphertext)
            )
        );
        fidensur.requestCompute(id, swapped);
        vm.stopPrank();
    }

    function test_requestCompute_onlyOrganization() public {
        uint256 id = createFundedRound(10 ether);
        vm.prank(org);
        fidensur.submitPolicy(id, keccak256(ciphertext));

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.NotOrganization.selector, outsider, org));
        fidensur.requestCompute(id, ciphertext);
    }

    function test_requestCompute_requiresCommittedStatus() public {
        uint256 id = createFundedRound(10 ether);
        vm.prank(org);
        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector, id, Fidensur.RoundStatus.Open, Fidensur.RoundStatus.Committed
            )
        );
        fidensur.requestCompute(id, ciphertext);
    }

    function test_requestCompute_forwardsFeeToRegistry() public {
        extRegistry.setFee(0.5 ether);
        uint256 id = createFundedRound(10 ether);

        vm.startPrank(org);
        fidensur.submitPolicy(id, keccak256(ciphertext));
        fidensur.requestCompute{value: 0.5 ether}(id, ciphertext);
        vm.stopPrank();

        assertEq(extRegistry.lastSent().value, 0.5 ether);
        // Round funding is untouched by the fee.
        assertEq(fidensur.getRound(id).funded, 10 ether);
    }

    function test_requestCompute_revertsWhenFeeUnderpaid() public {
        extRegistry.setFee(1 ether);
        uint256 id = createFundedRound(10 ether);

        vm.startPrank(org);
        fidensur.submitPolicy(id, keccak256(ciphertext));
        vm.expectRevert(
            abi.encodeWithSelector(MockTeeExtensionRegistry.InsufficientFee.selector, 0, 1 ether)
        );
        fidensur.requestCompute(id, ciphertext);
        vm.stopPrank();
    }

    function test_requestCompute_revertsWithNoRegisteredTee() public {
        machineRegistry.setMachines(new address[](0));
        uint256 id = createFundedRound(10 ether);

        vm.startPrank(org);
        fidensur.submitPolicy(id, keccak256(ciphertext));
        vm.expectRevert(Fidensur.NoTeeAvailable.selector);
        fidensur.requestCompute(id, ciphertext);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // Retry — T12: a lost result must not strand a round forever
    // -----------------------------------------------------------------

    function test_requestCompute_retryRejectedBeforeTimeout() public {
        uint256 id = createFundedRound(10 ether);
        dispatchCompute(id, ciphertext);

        uint48 requestedAt = fidensur.getRound(id).computeRequestedAt;
        // Read the constant before pranking: a call made while building the expectRevert argument
        // would consume the prank, and requestCompute would then arrive from the test contract.
        uint48 earliest = requestedAt + fidensur.COMPUTE_RETRY_TIMEOUT();

        vm.warp(block.timestamp + 29 minutes);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.RetryTooSoon.selector, requestedAt, earliest));
        vm.prank(org);
        fidensur.requestCompute(id, ciphertext);
    }

    function test_requestCompute_retryAllowedAfterTimeoutAndSupersedesInstruction() public {
        uint256 id = createFundedRound(10 ether);
        bytes32 firstInstruction = dispatchCompute(id, ciphertext);

        vm.warp(block.timestamp + 31 minutes);
        vm.prank(org);
        fidensur.requestCompute(id, ciphertext);

        bytes32 secondInstruction = roundInstructionId(id);
        assertTrue(secondInstruction != firstInstruction, "retry must supersede the instruction id");
        assertEq(extRegistry.sentCount(), 2);
    }

    // -----------------------------------------------------------------
    // Cancellation
    // -----------------------------------------------------------------

    function test_cancelRound_refundsFromOpen() public {
        uint256 id = createFundedRound(4 ether);
        uint256 before = org.balance;

        vm.prank(org);
        fidensur.cancelRound(id);

        assertEq(org.balance, before + 4 ether);
        assertEq(fidensur.outstanding(address(0)), 0);
        assertEq(uint8(fidensur.getRound(id).status), uint8(Fidensur.RoundStatus.Cancelled));
    }

    function test_cancelRound_refundsFromCommitted() public {
        uint256 id = createFundedRound(4 ether);
        vm.startPrank(org);
        fidensur.submitPolicy(id, keccak256(ciphertext));
        fidensur.cancelRound(id);
        vm.stopPrank();

        assertEq(uint8(fidensur.getRound(id).status), uint8(Fidensur.RoundStatus.Cancelled));
    }

    /// @dev Once computing, a signed result may already exist. Allowing cancellation here would let
    ///      an organization race the relay to void an allocation it had already committed to.
    function test_cancelRound_rejectedOnceComputing() public {
        uint256 id = createFundedRound(4 ether);
        dispatchCompute(id, ciphertext);

        vm.prank(org);
        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector, id, Fidensur.RoundStatus.Computing, Fidensur.RoundStatus.Open
            )
        );
        fidensur.cancelRound(id);
    }

    function test_cancelRound_onlyOrganization() public {
        uint256 id = createFundedRound(4 ether);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.NotOrganization.selector, outsider, org));
        fidensur.cancelRound(id);
    }

    // -----------------------------------------------------------------
    // Missing rounds
    // -----------------------------------------------------------------

    function test_getRound_revertsForUnknownRound() public {
        vm.expectRevert(abi.encodeWithSelector(Fidensur.NoSuchRound.selector, uint256(99)));
        fidensur.getRound(99);
    }
}
