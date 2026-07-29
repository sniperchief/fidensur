// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title TeeResultVerifier
/// @notice Verifies that a payload really was produced and signed by a registered Flare
///         Confidential Compute TEE machine.
///
/// @dev This library is the hinge of Fidensur's public-verifiability claim, so the hashing scheme
///      is reproduced exactly as the TEE node performs it. The node does **not** sign
///      `ActionResult.Hash()` directly — it signs a domain-separated payload wrapping it:
///
///      ```
///      resultHash  = keccak256(abi.encodePacked(
///                        keccak256(resultData),
///                        actionId,
///                        keccak256(bytes(submissionTag)),
///                        status))
///
///      payloadHash = keccak256(abi.encode(
///                        bytes32("TEE_ACTION_RESULT"),
///                        chainId,
///                        resultHash))
///
///      signature   = ECDSA over EIP-191 personal-sign of payloadHash
///      ```
///
///      Verifying against the bare `resultHash` — i.e. omitting the
///      `abi.encode(TEE_ACTION_RESULT, chainId, ...)` wrapper — compiles, runs, and rejects every
///      genuine signature. This must stay byte-compatible with `signing.TEEActionResult` in
///      `github.com/flare-foundation/go-flare-common/pkg/signing`.
///
///      Four bindings fall out of the scheme, each defeating a concrete attack:
///        - `chainId`  : a Coston2 signature cannot be replayed on another chain
///        - `actionId` : a result is bound to one FCC instruction, not merely to one contract
///        - `status`   : a TEE *failure* cannot be relayed as a success
///        - signer     : only the registered TEE address produces an accepted signature
library TeeResultVerifier {
    /// @notice Domain-separation prefix the TEE node signs ActionResult hashes under.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 internal constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

    /// @notice Status value denoting a successful handler run. See the FCC extension contract §4.6:
    ///         0 = handler failed, 1 = succeeded, anything else = still in progress.
    uint8 internal constant STATUS_SUCCESS = 1;

    error TeeReportedFailure(uint8 status);
    error BadSignatureLength(uint256 length);
    error BadSignatureV(uint8 v);
    error InvalidSignature();
    error UnexpectedSigner(address recovered, address expected);

    /// @notice Reconstructs `ActionResult.Hash()` from the fields the proxy returned.
    /// @param _resultData    Exact bytes of `ActionResult.Data`.
    /// @param _actionId      `ActionResult.ID` — the FCC instruction id.
    /// @param _submissionTag `ActionResult.SubmissionTag`, e.g. "submit".
    /// @param _status        `ActionResult.Status`.
    function resultHash(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                keccak256(_resultData),
                _actionId,
                keccak256(bytes(_submissionTag)),
                _status
            )
        );
    }

    /// @notice Wraps a result hash in the TEE node's domain separation, binding it to this chain.
    function payloadHash(bytes32 _resultHash) internal view returns (bytes32) {
        return keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, _resultHash));
    }

    /// @notice Recovers the TEE machine address that signed a result.
    /// @dev Reverts on a malformed signature rather than returning `address(0)`, so a caller cannot
    ///      accidentally treat "recovery failed" as "signed by the zero address".
    function recoverSigner(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature
    ) internal view returns (address) {
        bytes32 digest = _ethSigned(payloadHash(resultHash(_resultData, _actionId, _submissionTag, _status)));
        return _recover(digest, _signature);
    }

    /// @notice Full verification: reverts unless the result is a success genuinely signed by `_expectedTee`.
    /// @param _expectedTee The TEE machine address registered for this extension.
    function requireValid(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature,
        address _expectedTee
    ) internal view {
        // Checked before signature recovery: a failed result must never be relayable, and the
        // status is inside the signed hash so this is not merely a cheap pre-filter.
        if (_status != STATUS_SUCCESS) revert TeeReportedFailure(_status);

        address signer = recoverSigner(_resultData, _actionId, _submissionTag, _status, _signature);
        if (signer != _expectedTee) revert UnexpectedSigner(signer, _expectedTee);
    }

    /// @notice Non-reverting variant, for view helpers and off-chain simulation.
    function isValid(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature,
        address _expectedTee
    ) internal view returns (bool) {
        if (_status != STATUS_SUCCESS) return false;
        if (_signature.length != 65) return false;
        if (_expectedTee == address(0)) return false;

        bytes32 digest = _ethSigned(payloadHash(resultHash(_resultData, _actionId, _submissionTag, _status)));

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_signature.offset)
            s := calldataload(add(_signature.offset, 32))
            v := byte(0, calldataload(add(_signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return false;

        return ecrecover(digest, v, r, s) == _expectedTee;
    }

    /// @notice EIP-191 personal-sign hash of a 32-byte digest.
    function _ethSigned(bytes32 _hash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _hash));
    }

    /// @notice Recovers the signer of a 65-byte `[r || s || v]` secp256k1 signature.
    function _recover(bytes32 _digest, bytes calldata _sig) private pure returns (address) {
        if (_sig.length != 65) revert BadSignatureLength(_sig.length);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_sig.offset)
            s := calldataload(add(_sig.offset, 32))
            v := byte(0, calldataload(add(_sig.offset, 64)))
        }
        // tee-node emits v as 0/1 in some paths and 27/28 in others; normalize.
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignatureV(v);

        address signer = ecrecover(_digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
