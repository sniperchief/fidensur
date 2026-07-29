// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "../interfaces/IERC20.sol";

/// @title SafeTransfer
/// @notice Value movement for both native C2FLR and ERC-20 tokens.
/// @dev Two things this handles that a bare `token.transfer(...)` does not:
///
///      1. **Non-standard ERC-20s.** Several widely deployed tokens return nothing instead of a
///         `bool`. Calling them through the typed interface reverts on ABI decoding even though the
///         transfer succeeded. These helpers use a low-level call and accept either an empty return
///         or a `true` return.
///      2. **Native transfers.** `transfer`/`send` forward a fixed 2300 gas stipend, which breaks
///         recipients that are smart contract wallets. These helpers use `call` with no gas cap,
///         which is safe here because every caller writes state before transferring (CEI) and is
///         additionally protected by a reentrancy guard.
library SafeTransfer {
    error NativeTransferFailed(address to, uint256 amount);
    error ERC20TransferFailed(address token, address to, uint256 amount);
    error ERC20TransferFromFailed(address token, address from, uint256 amount);
    error UnexpectedNativeValue();

    /// @notice Sentinel for the native chain token. `address(0)` denotes C2FLR/FLR.
    address internal constant NATIVE = address(0);

    /// @notice Sends `_amount` of `_token` to `_to`, dispatching on native vs ERC-20.
    function payOut(address _token, address _to, uint256 _amount) internal {
        if (_amount == 0) return;
        if (_token == NATIVE) {
            sendNative(_to, _amount);
        } else {
            sendERC20(_token, _to, _amount);
        }
    }

    /// @notice Collects `_amount` of `_token` from `_from` into this contract.
    /// @dev For native rounds the value must already have arrived as `msg.value`; the caller passes
    ///      it in `_nativeValue` so this function can assert the two agree. For ERC-20 rounds no
    ///      native value may be attached, which catches a caller funding the wrong asset.
    function collect(address _token, address _from, uint256 _amount, uint256 _nativeValue) internal {
        if (_token == NATIVE) {
            if (_nativeValue != _amount) revert UnexpectedNativeValue();
            // Native funds arrived with the call; nothing further to do.
        } else {
            if (_nativeValue != 0) revert UnexpectedNativeValue();
            pullERC20(_token, _from, _amount);
        }
    }

    /// @notice Reads this contract's balance of `_token`, native or ERC-20.
    function selfBalance(address _token) internal view returns (uint256) {
        if (_token == NATIVE) return address(this).balance;
        return IERC20(_token).balanceOf(address(this));
    }

    function sendNative(address _to, uint256 _amount) internal {
        (bool ok, ) = payable(_to).call{value: _amount}("");
        if (!ok) revert NativeTransferFailed(_to, _amount);
    }

    function sendERC20(address _token, address _to, uint256 _amount) internal {
        (bool ok, bytes memory ret) =
            _token.call(abi.encodeWithSelector(IERC20.transfer.selector, _to, _amount));
        if (!_succeeded(ok, ret)) revert ERC20TransferFailed(_token, _to, _amount);
    }

    function pullERC20(address _token, address _from, uint256 _amount) internal {
        (bool ok, bytes memory ret) = _token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, _from, address(this), _amount)
        );
        if (!_succeeded(ok, ret)) revert ERC20TransferFromFailed(_token, _from, _amount);
    }

    /// @notice A call succeeded if it did not revert and returned either nothing or `true`.
    function _succeeded(bool _ok, bytes memory _ret) private pure returns (bool) {
        if (!_ok) return false;
        if (_ret.length == 0) return true;
        return abi.decode(_ret, (bool));
    }
}
