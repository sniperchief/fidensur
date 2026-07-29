/**
 * ECIES, byte-compatible with `github.com/ethereum/go-ethereum/crypto/ecies`.
 *
 * The organization's allocation policy is encrypted here, in the browser, and decrypted inside the
 * TEE by `tee-node`'s `/decrypt` endpoint. `tee-node` is Go and uses go-ethereum's `ecies` package,
 * so this must match that package's framing exactly — not "be ECIES", but be *that* ECIES.
 *
 * A general-purpose library will not do. `eciesjs`, the obvious choice, defaults to HKDF-SHA256 and
 * AES-256-GCM; go-ethereum uses NIST SP 800-56 Concat-KDF and AES-128-CTR with a separate
 * HMAC-SHA-256 tag. Those produce incompatible ciphertext, and the failure mode is the worst kind:
 * encryption succeeds, the transaction lands on-chain, the instruction reaches the enclave, and
 * *then* decryption fails somewhere you cannot attach a debugger to. So the scheme is implemented
 * here explicitly.
 *
 * ## The scheme (ECIES_AES128_SHA256 over secp256k1)
 *
 *   R      = ephemeral keypair
 *   z      = X coordinate of (R.priv × pub), left-padded to 32 bytes
 *   K      = ConcatKDF(SHA-256, z, s1="", 32)
 *   Ke     = K[0:16]                      AES-128 key
 *   Km     = SHA-256(K[16:32])            HMAC key
 *   em     = iv ‖ AES-128-CTR(Ke, iv, plaintext)
 *   tag    = HMAC-SHA-256(Km, em ‖ s2="")
 *
 *   ciphertext = R.pubUncompressed(65) ‖ em ‖ tag(32)
 *
 * `s1` and `s2` are both empty, matching `ecies.Encrypt(rand, pub, m, nil, nil)` as the enclave
 * calls it.
 *
 * ## Verify before you trust
 *
 * This module is written against a reading of go-ethereum's source, not against a published spec —
 * `docs/fcc-research.md` records it as assumption A3. Run the round-trip test against a live
 * extension before relying on it in anger. `selfTest()` below checks internal consistency, which
 * catches a broken implementation but *cannot* catch a correct-looking implementation that
 * disagrees with Go.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { bytesToHex, hexToBytes, type Hex } from "viem";

/** AES-128: 16-byte key, 16-byte IV, and a 16-byte KDF output half. */
const KEY_LEN = 16;
const IV_LEN = 16;
const TAG_LEN = 32;
/** Uncompressed secp256k1 public key: 0x04 ‖ X(32) ‖ Y(32). */
const PUBKEY_LEN = 65;

/**
 * NIST SP 800-56 Concatenation KDF.
 *
 * Counter is a big-endian uint32 starting at 1, prepended to each hash input — not appended, which
 * is the other common convention and produces entirely different keys.
 */
function concatKDF(z: Uint8Array, s1: Uint8Array, outputLen: number): Uint8Array {
  const out = new Uint8Array(outputLen);
  let written = 0;
  let counter = 1;

  while (written < outputLen) {
    const input = new Uint8Array(4 + z.length + s1.length);
    new DataView(input.buffer).setUint32(0, counter, false); // big-endian
    input.set(z, 4);
    input.set(s1, 4 + z.length);

    const digest = sha256(input);
    const take = Math.min(digest.length, outputLen - written);
    out.set(digest.subarray(0, take), written);

    written += take;
    counter++;
  }

  return out;
}

/**
 * Derives the shared secret.
 *
 * Only the X coordinate is used, left-padded to 32 bytes. go-ethereum copies `x.Bytes()` into the
 * *end* of a 32-byte buffer, so a shared secret whose X happens to have leading zero bytes must be
 * padded, not truncated — `noble` already returns a fixed-width X, which gives the same result.
 */
function deriveSharedSecret(ephemeralPrivate: Uint8Array, recipientPublic: Uint8Array): Uint8Array {
  // `false` requests the uncompressed point; we take X only, dropping the 0x04 prefix and Y.
  const shared = secp256k1.getSharedSecret(ephemeralPrivate, recipientPublic, false);
  const x = shared.subarray(1, 33);

  const z = new Uint8Array(32);
  z.set(x, 32 - x.length);
  return z;
}

/**
 * Copies a view into a standalone ArrayBuffer for WebCrypto.
 *
 * A `Uint8Array` may be a window onto a larger — or shared — buffer, and WebCrypto's `BufferSource`
 * will not accept one backed by a `SharedArrayBuffer`. `subarray()` results from the slicing above
 * are exactly that kind of view, so copy rather than hand over `.buffer`, which would also pass the
 * *whole* underlying buffer instead of the intended window.
 */
function toBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

/** AES-128-CTR via WebCrypto. The IV is the initial counter block. */
async function aesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", toBuffer(key), { name: "AES-CTR" }, false, [
    "encrypt",
    "decrypt",
  ]);
  // 128-bit counter: go-ethereum uses cipher.NewCTR with a full-block IV, so the whole block
  // participates as the counter.
  const result = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: toBuffer(iv), length: 128 },
    cryptoKey,
    toBuffer(data),
  );
  return new Uint8Array(result);
}

/** Normalizes a recipient key to the 65-byte uncompressed form the curve library expects. */
function normalizePublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length === PUBKEY_LEN && publicKey[0] === 0x04) return publicKey;

  if (publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03)) {
    return secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  }

  throw new Error(
    `public key must be 65 bytes uncompressed or 33 bytes compressed, got ${publicKey.length}`,
  );
}

/**
 * Encrypts a payload to a secp256k1 public key.
 *
 * @param plaintext        ABI-encoded policy bytes.
 * @param recipientPubKey  The extension's public key, compressed or uncompressed.
 */
export async function eciesEncrypt(
  plaintext: Uint8Array,
  recipientPubKey: Uint8Array,
): Promise<Uint8Array> {
  const pub = normalizePublicKey(recipientPubKey);

  const ephemeralPrivate = secp256k1.utils.randomPrivateKey();
  const ephemeralPublic = secp256k1.getPublicKey(ephemeralPrivate, false); // uncompressed, 65 bytes

  const z = deriveSharedSecret(ephemeralPrivate, pub);
  const derived = concatKDF(z, new Uint8Array(0), KEY_LEN * 2);

  const encryptionKey = derived.subarray(0, KEY_LEN);
  // go-ethereum hashes the second half again before using it as the MAC key.
  const macKey = sha256(derived.subarray(KEY_LEN, KEY_LEN * 2));

  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const encrypted = await aesCtr(encryptionKey, iv, plaintext);

  // em = iv ‖ ciphertext, and the tag covers em (with s2 empty).
  const em = new Uint8Array(IV_LEN + encrypted.length);
  em.set(iv, 0);
  em.set(encrypted, IV_LEN);

  const tag = hmac(sha256, macKey, em);

  const out = new Uint8Array(PUBKEY_LEN + em.length + TAG_LEN);
  out.set(ephemeralPublic, 0);
  out.set(em, PUBKEY_LEN);
  out.set(tag, PUBKEY_LEN + em.length);
  return out;
}

/**
 * Decrypts a payload with a secp256k1 private key.
 *
 * Used by the recipient portal on a DISCLOSE reply. The enclave encrypts with go-ethereum's
 * `ecies.Encrypt`, so this is the inverse of the function above.
 */
export async function eciesDecrypt(
  ciphertext: Uint8Array,
  privateKey: Uint8Array,
): Promise<Uint8Array> {
  if (ciphertext.length < PUBKEY_LEN + IV_LEN + TAG_LEN) {
    throw new Error(`ciphertext too short: ${ciphertext.length} bytes`);
  }
  if (ciphertext[0] !== 0x04) {
    throw new Error("ciphertext does not start with an uncompressed ephemeral public key");
  }

  const ephemeralPublic = ciphertext.subarray(0, PUBKEY_LEN);
  const em = ciphertext.subarray(PUBKEY_LEN, ciphertext.length - TAG_LEN);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);

  const z = deriveSharedSecret(privateKey, ephemeralPublic);
  const derived = concatKDF(z, new Uint8Array(0), KEY_LEN * 2);

  const encryptionKey = derived.subarray(0, KEY_LEN);
  const macKey = sha256(derived.subarray(KEY_LEN, KEY_LEN * 2));

  // Authenticate before decrypting: a modified ciphertext must be rejected, not turned into
  // plaintext-shaped garbage that later parsing might half-accept.
  const expected = hmac(sha256, macKey, em);
  if (!constantTimeEqual(expected, tag)) {
    throw new Error("ECIES MAC mismatch — wrong key, or the ciphertext was modified");
  }

  const iv = em.subarray(0, IV_LEN);
  const encrypted = em.subarray(IV_LEN);
  return aesCtr(encryptionKey, iv, encrypted); // CTR is symmetric
}

/** Constant-time comparison, so a MAC check cannot be turned into a timing oracle. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/** Encrypts and returns 0x-prefixed hex, ready to pass to `requestCompute`. */
export async function encryptPolicyHex(policyAbiBytes: Hex, extensionPubKey: Hex): Promise<Hex> {
  const ciphertext = await eciesEncrypt(hexToBytes(policyAbiBytes), hexToBytes(extensionPubKey));
  return bytesToHex(ciphertext);
}

/** Decrypts a 0x-prefixed disclosure reply and parses it as JSON. */
export async function decryptDisclosure<T>(ciphertextHex: Hex, privateKeyHex: Hex): Promise<T> {
  const plaintext = await eciesDecrypt(hexToBytes(ciphertextHex), hexToBytes(privateKeyHex));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Generates a disclosure keypair for a recipient. */
export function generateDisclosureKeypair(): { privateKey: Hex; publicKey: Hex; compressed: Hex } {
  const privateKey = secp256k1.utils.randomPrivateKey();
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(secp256k1.getPublicKey(privateKey, false)),
    compressed: bytesToHex(secp256k1.getPublicKey(privateKey, true)),
  };
}

/**
 * Round-trips a payload through this module.
 *
 * Catches an internally broken implementation. It emphatically does **not** prove compatibility
 * with go-ethereum — two identically wrong implementations agree perfectly. Only encrypting here
 * and decrypting inside the real extension establishes that.
 */
export async function selfTest(): Promise<boolean> {
  const { privateKey, publicKey } = generateDisclosureKeypair();
  const message = new TextEncoder().encode("fidensur ecies self-test");

  const ciphertext = await eciesEncrypt(message, hexToBytes(publicKey));
  const decrypted = await eciesDecrypt(ciphertext, hexToBytes(privateKey));

  return constantTimeEqual(message, decrypted);
}
