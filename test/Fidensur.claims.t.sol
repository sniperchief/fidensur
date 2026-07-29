// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { FidensurTestBase } from "./helpers/FidensurTestBase.sol";
import { MerkleBuilder } from "./helpers/MerkleBuilder.sol";
import { Fidensur } from "../contracts/Fidensur.sol";
import { AllocationMerkle } from "../contracts/libraries/AllocationMerkle.sol";
import { MockNoReturnERC20 } from "./mocks/MockERC20.sol";

/// @notice Claiming, sweeping, and the treasury invariants — threats T4–T6, T18–T19.
contract FidensurClaimsTest is FidensurTestBase {
    bytes internal ciphertext = hex"5eed";

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    Allocation[] internal allocs;
    uint256 internal roundId;
    bytes32 internal root;
    bytes32[] internal leaves;

    function setUp() public override {
        super.setUp();

        allocs.push(Allocation({recipient: alice, amount: 3 ether}));
        allocs.push(Allocation({recipient: bob, amount: 2 ether}));
        allocs.push(Allocation({recipient: carol, amount: 1 ether}));

        roundId = createFundedRound(10 ether);
        (root, leaves) = finalizeWith(roundId, ciphertext, allocs);
    }

    function _proof(uint256 _index) internal view returns (bytes32[] memory) {
        return MerkleBuilder.proof(leaves, _index);
    }

    // -----------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------

    function test_claim_paysRecipientAndMarksClaimed() public {
        uint256 before = alice.balance;

        vm.prank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));

        assertEq(alice.balance, before + 3 ether);
        assertTrue(fidensur.isClaimed(roundId, 0));
        assertEq(fidensur.getRound(roundId).totalClaimed, 3 ether);
        assertEq(fidensur.outstanding(address(0)), 10 ether - 3 ether);
    }

    function test_claim_allRecipientsIndependently() public {
        vm.prank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
        vm.prank(bob);
        fidensur.claim(roundId, 1, 2 ether, _proof(1));
        vm.prank(carol);
        fidensur.claim(roundId, 2, 1 ether, _proof(2));

        assertEq(alice.balance, 3 ether);
        assertEq(bob.balance, 2 ether);
        assertEq(carol.balance, 1 ether);
        assertEq(fidensur.getRound(roundId).totalClaimed, 6 ether);
    }

    function test_claim_erc20Round() public {
        uint256 id = createFundedTokenRound(100e18);

        Allocation[] memory a = new Allocation[](2);
        a[0] = Allocation({recipient: alice, amount: 60e18});
        a[1] = Allocation({recipient: bob, amount: 40e18});

        (, bytes32[] memory lv) = finalizeWith(id, hex"aa", a);

        vm.prank(alice);
        fidensur.claim(id, 0, 60e18, MerkleBuilder.proof(lv, 0));

        assertEq(token.balanceOf(alice), 60e18);
        assertEq(fidensur.outstanding(address(token)), 40e18);
    }

    /// @dev Tokens that return nothing from `transfer` (USDT-style) must still work.
    function test_claim_nonStandardERC20WithNoReturnValue() public {
        MockNoReturnERC20 odd = new MockNoReturnERC20();
        odd.mint(org, 100e18);

        vm.startPrank(org);
        uint256 id = fidensur.createRound(address(odd), CLAIM_WINDOW);
        odd.approve(address(fidensur), 100e18);
        fidensur.fund(id, 100e18);
        vm.stopPrank();

        Allocation[] memory a = new Allocation[](1);
        a[0] = Allocation({recipient: alice, amount: 100e18});
        (, bytes32[] memory lv) = finalizeWith(id, hex"bb", a);

        vm.prank(alice);
        fidensur.claim(id, 0, 100e18, MerkleBuilder.proof(lv, 0));

        assertEq(odd.balanceOf(alice), 100e18);
    }

    // -----------------------------------------------------------------
    // Proof forgery — T5, T18
    // -----------------------------------------------------------------

    /// @dev T5 — the leaf binds msg.sender, so a valid proof is useless to anyone else.
    function test_claim_rejectsProofUsedByWrongRecipient() public {
        vm.prank(bob); // bob presenting alice's index, amount, and proof
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
    }

    /// @dev T18 — a front-runner copying alice's calldata gets a proof failure, not her money.
    function test_claim_frontRunnerCannotStealClaim() public {
        vm.prank(outsider);
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));

        // Alice's own claim still works afterwards.
        vm.prank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
        assertEq(alice.balance, 3 ether);
    }

    function test_claim_rejectsInflatedAmount() public {
        vm.prank(alice);
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 0, 9 ether, _proof(0));
    }

    function test_claim_rejectsWrongIndex() public {
        vm.prank(alice);
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 1, 3 ether, _proof(0));
    }

    function test_claim_rejectsEmptyProof() public {
        vm.prank(alice);
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 0, 3 ether, new bytes32[](0));
    }

    /// @dev The round id is inside the leaf, so a proof cannot cross rounds even if two rounds
    ///      happened to share a root.
    function test_claim_rejectsProofFromAnotherRound() public {
        uint256 otherId = createFundedRound(10 ether);
        (, bytes32[] memory otherLeaves) = finalizeWith(otherId, hex"9999", allocs);

        // Same allocations, different round: the leaves differ, so the proof does not transfer.
        vm.prank(alice);
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 0, 3 ether, MerkleBuilder.proof(otherLeaves, 0));
    }

    // -----------------------------------------------------------------
    // Double claiming — T6
    // -----------------------------------------------------------------

    function test_claim_rejectsSecondClaim() public {
        vm.startPrank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));

        vm.expectRevert(abi.encodeWithSelector(Fidensur.AlreadyClaimed.selector, roundId, uint256(0)));
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
        vm.stopPrank();
    }

    function test_isClaimed_isPerRoundAndPerIndex() public {
        vm.prank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));

        assertTrue(fidensur.isClaimed(roundId, 0));
        assertFalse(fidensur.isClaimed(roundId, 1));
        assertFalse(fidensur.isClaimed(roundId + 1, 0));
    }

    /// @dev The bitmap packs 256 indices per storage word; a claim must not set a neighbouring bit.
    function test_bitmap_doesNotBleedAcrossWordBoundaries() public {
        // Indices 255 and 256 fall in different words.
        Allocation[] memory big = new Allocation[](257);
        for (uint256 i = 0; i < 257; ++i) {
            big[i] = Allocation({recipient: address(uint160(0x1000 + i)), amount: 1 wei});
        }

        uint256 id = createFundedRound(1 ether);
        (, bytes32[] memory lv) = finalizeWith(id, hex"cc", big);

        vm.prank(big[255].recipient);
        fidensur.claim(id, 255, 1 wei, MerkleBuilder.proof(lv, 255));

        assertTrue(fidensur.isClaimed(id, 255));
        assertFalse(fidensur.isClaimed(id, 256));
        assertFalse(fidensur.isClaimed(id, 254));

        vm.prank(big[256].recipient);
        fidensur.claim(id, 256, 1 wei, MerkleBuilder.proof(lv, 256));
        assertTrue(fidensur.isClaimed(id, 256));
    }

    // -----------------------------------------------------------------
    // Timing
    // -----------------------------------------------------------------

    function test_claim_rejectedAfterDeadline() public {
        uint48 deadline = fidensur.getRound(roundId).claimDeadline;
        vm.warp(uint256(deadline) + 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Fidensur.ClaimWindowClosed.selector, deadline));
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
    }

    function test_claim_allowedExactlyAtDeadline() public {
        vm.warp(uint256(fidensur.getRound(roundId).claimDeadline));

        vm.prank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
        assertEq(alice.balance, 3 ether);
    }

    function test_claim_rejectedBeforeFinalization() public {
        uint256 id = createFundedRound(10 ether);
        dispatchCompute(id, hex"dd");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector, id, Fidensur.RoundStatus.Computing, Fidensur.RoundStatus.Finalized
            )
        );
        fidensur.claim(id, 0, 1 ether, new bytes32[](0));
    }

    // -----------------------------------------------------------------
    // Sweeping — T4
    // -----------------------------------------------------------------

    function test_closeRound_returnsUnclaimedAndUnallocated() public {
        vm.prank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));

        vm.warp(uint256(fidensur.getRound(roundId).claimDeadline) + 1);
        uint256 before = org.balance;

        fidensur.closeRound(roundId);

        // 10 funded, 3 claimed: 2 + 1 unclaimed allocations plus 4 never allocated.
        assertEq(org.balance, before + 7 ether);
        assertEq(fidensur.outstanding(address(0)), 0);
        assertEq(uint8(fidensur.getRound(roundId).status), uint8(Fidensur.RoundStatus.Closed));
    }

    function test_closeRound_isPermissionless() public {
        vm.warp(uint256(fidensur.getRound(roundId).claimDeadline) + 1);
        uint256 before = org.balance;

        vm.prank(outsider);
        fidensur.closeRound(roundId);

        assertEq(org.balance, before + 10 ether, "funds go to the organization, not the caller");
    }

    function test_closeRound_rejectedBeforeDeadline() public {
        uint48 deadline = fidensur.getRound(roundId).claimDeadline;
        vm.expectRevert(abi.encodeWithSelector(Fidensur.ClaimWindowStillOpen.selector, deadline));
        fidensur.closeRound(roundId);
    }

    function test_closeRound_cannotSweepTwice() public {
        vm.warp(uint256(fidensur.getRound(roundId).claimDeadline) + 1);
        fidensur.closeRound(roundId);

        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector, roundId, Fidensur.RoundStatus.Closed, Fidensur.RoundStatus.Finalized
            )
        );
        fidensur.closeRound(roundId);
    }

    /// @dev T4 — after finalization the organization has no path to the allocated funds other than
    ///      waiting out the claim window.
    function test_organizationCannotTouchFundsBeforeDeadline() public {
        vm.startPrank(org);
        vm.expectRevert(
            abi.encodeWithSelector(
                Fidensur.WrongStatus.selector, roundId, Fidensur.RoundStatus.Finalized, Fidensur.RoundStatus.Open
            )
        );
        fidensur.cancelRound(roundId);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // Treasury invariants
    // -----------------------------------------------------------------

    /// @dev Invariant 3 — the contract's balance always covers what it still owes.
    function test_invariant_balanceCoversOutstanding() public {
        assertGe(address(fidensur).balance, fidensur.outstanding(address(0)));

        vm.prank(alice);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
        assertGe(address(fidensur).balance, fidensur.outstanding(address(0)));

        vm.warp(uint256(fidensur.getRound(roundId).claimDeadline) + 1);
        fidensur.closeRound(roundId);
        assertGe(address(fidensur).balance, fidensur.outstanding(address(0)));
        assertEq(fidensur.outstanding(address(0)), 0);
    }

    function test_rescue_recoversOnlyExcessValue() public {
        // Stray value, e.g. an instruction-fee refund from the registry.
        vm.deal(address(fidensur), address(fidensur).balance + 2 ether);

        address sink = makeAddr("sink");
        vm.prank(owner);
        fidensur.rescue(address(0), sink);

        assertEq(sink.balance, 2 ether, "only the excess is recoverable");
        assertEq(address(fidensur).balance, fidensur.outstanding(address(0)), "round funds untouched");
    }

    function test_rescue_revertsWhenNothingInExcess() public {
        vm.prank(owner);
        vm.expectRevert(Fidensur.NothingToRescue.selector);
        fidensur.rescue(address(0), makeAddr("sink"));
    }

    function test_rescue_onlyOwner() public {
        vm.deal(address(fidensur), address(fidensur).balance + 1 ether);
        vm.prank(outsider);
        vm.expectRevert();
        fidensur.rescue(address(0), outsider);
    }

    // -----------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------

    /// @dev No amount other than the allocated one can pass proof verification.
    function testFuzz_claim_rejectsAnyWrongAmount(uint256 _amount) public {
        vm.assume(_amount != 3 ether);

        vm.prank(alice);
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 0, _amount, _proof(0));
    }

    /// @dev No address other than the leaf's recipient can claim it.
    function testFuzz_claim_rejectsAnyWrongClaimant(address _claimant) public {
        vm.assume(_claimant != alice && _claimant != address(0));

        vm.prank(_claimant);
        vm.expectRevert(Fidensur.BadMerkleProof.selector);
        fidensur.claim(roundId, 0, 3 ether, _proof(0));
    }
}
