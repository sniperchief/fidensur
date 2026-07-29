// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { FidensurTestBase } from "./helpers/FidensurTestBase.sol";
import { Fidensur } from "../contracts/Fidensur.sol";
import { MockTeeExtensionRegistry } from "./mocks/MockTeeRegistry.sol";

/// @notice Disclosure and attestation instructions — threat T7.
///
/// @dev The security property under test is that the *contract*, not the caller, decides who the
///      requester is. Because the registry guarantees this contract is the extension's only
///      instruction sender, whatever it stamps into the payload is authenticated as far as the
///      enclave is concerned — so it must stamp `msg.sender` and nothing caller-supplied.
contract FidensurDisclosureTest is FidensurTestBase {
    bytes internal ciphertext = hex"abcdef";
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// @dev A 33-byte compressed secp256k1 public key.
    bytes internal compressedKey =
        hex"02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    /// @dev A 65-byte uncompressed secp256k1 public key.
    bytes internal uncompressedKey =
        hex"04a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    function _computingRound() internal returns (uint256 roundId) {
        roundId = createFundedRound(10 ether);
        dispatchCompute(roundId, ciphertext);
    }

    // -----------------------------------------------------------------
    // Requester authentication — T7
    // -----------------------------------------------------------------

    /// @dev The whole basis for the enclave trusting the requester field.
    function test_requestDisclosure_stampsCallerAsRequester() public {
        uint256 id = _computingRound();

        vm.prank(alice);
        fidensur.requestDisclosure(id, compressedKey);

        MockTeeExtensionRegistry.SentInstruction memory sent = extRegistry.lastSent();
        assertEq(sent.opType, fidensur.OP_TYPE_ALLOC());
        assertEq(sent.opCommand, fidensur.OP_COMMAND_DISCLOSE());

        Fidensur.DiscloseMessage memory msg_ = abi.decode(sent.message, (Fidensur.DiscloseMessage));
        assertEq(msg_.requester, alice, "requester must be the caller, not a parameter");
        assertEq(msg_.roundId, id);
        assertEq(msg_.contractAddr, address(fidensur));
        assertEq(msg_.policyCommitment, keccak256(ciphertext));
        assertEq(msg_.disclosureKey, compressedKey);
    }

    /// @dev Bob cannot request Alice's entry: there is no parameter through which to name her.
    ///      The only identity the enclave sees is the caller's.
    function test_requestDisclosure_cannotNameAnotherRecipient() public {
        uint256 id = _computingRound();

        vm.prank(bob);
        fidensur.requestDisclosure(id, compressedKey);

        Fidensur.DiscloseMessage memory msg_ =
            abi.decode(extRegistry.lastSent().message, (Fidensur.DiscloseMessage));
        assertEq(msg_.requester, bob, "bob can only ever ask about bob");
        assertTrue(msg_.requester != alice);
    }

    function test_requestDisclosure_isPermissionless() public {
        uint256 id = _computingRound();

        // Anyone may ask; the enclave answers only if they are actually in the allocation table.
        vm.prank(outsider);
        fidensur.requestDisclosure(id, compressedKey);

        assertEq(extRegistry.sentCount(), 2, "compute + disclosure");
    }

    // -----------------------------------------------------------------
    // Key validation
    // -----------------------------------------------------------------

    function test_requestDisclosure_acceptsBothKeyFormats() public {
        uint256 id = _computingRound();

        vm.startPrank(alice);
        fidensur.requestDisclosure(id, compressedKey);
        fidensur.requestDisclosure(id, uncompressedKey);
        vm.stopPrank();

        assertEq(extRegistry.sentCount(), 3);
    }

    function test_requestDisclosure_rejectsMalformedKey() public {
        uint256 id = _computingRound();

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.InvalidDisclosureKey.selector, uint256(0)));
        fidensur.requestDisclosure(id, hex"");

        vm.expectRevert(abi.encodeWithSelector(Fidensur.InvalidDisclosureKey.selector, uint256(3)));
        fidensur.requestDisclosure(id, hex"010203");
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // Status gating
    // -----------------------------------------------------------------

    /// @dev Allowed while computing: a recipient may reasonably want their entry before anyone has
    ///      bothered to relay the finalization transaction.
    function test_requestDisclosure_allowedWhileComputing() public {
        uint256 id = _computingRound();
        vm.prank(alice);
        fidensur.requestDisclosure(id, compressedKey);
        assertEq(extRegistry.sentCount(), 2);
    }

    function test_requestDisclosure_allowedAfterFinalization() public {
        Allocation[] memory allocs = new Allocation[](1);
        allocs[0] = Allocation({recipient: alice, amount: 1 ether});

        uint256 id = createFundedRound(10 ether);
        finalizeWith(id, ciphertext, allocs);

        vm.prank(alice);
        fidensur.requestDisclosure(id, compressedKey);
        assertEq(extRegistry.sentCount(), 2);
    }

    function test_requestDisclosure_rejectedBeforeCompute() public {
        uint256 id = createFundedRound(10 ether);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector, id, Fidensur.RoundStatus.Open, Fidensur.RoundStatus.Finalized
            )
        );
        fidensur.requestDisclosure(id, compressedKey);
    }

    // -----------------------------------------------------------------
    // Attestation re-emission
    // -----------------------------------------------------------------

    function test_requestAttestation_sendsAttestInstruction() public {
        uint256 id = _computingRound();

        fidensur.requestAttestation(id);

        MockTeeExtensionRegistry.SentInstruction memory sent = extRegistry.lastSent();
        assertEq(sent.opCommand, fidensur.OP_COMMAND_ATTEST());

        Fidensur.AttestMessage memory msg_ = abi.decode(sent.message, (Fidensur.AttestMessage));
        assertEq(msg_.roundId, id);
        assertEq(msg_.contractAddr, address(fidensur));
        assertEq(msg_.policyCommitment, keccak256(ciphertext));
    }

    /// @dev The record is public information, and anyone wanting to finalize a stuck round should
    ///      be able to obtain it — including someone the organization would rather not help.
    function test_requestAttestation_isPermissionless() public {
        uint256 id = _computingRound();

        vm.prank(outsider);
        fidensur.requestAttestation(id);

        assertEq(extRegistry.lastSent().opCommand, fidensur.OP_COMMAND_ATTEST());
    }

    function test_requestAttestation_rejectedBeforeCompute() public {
        uint256 id = createFundedRound(10 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector, id, Fidensur.RoundStatus.Open, Fidensur.RoundStatus.Finalized
            )
        );
        fidensur.requestAttestation(id);
    }

    // -----------------------------------------------------------------
    // Fee forwarding
    // -----------------------------------------------------------------

    function test_requestDisclosure_forwardsFeeAndRefundsToCaller() public {
        // Set the fee only after the round is computing, so the setup path itself is unaffected.
        uint256 id = _computingRound();
        extRegistry.setFee(0.1 ether);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        fidensur.requestDisclosure{value: 0.1 ether}(id, compressedKey);

        MockTeeExtensionRegistry.SentInstruction memory sent = extRegistry.lastSent();
        assertEq(sent.value, 0.1 ether);
        assertEq(sent.claimBackAddress, alice, "unused fee returns to whoever paid it");
    }
}
