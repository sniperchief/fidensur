// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ITeeExtensionRegistry } from "../../contracts/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../../contracts/interfaces/ITeeMachineRegistry.sol";

/// @notice Stand-in for Flare's `TeeExtensionRegistry`.
/// @dev Models the three behaviours Fidensur actually depends on:
///        1. public extension IDs start at 0x10000, so a sender-discovery scan starting at zero
///           finds nothing;
///        2. only the registered InstructionSender may call `sendInstructions`;
///        3. instructions carry a fee.
///      Every instruction is recorded so tests can assert on the exact opType/opCommand/message
///      that reached the registry.
contract MockTeeExtensionRegistry is ITeeExtensionRegistry {
    uint256 public constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

    struct SentInstruction {
        address caller;
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        uint256 value;
        address claimBackAddress;
    }

    mapping(uint256 => address) private _senders;
    uint256 private _nextId = FIRST_PUBLIC_EXTENSION_ID;

    uint256 public fee;
    SentInstruction[] public sent;
    uint256 private _nonce;

    error NotRegisteredSender(address caller);
    error InsufficientFee(uint256 provided, uint256 required);

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    /// @notice Registers `_sender` as the sole instruction sender for a fresh extension ID.
    function registerExtension(address _sender) external returns (uint256 extensionId) {
        extensionId = _nextId++;
        _senders[extensionId] = _sender;
    }

    function nextPublicExtensionId() external view returns (uint256) {
        return _nextId;
    }

    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view returns (address) {
        return _senders[_extensionId];
    }

    function sendInstructions(
        address[] calldata,
        TeeInstructionParams calldata _params
    ) external payable returns (bytes32) {
        if (!_isRegisteredSender(msg.sender)) revert NotRegisteredSender(msg.sender);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);

        sent.push(
            SentInstruction({
                caller: msg.sender,
                opType: _params.opType,
                opCommand: _params.opCommand,
                message: _params.message,
                value: msg.value,
                claimBackAddress: _params.claimBackAddress
            })
        );

        // Deterministic but distinct per call, mirroring the real registry's unique instruction ids.
        return keccak256(abi.encode(msg.sender, _params.opCommand, _nonce++));
    }

    function sentCount() external view returns (uint256) {
        return sent.length;
    }

    function lastSent() external view returns (SentInstruction memory) {
        return sent[sent.length - 1];
    }

    function _isRegisteredSender(address _caller) private view returns (bool) {
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < _nextId; ++i) {
            if (_senders[i] == _caller) return true;
        }
        return false;
    }
}

/// @notice Stand-in for Flare's `TeeMachineRegistry`.
contract MockTeeMachineRegistry is ITeeMachineRegistry {
    address[] private _machines;

    function setMachines(address[] memory _m) external {
        _machines = _m;
    }

    function getRandomTeeIds(uint256, uint256 _count) external view returns (address[] memory out) {
        uint256 n = _count > _machines.length ? _machines.length : _count;
        out = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = _machines[i];
        }
    }
}
