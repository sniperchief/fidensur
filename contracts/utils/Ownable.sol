// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title Ownable
/// @notice Minimal two-step ownership, declared locally so the contracts build with no external
///         dependency.
/// @dev Two-step rather than one-step: transferring ownership to a mistyped address is
///      unrecoverable, and on Fidensur the owner controls `setTeeAddress` — the anchor of every
///      signature check. Requiring the new owner to accept makes that class of mistake impossible.
abstract contract Ownable {
    address public owner;
    address public pendingOwner;

    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error ZeroOwner();

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(address _initialOwner) {
        if (_initialOwner == address(0)) revert ZeroOwner();
        owner = _initialOwner;
        emit OwnershipTransferred(address(0), _initialOwner);
    }

    /// @notice Nominates a new owner. Takes effect only once they call `acceptOwnership`.
    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert ZeroOwner();
        pendingOwner = _newOwner;
        emit OwnershipTransferStarted(owner, _newOwner);
    }

    /// @notice Completes a transfer started by `transferOwnership`.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }
}
