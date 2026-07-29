// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";
import { TeeResultVerifier } from "./libraries/TeeResultVerifier.sol";
import { AllocationMerkle } from "./libraries/AllocationMerkle.sol";
import { SafeTransfer } from "./libraries/SafeTransfer.sol";
import { Ownable } from "./utils/Ownable.sol";
import { ReentrancyGuard } from "./utils/ReentrancyGuard.sol";

/// @title Fidensur
/// @notice Allocate funds privately. Prove the computation publicly.
///
/// @dev Confidential treasury allocation on Flare Confidential Compute. An organization funds a
///      round, commits to an encrypted allocation policy, and asks a TEE to evaluate it. The TEE
///      returns only an aggregate — Merkle root, total, recipient count — signed with its
///      attested key. Individual addresses, amounts, and allocation rules never reach the chain.
///
///      This contract is the **registered InstructionSender** for the Fidensur FCC extension. The
///      `TeeExtensionRegistry` binds an extension to exactly one sender address and rejects
///      `sendInstructions` from anything else, which makes this contract the authorization
///      boundary: anything it stamps into an instruction payload (notably `msg.sender` on a
///      disclosure request) is something the enclave can trust unconditionally.
///
///      Treasury custody, round lifecycle, and claim settlement live here too rather than in a
///      separate contract. Splitting them would force a delegation hop whose only purpose is to
///      satisfy the registry's single-sender rule, adding an authorization surface without adding
///      safety. `fce-weather-insurance` makes the same call.
///
///      DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId(). These follow the Flare
///      scaffold verbatim; in particular the extension-ID scan must start at 0x10000, since IDs
///      below that are reserved for system extensions.
///
///      See docs/architecture.md for the full design and docs/fcc-research.md for the FCC
///      mechanisms this builds on.
contract Fidensur is Ownable, ReentrancyGuard {
    using TeeResultVerifier for bytes;

    // ---------------------------------------------------------------------
    // Operation identifiers
    //
    // These bytes32 values must match `extension/internal/config/config.go` exactly. A mismatched
    // OPType produces "unsupported op type" at the extension and a mismatched OPCommand produces
    // "unsupported op command" — both are runtime 501s with no compile-time signal, which is why
    // scripts/check-op-sync.sh diffs the two files in CI.
    //
    // bytes32 string literals hold at most 31 bytes; all four identifiers are well inside that.
    // ---------------------------------------------------------------------

    /// @notice Operation group for every confidential allocation instruction.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_ALLOC = bytes32("ALLOC");

    /// @notice Decrypt the policy, evaluate allocations, return the signed aggregate.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_COMPUTE = bytes32("COMPUTE");

    /// @notice Return one recipient's own allocation, encrypted to their disclosure key.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_DISCLOSE = bytes32("DISCLOSE");

    /// @notice Re-emit an already-computed round's signed integrity record.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_ATTEST = bytes32("ATTEST");

    // ---------------------------------------------------------------------
    // Registries and extension identity
    // ---------------------------------------------------------------------

    /// @notice Registry of FCC extensions; the only path to submit instructions.
    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;

    /// @notice Registry mapping extensions to the TEE machines serving them.
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice First public extension ID. The registry reserves everything below this for system
    ///         extensions, so discovery scans upward from here — never from zero.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    uint256 private _extensionId;

    /// @notice Address of the registered TEE machine whose signature this contract accepts.
    /// @dev Set by the owner after `post-build.sh` registers the machine. Until it is set, no round
    ///      can be finalized — `finalizeRound` refuses a zero TEE address rather than letting
    ///      `ecrecover` failure modes decide.
    address public teeAddress;

    // ---------------------------------------------------------------------
    // Round model
    // ---------------------------------------------------------------------

    enum RoundStatus {
        None,       // never created
        Open,       // created, accepting funding
        Committed,  // policy commitment recorded; ready to dispatch
        Computing,  // instruction sent to the TEE; awaiting a signed result
        Finalized,  // root recorded; recipients may claim
        Closed,     // claim window over; remainder swept
        Cancelled   // abandoned before computation; funding refunded
    }

    /// @notice A confidential allocation round.
    /// @dev Field order is chosen for slot packing, which the tests assert:
    ///        slot 0: organization(20) + status(1) + swept(1) + recipientCount(4) + claimWindow(6) = 32
    ///        slot 1: token(20) + claimDeadline(6) + computeRequestedAt(6)                         = 32
    ///      Timestamps are `uint48` — good past the year 8,000,000 — which is what makes slot 1 fit
    ///      exactly. `uint64` would have spilled into a ninth slot for no benefit.
    ///
    ///      Note what is *absent*: no recipient list, no amounts, no allocation rules, and no
    ///      policy ciphertext. The ciphertext is passed as a transient instruction payload and
    ///      never persisted — on-chain data is permanent and encryption weakens over time, so the
    ///      commitment is the durable record.
    struct Round {
        // --- slot 0 ---
        address organization;         // creator; the only address that may submit and compute
        RoundStatus status;
        bool swept;                   // remainder returned after the claim window
        uint32 recipientCount;        // set at finalize, from the TEE result
        uint48 claimWindow;           // seconds recipients get to claim, from finalize
        // --- slot 1 ---
        address token;                // address(0) = native C2FLR
        uint48 claimDeadline;         // set at finalize
        uint48 computeRequestedAt;    // set at dispatch; gates the retry timeout
        // --- one slot each ---
        uint256 funded;
        uint256 totalAllocated;       // invariant: <= funded
        uint256 totalClaimed;         // invariant: <= totalAllocated
        bytes32 policyCommitment;     // keccak256 of the encrypted policy blob
        bytes32 merkleRoot;           // set once at finalize; never mutated
        bytes32 computeInstructionId; // binds exactly one FCC instruction to this round
        bytes32 engineVersion;        // version string of the engine that computed it
    }

    /// @notice ABI payload of a DISCLOSE instruction, decoded by the extension.
    /// @dev `requester` is stamped from `msg.sender` by this contract. Because the registry
    ///      guarantees this contract is the sole instruction sender for the extension, the enclave
    ///      can treat that field as authenticated and needs no signature of its own.
    struct DiscloseMessage {
        uint256 roundId;
        address contractAddr;
        address requester;
        bytes32 policyCommitment;
        bytes disclosureKey;    // 33- or 65-byte secp256k1 public key to encrypt the reply to
    }

    /// @notice ABI payload of an ATTEST instruction, decoded by the extension.
    struct AttestMessage {
        uint256 roundId;
        address contractAddr;
        bytes32 policyCommitment;
    }

    /// @notice Decoded `ActionResult.Data` from a COMPUTE or ATTEST result.
    /// @dev Every field is a static type, so the ABI encoding of this struct is byte-identical to
    ///      `abi.encode(contractAddr, roundId, policyCommitment, merkleRoot, totalAllocated,
    ///      recipientCount, engineVersion)`. The Go engine emits the flat form; decoding into a
    ///      struct here keeps `finalizeRound` off the stack-too-deep cliff and reads better.
    struct AllocationResult {
        address contractAddr;      // must equal this deployment
        uint256 roundId;
        bytes32 policyCommitment;  // must equal the round's committed policy
        bytes32 merkleRoot;
        uint256 totalAllocated;
        uint32 recipientCount;
        bytes32 engineVersion;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(uint256 => Round) private _rounds;

    /// @notice roundId => word index => 256 claim bits.
    /// @dev A bitmap rather than `mapping(address => bool)`: after the first claim in a word, each
    ///      further claim in that word costs a warm SSTORE instead of a cold one.
    mapping(uint256 => mapping(uint256 => uint256)) private _claimedBitmap;

    /// @notice Total value this contract still owes across all rounds, per token.
    /// @dev Maintained explicitly instead of reading `balanceOf`, so a donation or a fee refund can
    ///      never be mistaken for round funding. `rescue` may withdraw only the excess above this.
    mapping(address => uint256) public outstanding;

    uint256 public nextRoundId;

    /// @notice How long an unanswered COMPUTE must sit before it may be retried.
    /// @dev FCC delivery is not guaranteed — a TEE can be unreachable, the proxy can lag, a result
    ///      can be lost. Without a retry a round would be stuck forever; without a timeout the
    ///      retry would be an instruction-spam vector.
    uint48 public constant COMPUTE_RETRY_TIMEOUT = 30 minutes;

    /// @notice Bounds on the claim window an organization may choose.
    uint48 public constant MIN_CLAIM_WINDOW = 1 hours;
    uint48 public constant MAX_CLAIM_WINDOW = 365 days;

    // ---------------------------------------------------------------------
    // Events — the verification explorer reconstructs a round's timeline from these
    // ---------------------------------------------------------------------

    event TeeAddressSet(address indexed previousTee, address indexed newTee);
    event ExtensionIdSet(uint256 indexed extensionId);

    event RoundCreated(uint256 indexed roundId, address indexed organization, address indexed token, uint48 claimWindow);
    event RoundFunded(uint256 indexed roundId, address indexed funder, uint256 amount, uint256 totalFunded);
    event PolicyCommitted(uint256 indexed roundId, bytes32 indexed policyCommitment);
    event ComputeRequested(uint256 indexed roundId, bytes32 indexed instructionId, address[] teeIds, uint256 fee);
    event DisclosureRequested(uint256 indexed roundId, address indexed requester, bytes32 indexed instructionId);
    event AttestationRequested(uint256 indexed roundId, bytes32 indexed instructionId);

    event RoundFinalized(
        uint256 indexed roundId,
        bytes32 indexed merkleRoot,
        uint256 totalAllocated,
        uint32 recipientCount,
        bytes32 engineVersion,
        bytes32 actionId
    );

    event AllocationClaimed(uint256 indexed roundId, uint256 indexed index, address indexed recipient, uint256 amount);
    event RoundClosed(uint256 indexed roundId, uint256 sweptAmount);
    event RoundCancelled(uint256 indexed roundId, uint256 refundedAmount);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error NoCode(address target);
    error ExtensionIdAlreadySet();
    error ExtensionIdNotFound();
    error ExtensionIdNotSet();
    error TeeAddressNotSet();

    error NoSuchRound(uint256 roundId);
    error WrongStatus(uint256 roundId, RoundStatus actual, RoundStatus expected);
    error NotOrganization(address caller, address organization);
    error InvalidClaimWindow(uint48 provided);
    error ZeroAmount();
    error NothingFunded(uint256 roundId);
    error EmptyCommitment();
    error CiphertextMismatch(bytes32 provided, bytes32 committed);
    error EmptyCiphertext();
    error RetryTooSoon(uint48 requestedAt, uint48 earliestRetry);
    error NoTeeAvailable();

    error ResultNotForThisContract(address encoded);
    error ResultNotForThisRound(bytes32 actionId, bytes32 expected);
    error PolicyCommitmentMismatch(bytes32 encoded, bytes32 stored);
    error EmptyMerkleRoot();
    error NoRecipients();
    error OverAllocated(uint256 totalAllocated, uint256 funded);

    error AlreadyClaimed(uint256 roundId, uint256 index);
    error ClaimWindowClosed(uint48 deadline);
    error ClaimWindowStillOpen(uint48 deadline);
    error BadMerkleProof();
    error AlreadySwept(uint256 roundId);
    error InvalidDisclosureKey(uint256 length);
    error NothingToRescue();

    // ---------------------------------------------------------------------
    // Construction and configuration
    // ---------------------------------------------------------------------

    /// @notice Wires the contract to the Flare TEE registries.
    /// @dev DO NOT MODIFY. Reproduced from the Flare FCC scaffold. On Coston2 both registries are
    ///      the same `FlareTeeManager` diamond; the code-length checks catch a mistyped address,
    ///      which would otherwise fail much later with an opaque revert.
    /// @param _teeExtensionRegistry Address of the TEE extension registry.
    /// @param _teeMachineRegistry   Address of the TEE machine registry.
    /// @param _initialOwner         Address permitted to set the TEE address.
    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry,
        address _initialOwner
    ) Ownable(_initialOwner) {
        if (address(_teeExtensionRegistry) == address(0)) revert ZeroAddress();
        if (address(_teeMachineRegistry) == address(0)) revert ZeroAddress();
        if (address(_teeExtensionRegistry).code.length == 0) revert NoCode(address(_teeExtensionRegistry));
        if (address(_teeMachineRegistry).code.length == 0) revert NoCode(address(_teeMachineRegistry));

        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
    }

    /// @notice Finds and caches this contract's extension ID. Callable once, by anyone.
    /// @dev DO NOT MODIFY. Reproduced from the Flare FCC scaffold.
    ///
    ///      The scan starts at 0x10000 because public extension IDs begin there — scanning from
    ///      zero burns gas across 65,536 reserved slots and finds nothing. The ID is not a
    ///      constructor argument because registration happens *after* deployment: the registry is
    ///      told this address, then this contract discovers the ID it was assigned.
    ///
    ///      Permissionless deliberately. It is idempotent-by-revert, derives its answer entirely
    ///      from registry state, and gating it on the owner would only add a way for a deployment
    ///      to stall.
    function setExtensionId() external {
        if (_extensionId != 0) revert ExtensionIdAlreadySet();

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                emit ExtensionIdSet(i);
                return;
            }
        }
        revert ExtensionIdNotFound();
    }

    /// @notice Registers the TEE machine address whose signatures this contract will accept.
    /// @dev The anchor of every verification in this contract, hence owner-only and two-step
    ///      ownership. It is intentionally re-settable: TEE machines are re-registered after
    ///      attestation refreshes and after a `FlareTeeManager` redeployment, and a contract that
    ///      pinned it at construction would be bricked by either.
    function setTeeAddress(address _teeAddress) external onlyOwner {
        if (_teeAddress == address(0)) revert ZeroAddress();
        emit TeeAddressSet(teeAddress, _teeAddress);
        teeAddress = _teeAddress;
    }

    // ---------------------------------------------------------------------
    // Round lifecycle — organization side
    // ---------------------------------------------------------------------

    /// @notice Creates an empty allocation round.
    /// @param _token       ERC-20 to distribute, or `address(0)` for native C2FLR.
    /// @param _claimWindow Seconds recipients will have to claim, measured from finalization.
    /// @return roundId The new round's id.
    function createRound(address _token, uint48 _claimWindow) external returns (uint256 roundId) {
        if (_claimWindow < MIN_CLAIM_WINDOW || _claimWindow > MAX_CLAIM_WINDOW) {
            revert InvalidClaimWindow(_claimWindow);
        }

        roundId = nextRoundId++;
        Round storage r = _rounds[roundId];
        r.organization = msg.sender;
        r.status = RoundStatus.Open;
        r.token = _token;
        r.claimWindow = _claimWindow;

        emit RoundCreated(roundId, msg.sender, _token, _claimWindow);
    }

    /// @notice Adds funds to an open round.
    /// @dev Funding is separate from creation, and repeatable, because a treasury often tops a
    ///      round up as the recipient list grows. Anyone may fund — a round can be sponsored — but
    ///      only the organization can allocate.
    ///
    ///      For ERC-20 rounds the caller must `approve` first and must not attach native value;
    ///      for native rounds `msg.value` must equal `_amount`. `SafeTransfer.collect` enforces
    ///      both, which catches funding the wrong asset before any state is written.
    function fund(uint256 _roundId, uint256 _amount) external payable nonReentrant {
        Round storage r = _requireRound(_roundId);
        if (r.status != RoundStatus.Open) revert WrongStatus(_roundId, r.status, RoundStatus.Open);
        if (_amount == 0) revert ZeroAmount();

        SafeTransfer.collect(r.token, msg.sender, _amount, msg.value);

        r.funded += _amount;
        outstanding[r.token] += _amount;

        emit RoundFunded(_roundId, msg.sender, _amount, r.funded);
    }

    /// @notice Records the commitment to an encrypted allocation policy.
    /// @param _policyCommitment `keccak256` of the ECIES ciphertext that will be dispatched.
    ///
    /// @dev This exists as a separate transaction from `requestCompute` on purpose. The commitment
    ///      lands on-chain *before* the ciphertext is dispatched and before the organization can
    ///      see which TEE machine will process it, so the policy cannot be swapped in response to
    ///      either. `requestCompute` then refuses any ciphertext that does not hash to this value.
    ///
    ///      Requiring `funded > 0` stops an organization from advertising a round that it never
    ///      intends to pay for; recipients can check funding before relying on it.
    function submitPolicy(uint256 _roundId, bytes32 _policyCommitment) external {
        Round storage r = _requireRound(_roundId);
        if (r.status != RoundStatus.Open) revert WrongStatus(_roundId, r.status, RoundStatus.Open);
        if (msg.sender != r.organization) revert NotOrganization(msg.sender, r.organization);
        if (_policyCommitment == bytes32(0)) revert EmptyCommitment();
        if (r.funded == 0) revert NothingFunded(_roundId);

        r.policyCommitment = _policyCommitment;
        r.status = RoundStatus.Committed;

        emit PolicyCommitted(_roundId, _policyCommitment);
    }

    /// @notice Dispatches the encrypted policy to the TEE for evaluation.
    /// @param _ciphertext ECIES ciphertext of the ABI-encoded policy, encrypted to the extension's
    ///                    public key. Must hash to the committed value.
    ///
    /// @dev Forward `msg.value` to cover the registry's per-instruction fee. The fee is not
    ///      hard-coded here: it is set by Flare protocol governance and reading it from a constant
    ///      would break the contract whenever it changed. Unused value is refunded by the registry
    ///      to `claimBackAddress`, which is set to the caller.
    ///
    ///      Callable again after `COMPUTE_RETRY_TIMEOUT` if no result arrives, since FCC delivery
    ///      is not guaranteed. The retry overwrites `computeInstructionId`, so a late result from
    ///      the superseded instruction is rejected by `finalizeRound` — exactly the intent: at most
    ///      one instruction can finalize a round.
    function requestCompute(uint256 _roundId, bytes calldata _ciphertext) external payable {
        Round storage r = _requireRound(_roundId);
        if (msg.sender != r.organization) revert NotOrganization(msg.sender, r.organization);
        if (_ciphertext.length == 0) revert EmptyCiphertext();

        if (r.status == RoundStatus.Computing) {
            // Retry path: only once the previous attempt has plainly failed.
            uint48 earliest = r.computeRequestedAt + COMPUTE_RETRY_TIMEOUT;
            // forge-lint: disable-next-line(block-timestamp) — the threshold is 30 minutes; the
            // few seconds a validator could shift `block.timestamp` by is not a meaningful edge.
            if (uint48(block.timestamp) < earliest) revert RetryTooSoon(r.computeRequestedAt, earliest);
        } else if (r.status != RoundStatus.Committed) {
            revert WrongStatus(_roundId, r.status, RoundStatus.Committed);
        }

        bytes32 provided = keccak256(_ciphertext);
        if (provided != r.policyCommitment) revert CiphertextMismatch(provided, r.policyCommitment);

        address[] memory teeIds = _pickTee();
        bytes32 instructionId = _send(OP_COMMAND_COMPUTE, _ciphertext, teeIds);

        r.computeInstructionId = instructionId;
        r.computeRequestedAt = uint48(block.timestamp);
        r.status = RoundStatus.Computing;

        emit ComputeRequested(_roundId, instructionId, teeIds, msg.value);
    }

    // ---------------------------------------------------------------------
    // Finalization — the trust hinge
    // ---------------------------------------------------------------------

    /// @notice Records a TEE-signed allocation result, opening the round for claims.
    ///
    /// @dev Deliberately **permissionless**. Anyone holding the signed result may submit it, so an
    ///      organization cannot suppress an outcome it dislikes by withholding the transaction.
    ///      The signature is what confers authority here, not the sender.
    ///
    ///      The TEE node signs a domain-separated payload wrapping `ActionResult.Hash()`; see
    ///      `TeeResultVerifier` for the exact scheme and why verifying the bare result hash fails.
    ///
    /// @param _resultData    Exact `ActionResult.Data` bytes:
    ///                       `abi.encode(address contractAddr, uint256 roundId,
    ///                       bytes32 policyCommitment, bytes32 merkleRoot, uint256 totalAllocated,
    ///                       uint32 recipientCount, bytes32 engineVersion)`.
    /// @param _actionId      `ActionResult.ID` — the instruction id returned by `requestCompute`.
    /// @param _submissionTag `ActionResult.SubmissionTag`, typically "submit". Passed in rather
    ///                       than assumed, because it is part of the signed hash.
    /// @param _status        `ActionResult.Status`; only 1 (success) is accepted.
    /// @param _signature     65-byte signature from the registered TEE machine.
    function finalizeRound(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature
    ) external {
        address tee = teeAddress;
        if (tee == address(0)) revert TeeAddressNotSet();

        // Reverts unless the result is a success genuinely signed by the registered machine.
        TeeResultVerifier.requireValid(_resultData, _actionId, _submissionTag, _status, _signature, tee);

        AllocationResult memory res = abi.decode(_resultData, (AllocationResult));
        _applyAllocationResult(res, _actionId);
    }

    /// @notice Validates a verified allocation result against stored round state and applies it.
    /// @dev Split out of `finalizeRound` so the signature-bearing calldata arguments fall off the
    ///      stack before this runs. Reached only after the signature has been verified.
    function _applyAllocationResult(AllocationResult memory _res, bytes32 _actionId) private {
        // The TEE stamps its target contract into the result, so a result computed for a different
        // Fidensur deployment cannot be relayed here even though the signature is valid.
        if (_res.contractAddr != address(this)) revert ResultNotForThisContract(_res.contractAddr);

        Round storage r = _requireRound(_res.roundId);
        if (r.status != RoundStatus.Computing) {
            revert WrongStatus(_res.roundId, r.status, RoundStatus.Computing);
        }

        // Binds the result to *this round's* instruction, not merely to some instruction from this
        // contract. Without it, a signed result for round 5 could finalize round 6.
        if (_actionId != r.computeInstructionId) {
            revert ResultNotForThisRound(_actionId, r.computeInstructionId);
        }

        // Proves the enclave evaluated the ciphertext the organization committed to, not a
        // substituted one.
        if (_res.policyCommitment != r.policyCommitment) {
            revert PolicyCommitmentMismatch(_res.policyCommitment, r.policyCommitment);
        }

        if (_res.merkleRoot == bytes32(0)) revert EmptyMerkleRoot();
        if (_res.recipientCount == 0) revert NoRecipients();

        // The solvency invariant. The contract can never promise more than it holds, whatever the
        // TEE reports — a bug or a compromise in the engine cannot create an obligation the
        // treasury cannot meet.
        if (_res.totalAllocated > r.funded) revert OverAllocated(_res.totalAllocated, r.funded);

        r.merkleRoot = _res.merkleRoot;
        r.totalAllocated = _res.totalAllocated;
        r.recipientCount = _res.recipientCount;
        r.engineVersion = _res.engineVersion;
        r.claimDeadline = uint48(block.timestamp) + r.claimWindow;
        r.status = RoundStatus.Finalized;

        emit RoundFinalized(
            _res.roundId,
            _res.merkleRoot,
            _res.totalAllocated,
            _res.recipientCount,
            _res.engineVersion,
            _actionId
        );
    }

    // ---------------------------------------------------------------------
    // Recipient side
    // ---------------------------------------------------------------------

    /// @notice Asks the TEE to reveal the caller's own allocation, encrypted to them.
    /// @param _disclosureKey Caller's secp256k1 public key — 33 bytes compressed, 65 uncompressed.
    ///
    /// @dev The reply travels back through the public proxy as ciphertext under a key only the
    ///      caller holds, so publishing it leaks that a disclosure was requested, not its content.
    ///
    ///      The requester cannot be spoofed: this contract stamps `msg.sender` into the payload,
    ///      and the registry guarantees this contract is the extension's only instruction sender.
    ///      The enclave therefore treats that field as authenticated and returns an entry only if
    ///      the requester actually appears in the allocation table.
    ///
    ///      Permitted from `Computing` onward. A recipient may reasonably want their entry before
    ///      anyone has bothered to relay the finalization transaction.
    function requestDisclosure(uint256 _roundId, bytes calldata _disclosureKey) external payable {
        Round storage r = _requireRound(_roundId);
        if (r.status != RoundStatus.Computing && r.status != RoundStatus.Finalized) {
            revert WrongStatus(_roundId, r.status, RoundStatus.Finalized);
        }
        if (_disclosureKey.length != 33 && _disclosureKey.length != 65) {
            revert InvalidDisclosureKey(_disclosureKey.length);
        }

        bytes memory message = abi.encode(
            DiscloseMessage({
                roundId: _roundId,
                contractAddr: address(this),
                requester: msg.sender,
                policyCommitment: r.policyCommitment,
                disclosureKey: _disclosureKey
            })
        );

        bytes32 instructionId = _send(OP_COMMAND_DISCLOSE, message, _pickTee());
        emit DisclosureRequested(_roundId, msg.sender, instructionId);
    }

    /// @notice Claims an allocation with a Merkle proof.
    /// @param _index  Position assigned by the engine (recipients sorted by address).
    /// @param _amount Allocation in the round's token units.
    /// @param _proof  Sibling hashes from the leaf upward.
    ///
    /// @dev The leaf binds `msg.sender`, so a leaked proof is worthless to anyone else and a
    ///      front-runner's copy of this transaction simply fails proof verification.
    ///
    ///      Checks-effects-interactions: the claim bit and running total are written before any
    ///      value moves, so a token with a transfer hook cannot re-enter into a second payout.
    ///      `nonReentrant` backs that up.
    function claim(
        uint256 _roundId,
        uint256 _index,
        uint256 _amount,
        bytes32[] calldata _proof
    ) external nonReentrant {
        Round storage r = _requireRound(_roundId);
        if (r.status != RoundStatus.Finalized) revert WrongStatus(_roundId, r.status, RoundStatus.Finalized);
        // forge-lint: disable-next-line(block-timestamp) — claim windows are hours to days; second-
        // scale timestamp drift cannot meaningfully advance or delay a deadline.
        if (uint48(block.timestamp) > r.claimDeadline) revert ClaimWindowClosed(r.claimDeadline);
        if (isClaimed(_roundId, _index)) revert AlreadyClaimed(_roundId, _index);
        if (!AllocationMerkle.verify(r.merkleRoot, _roundId, _index, msg.sender, _amount, _proof)) {
            revert BadMerkleProof();
        }

        _setClaimed(_roundId, _index);
        r.totalClaimed += _amount;
        outstanding[r.token] -= _amount;

        SafeTransfer.payOut(r.token, msg.sender, _amount);

        emit AllocationClaimed(_roundId, _index, msg.sender, _amount);
    }

    // ---------------------------------------------------------------------
    // Wind-down
    // ---------------------------------------------------------------------

    /// @notice Closes a finalized round after its claim window and returns the remainder.
    /// @dev Permissionless: the organization gets the funds regardless of who pays the gas, and
    ///      leaving it to them alone would let a distracted treasury strand its own capital.
    ///      Returns everything unclaimed — both allocations nobody claimed in time and any funding
    ///      the policy did not allocate.
    function closeRound(uint256 _roundId) external nonReentrant {
        Round storage r = _requireRound(_roundId);
        if (r.status != RoundStatus.Finalized) revert WrongStatus(_roundId, r.status, RoundStatus.Finalized);
        // forge-lint: disable-next-line(block-timestamp) — see claim(). Sweeping a few seconds
        // early or late has no effect a claimant could exploit.
        if (uint48(block.timestamp) <= r.claimDeadline) revert ClaimWindowStillOpen(r.claimDeadline);
        if (r.swept) revert AlreadySwept(_roundId);

        uint256 remainder = r.funded - r.totalClaimed;

        r.swept = true;
        r.status = RoundStatus.Closed;
        outstanding[r.token] -= remainder;

        SafeTransfer.payOut(r.token, r.organization, remainder);

        emit RoundClosed(_roundId, remainder);
    }

    /// @notice Abandons a round before computation and refunds the organization.
    /// @dev Allowed from `Open` and `Committed` only. Once a round is `Computing` a signed result
    ///      may already exist, and cancelling would let an organization race the relay to void an
    ///      allocation it had already committed to — the retry timeout, not cancellation, is the
    ///      remedy for a stuck computation.
    function cancelRound(uint256 _roundId) external nonReentrant {
        Round storage r = _requireRound(_roundId);
        if (r.status != RoundStatus.Open && r.status != RoundStatus.Committed) {
            revert WrongStatus(_roundId, r.status, RoundStatus.Open);
        }
        if (msg.sender != r.organization) revert NotOrganization(msg.sender, r.organization);

        uint256 refund = r.funded;

        r.status = RoundStatus.Cancelled;
        r.swept = true;
        outstanding[r.token] -= refund;

        SafeTransfer.payOut(r.token, r.organization, refund);

        emit RoundCancelled(_roundId, refund);
    }

    /// @notice Withdraws tokens held beyond the contract's outstanding obligations.
    /// @dev Two things end up here legitimately: fee refunds the registry returns, and value sent
    ///      by mistake. Because `outstanding` is tracked explicitly rather than inferred from
    ///      balances, "excess" is exactly computable and this function cannot touch a single unit
    ///      any round is owed.
    function rescue(address _token, address _to) external onlyOwner nonReentrant {
        if (_to == address(0)) revert ZeroAddress();

        uint256 balance = SafeTransfer.selfBalance(_token);
        uint256 owed = outstanding[_token];
        if (balance <= owed) revert NothingToRescue();

        uint256 excess = balance - owed;
        SafeTransfer.payOut(_token, _to, excess);

        emit Rescued(_token, _to, excess);
    }

    /// @notice Asks the TEE to re-emit a computed round's signed integrity record.
    /// @dev A signed result can be lost before it reaches the chain — the relay transaction can
    ///      fail, the tunnel can drop. Recomputing is not free, so this re-emits the record from
    ///      enclave state instead. Permissionless: the record is public information, and anyone
    ///      wanting to finalize a stuck round should be able to obtain it.
    function requestAttestation(uint256 _roundId) external payable {
        Round storage r = _requireRound(_roundId);
        if (r.status != RoundStatus.Computing && r.status != RoundStatus.Finalized) {
            revert WrongStatus(_roundId, r.status, RoundStatus.Finalized);
        }

        bytes memory message = abi.encode(
            AttestMessage({
                roundId: _roundId,
                contractAddr: address(this),
                policyCommitment: r.policyCommitment
            })
        );

        bytes32 instructionId = _send(OP_COMMAND_ATTEST, message, _pickTee());
        emit AttestationRequested(_roundId, instructionId);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns a round in full. Reverts if it does not exist.
    function getRound(uint256 _roundId) external view returns (Round memory) {
        Round storage r = _rounds[_roundId];
        if (r.status == RoundStatus.None) revert NoSuchRound(_roundId);
        return r;
    }

    /// @notice Whether the allocation at `_index` in `_roundId` has been claimed.
    function isClaimed(uint256 _roundId, uint256 _index) public view returns (bool) {
        uint256 word = _index >> 8;         // _index / 256
        uint256 bit = _index & 0xff;        // _index % 256
        // forge-lint: disable-next-line(incorrect-shift) — operands are correct; `bit` is the
        // shift distance and 1 is the value being shifted. The lint flags any literal-left shift.
        return _claimedBitmap[_roundId][word] & (uint256(1) << bit) != 0;
    }

    /// @notice Amount `closeRound` would return to the organization right now.
    function remainingToSweep(uint256 _roundId) external view returns (uint256) {
        Round storage r = _rounds[_roundId];
        if (r.status != RoundStatus.Finalized || r.swept) return 0;
        return r.funded - r.totalClaimed;
    }

    /// @notice This contract's cached extension ID, or zero if `setExtensionId` has not run.
    function extensionId() external view returns (uint256) {
        return _extensionId;
    }

    /// @notice Off-chain helper: the leaf hash for a given allocation entry.
    /// @dev Lets the verification explorer re-derive a leaf through the same code path the claim
    ///      check uses, rather than a JavaScript reimplementation that might drift.
    function allocationLeaf(
        uint256 _roundId,
        uint256 _index,
        address _recipient,
        uint256 _amount
    ) external pure returns (bytes32) {
        return AllocationMerkle.leafHash(_roundId, _index, _recipient, _amount);
    }

    /// @notice Off-chain helper: check a TEE result without sending a transaction.
    /// @dev The verification explorer calls this to show a pass/fail independent of whether the
    ///      round was ever finalized.
    function checkTeeResult(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature
    ) external view returns (bool valid, address recoveredSigner) {
        valid = TeeResultVerifier.isValid(_resultData, _actionId, _submissionTag, _status, _signature, teeAddress);
        recoveredSigner = _signature.length == 65
            ? TeeResultVerifier.recoverSigner(_resultData, _actionId, _submissionTag, _status, _signature)
            : address(0);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @notice Loads a round, reverting if it was never created.
    function _requireRound(uint256 _roundId) private view returns (Round storage r) {
        r = _rounds[_roundId];
        if (r.status == RoundStatus.None) revert NoSuchRound(_roundId);
    }

    /// @notice Picks one TEE machine to serve an instruction.
    /// @dev Count of 1 matches both Flare reference applications. Fanning out to several machines
    ///      with a cosigner threshold is the obvious hardening step and is recorded as future work
    ///      in docs/architecture.md §9.4 — it changes the result-verification model, so it is not a
    ///      drop-in change.
    function _pickTee() private view returns (address[] memory teeIds) {
        teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        if (teeIds.length == 0) revert NoTeeAvailable();
    }

    /// @notice Submits an instruction to the extension registry.
    /// @dev `claimBackAddress` is the caller, so any unused portion of the per-instruction fee
    ///      returns to whoever paid it. No cosigners: single-TEE routing has nothing to co-sign.
    function _send(
        bytes32 _opCommand,
        bytes memory _message,
        address[] memory _teeIds
    ) private returns (bytes32) {
        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_ALLOC,
            opCommand: _opCommand,
            message: _message,
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        return TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(_teeIds, params);
    }

    /// @notice Marks an allocation index as claimed.
    function _setClaimed(uint256 _roundId, uint256 _index) private {
        uint256 word = _index >> 8;
        uint256 bit = _index & 0xff;
        // forge-lint: disable-next-line(incorrect-shift) — see isClaimed().
        _claimedBitmap[_roundId][word] |= (uint256(1) << bit);
    }

    /// @notice Returns the cached extension ID, reverting if discovery has not run.
    /// @dev DO NOT MODIFY. Reproduced from the Flare FCC scaffold.
    function _getExtensionId() private view returns (uint256) {
        if (_extensionId == 0) revert ExtensionIdNotSet();
        return _extensionId;
    }

    /// @notice Accepts stray native value without crediting any round.
    /// @dev Required rather than optional: the registry refunds unused instruction fees, and a
    ///      reverting `receive` would make those refunds fail. Anything landing here is excess by
    ///      construction — `outstanding` only ever grows through `fund` — so `rescue` can recover
    ///      it without touching round funds.
    receive() external payable {}
}
