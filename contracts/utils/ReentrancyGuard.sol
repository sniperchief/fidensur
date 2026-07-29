// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title ReentrancyGuard
/// @notice Minimal non-reentrancy modifier, declared locally so the contracts build with no
///         external dependency.
/// @dev Fidensur's value-moving functions already follow checks-effects-interactions — the claim
///      bitmap and running totals are written before any transfer. This guard is defence in depth
///      for the case that matters most: an ERC-20 with a transfer hook (ERC-777 style) re-entering
///      `claim` or `sweep` mid-call.
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status = _NOT_ENTERED;

    error ReentrantCall();

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
