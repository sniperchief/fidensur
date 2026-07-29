package engine

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Merkle construction, byte-compatible with contracts/libraries/AllocationMerkle.sol.
//
// Determinism here is a security property, not a performance detail: the root is the only thing
// about an allocation table that reaches the chain, and a verifier's whole argument is that
// re-running the published engine over the same policy reproduces the same root. Anything that
// varies between runs — map iteration, unstable sorts, floating point — would break that.
//
// Conventions, which must match AllocationMerkle.sol and test/helpers/MerkleBuilder.sol:
//
//   - leaf = keccak256(keccak256(abi.encode(roundId, index, recipient, amount)))
//     The outer hash keeps the leaf domain distinct from the internal-node domain, so a 64-byte
//     internal node cannot be re-presented as leaf preimage data.
//
//   - internal nodes hash the *sorted* pair, so a proof is a bare sibling list with no direction
//     bits.
//
//   - a level with an odd node count promotes the trailing node unchanged. It is not duplicated
//     (which would admit a forged proof for a non-existent leaf) and not paired with a zero hash
//     (which would make the tree shape depend on a magic constant).

// LeafHash computes the Merkle leaf for one allocation entry.
func LeafHash(roundID *big.Int, index uint64, recipient common.Address, amount *big.Int) common.Hash {
	buf := make([]byte, 0, 128)
	buf = append(buf, common.LeftPadBytes(roundID.Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(new(big.Int).SetUint64(index).Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(recipient.Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(amount.Bytes(), 32)...)

	inner := crypto.Keccak256(buf)
	return common.BytesToHash(crypto.Keccak256(inner))
}

// MerkleTree holds every level of a built tree, so proofs can be produced without rebuilding.
type MerkleTree struct {
	// levels[0] is the leaves; the last level holds the single root.
	levels [][]common.Hash
}

// BuildMerkleTree constructs a tree over leaves. It returns nil for an empty input, which callers
// must treat as an error — an empty tree has no meaningful root, and returning the zero hash would
// let an empty allocation masquerade as a real one.
func BuildMerkleTree(leaves []common.Hash) *MerkleTree {
	if len(leaves) == 0 {
		return nil
	}

	// Copy: the caller's slice must not be aliased into the tree, or a later mutation would
	// silently change a root that has already been signed.
	level := make([]common.Hash, len(leaves))
	copy(level, leaves)

	levels := [][]common.Hash{level}
	for len(level) > 1 {
		level = nextLevel(level)
		levels = append(levels, level)
	}

	return &MerkleTree{levels: levels}
}

// Root returns the tree root.
func (t *MerkleTree) Root() common.Hash {
	last := t.levels[len(t.levels)-1]
	return last[0]
}

// Proof returns the sibling hashes proving the leaf at index, leaf level first.
func (t *MerkleTree) Proof(index int) []common.Hash {
	if index < 0 || index >= len(t.levels[0]) {
		return nil
	}

	proof := make([]common.Hash, 0, len(t.levels))
	idx := index
	for depth := 0; depth < len(t.levels)-1; depth++ {
		level := t.levels[depth]
		sibling := idx ^ 1
		// A promoted trailing node has no sibling at this level and contributes nothing.
		if sibling < len(level) {
			proof = append(proof, level[sibling])
		}
		idx >>= 1
	}
	return proof
}

// VerifyProof recomputes a root from a leaf and its proof. Used by the engine's own tests and by
// the ATTEST path as a self-check before signing.
func VerifyProof(root, leaf common.Hash, proof []common.Hash) bool {
	computed := leaf
	for _, sibling := range proof {
		computed = hashPair(computed, sibling)
	}
	return computed == root
}

func nextLevel(level []common.Hash) []common.Hash {
	n := (len(level) + 1) / 2
	next := make([]common.Hash, n)
	for i := 0; i < n; i++ {
		left := 2 * i
		right := left + 1
		if right < len(level) {
			next[i] = hashPair(level[left], level[right])
		} else {
			next[i] = level[left] // odd trailing node, promoted unchanged
		}
	}
	return next
}

// hashPair is commutative: the operands are ordered before hashing, so proofs need no direction
// bits and the Solidity verifier can stay branch-free.
func hashPair(a, b common.Hash) common.Hash {
	if bytesLess(a, b) {
		return common.BytesToHash(crypto.Keccak256(a.Bytes(), b.Bytes()))
	}
	return common.BytesToHash(crypto.Keccak256(b.Bytes(), a.Bytes()))
}

// bytesLess compares two hashes as big-endian unsigned integers, matching Solidity's `<` on bytes32.
func bytesLess(a, b common.Hash) bool {
	for i := 0; i < common.HashLength; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}
