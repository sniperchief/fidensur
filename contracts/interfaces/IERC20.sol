// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9;

/// @notice Minimal ERC-20 surface used by Fidensur.
/// @dev Declared locally so the contracts compile with no external dependency. Return values are
///      deliberately typed `bool` here; `SafeTransfer` handles tokens that return nothing at all.
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
