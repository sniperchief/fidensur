/**
 * Turning failures into sentences.
 *
 * The contract uses custom errors throughout — they are far cheaper than revert strings — and viem
 * decodes them into names and arguments. What reaches a user without this file is
 * `ContractFunctionExecutionError: The contract function "claim" reverted with the following
 * signature: 0x646cf558`, or at best `AlreadyClaimed(1, 3)`. Both are accurate and neither tells
 * anyone what to do.
 *
 * ## The rule this file follows
 *
 * Every message answers two questions: **what happened**, and **what now**. A message that only
 * answers the first is a stack trace with better manners.
 *
 * The raw text is never thrown away — it is carried on `raw` and shown behind a disclosure, so a
 * developer debugging a genuine problem still has the selector and the arguments. Hiding it
 * entirely would trade one group's confusion for another's.
 *
 * ## What is deliberately *not* softened
 *
 * Failures that mean the user's money or round is at risk keep their edge. `CiphertextMismatch`
 * says the round cannot proceed without the exact file, because a reassuring message there would
 * cost someone a round.
 */

import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

import { ROUND_STATUS } from "./contracts";

export interface FriendlyError {
  /** One short line, suitable as a dialog heading. */
  title: string;
  /** What happened, in plain words. */
  detail: string;
  /** What to do about it. Omitted when there is genuinely nothing to do. */
  hint?: string;
  /** The original message, for the "technical details" disclosure. */
  raw?: string;
  kind: "rejected" | "contract" | "network" | "eligibility" | "unknown";
}

function statusName(value: unknown): string {
  const n = Number(value);
  return ROUND_STATUS[n] ?? `status ${String(value)}`;
}

function asDate(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "an unknown time";
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One entry per custom error in `FIDENSUR_ERRORS_ABI`.
 *
 * Keyed by the name viem decodes, so adding an error to the contract without adding it here
 * degrades to the generic contract message rather than to a selector.
 */
const CONTRACT_ERRORS: Record<
  string,
  (args: readonly unknown[]) => Omit<FriendlyError, "raw" | "kind">
> = {
  NoSuchRound: (a) => ({
    title: "That round doesn't exist",
    detail: `There is no round numbered ${String(a[0])} on this contract.`,
    hint: "Rounds are numbered from 0 in the order they were created.",
  }),

  WrongStatus: (a) => ({
    title: "This round isn't at that step yet",
    detail: `The round is currently ${statusName(a[1])}, and this action needs it to be ${statusName(a[2])}.`,
    hint: "Reload the page — someone may have advanced the round since you opened it.",
  }),

  NotOrganization: () => ({
    title: "This isn't your round",
    detail: "Only the account that created a round can fund it, commit a policy, or request its computation.",
    hint: "Switch to the account that created it, or create a round of your own.",
  }),

  InvalidClaimWindow: () => ({
    title: "Claim window out of range",
    detail: "A claim window must be at least 1 hour and at most 365 days.",
  }),

  ZeroAmount: () => ({
    title: "Amount must be greater than zero",
    detail: "Enter how much you want to put into this round.",
  }),

  NothingFunded: () => ({
    title: "Fund the round first",
    detail: "A round has to hold the money before it can promise it.",
    hint: "Go back to the funding step and deposit an amount.",
  }),

  EmptyCommitment: () => ({
    title: "No policy to commit",
    detail: "The policy commitment was empty.",
  }),

  CiphertextMismatch: () => ({
    title: "These aren't the committed bytes",
    detail:
      "The ciphertext you supplied doesn't hash to the commitment recorded on-chain, so the contract " +
      "rejected it.",
    hint:
      "Upload the exact file you downloaded when you committed. Re-encrypting the same policy " +
      "produces different bytes, so it cannot be recreated — only that file will work.",
  }),

  EmptyCiphertext: () => ({
    title: "No ciphertext supplied",
    detail: "The encrypted policy was empty.",
  }),

  RetryTooSoon: (a) => ({
    title: "Too soon to retry",
    detail: `The enclave was asked recently and hasn't answered yet. You can try again after ${asDate(a[1])}.`,
    hint: "Nothing is lost in the meantime — the round keeps its commitment and its funds.",
  }),

  NoTeeAvailable: () => ({
    title: "No enclave is available",
    detail: "No Trusted Execution Environment is currently registered to take this computation.",
    hint: "This is an infrastructure problem rather than something wrong with your round. Try again shortly.",
  }),

  PolicyCommitmentMismatch: () => ({
    title: "Result doesn't match this round's policy",
    detail: "The signed result reports a different policy commitment than the one recorded on-chain.",
    hint: "It probably belongs to another round. Check the round number.",
  }),

  ResultNotForThisRound: () => ({
    title: "Result belongs to a different round",
    detail: "The signed result's action id doesn't match this round's computation request.",
  }),

  ResultNotForThisContract: () => ({
    title: "Result belongs to a different contract",
    detail: "The signed result was produced for another deployment of Fidensur.",
  }),

  EmptyMerkleRoot: () => ({
    title: "The enclave returned nothing to settle",
    detail: "The result carried an empty Merkle root, so there is no allocation to record.",
  }),

  NoRecipients: () => ({
    title: "No recipients in the result",
    detail: "The enclave computed a result with zero recipients.",
    hint: "Check that your policy's minimum allocation isn't dropping every entry.",
  }),

  OverAllocated: (a) => ({
    title: "The policy allocates more than the round holds",
    detail: `It would pay out ${String(a[0])} wei against ${String(a[1])} wei funded.`,
    hint: "Add more funds to the round, or lower the total budget in the policy and start a new round.",
  }),

  AlreadyClaimed: () => ({
    title: "Already claimed",
    detail: "This allocation has been claimed. Each entry can only be spent once.",
    hint: "If you didn't claim it, check the round's history on the block explorer.",
  }),

  ClaimWindowClosed: (a) => ({
    title: "The claim window has closed",
    detail: `Claims for this round closed on ${asDate(a[0])}.`,
    hint: "Anything unclaimed returns to the organization. Ask them to open a new round.",
  }),

  ClaimWindowStillOpen: (a) => ({
    title: "The claim window is still open",
    detail: `Unclaimed funds can't be returned until ${asDate(a[0])}.`,
  }),

  // The single most likely error a recipient will hit, and the one most worth wording carefully:
  // it usually means "you are not in this round" rather than "your proof is corrupt".
  BadMerkleProof: () => ({
    title: "You're not eligible for this round",
    detail:
      "The proof doesn't match this round's Merkle root, which normally means this address wasn't " +
      "included in the allocation.",
    hint: "If you expected to be included, check you're on the right account and the right round number.",
  }),

  AlreadySwept: () => ({
    title: "This round has already been closed out",
    detail: "Its remaining funds were returned to the organization.",
  }),

  InvalidDisclosureKey: () => ({
    title: "The disclosure key was rejected",
    detail: "The public key sent with the request wasn't the right length.",
    hint: "Reload the page and try again — the key is generated fresh each time.",
  }),

  NothingToRescue: () => ({
    title: "Nothing to rescue",
    detail: "There is no stranded balance on this round.",
  }),

  TeeAddressNotSet: () => ({
    title: "The contract has no enclave registered",
    detail: "No TEE address has been set, so signed results cannot be verified.",
    hint: "This deployment isn't finished being set up.",
  }),

  ExtensionIdNotSet: () => ({
    title: "The contract has no extension registered",
    detail: "Computation can't be requested until the extension id is resolved on-chain.",
  }),
};

/** Messages the enclave itself returns, matched loosely because it writes prose, not codes. */
function fromEnclaveLog(log: string): Omit<FriendlyError, "raw"> | null {
  const text = log.toLowerCase();

  if (text.includes("not a recipient") || text.includes("no allocation") || text.includes("not found")) {
    return {
      kind: "eligibility",
      title: "You're not eligible for this round",
      detail: "The enclave has no allocation recorded for this address in this round.",
      hint: "Check you're connected with the account the organization included, and that the round number is right.",
    };
  }

  if (text.includes("decrypt")) {
    return {
      kind: "contract",
      title: "The enclave couldn't read the policy",
      detail: "It failed to decrypt the committed ciphertext.",
      hint: "The policy may have been encrypted to a key from a previous enclave registration. The round needs recreating.",
    };
  }

  return null;
}

/**
 * Translates anything thrown by viem, wagmi, the proxy, or our own code into something worth
 * showing a person.
 */
export function humanizeError(error: unknown): FriendlyError {
  const raw = error instanceof Error ? error.message : String(error);

  // The enclave declining a disclosure. Recognised by type rather than by matching its log text,
  // which is written for an operator reading a terminal and is free to change wording.
  if (error instanceof Error && error.name === "EligibilityError") {
    return {
      kind: "eligibility",
      title: "You're not eligible for this round",
      detail:
        "The enclave has no allocation recorded for this address in this round, so there is " +
        "nothing to disclose.",
      hint:
        "Check that you're connected with the account the organization included, and that the " +
        "round number is right.",
      raw,
    };
  }

  // Declining a signature request is a choice, not a fault, and should never be dressed up as an
  // error the user needs to solve.
  if (error instanceof BaseError) {
    const rejected = error.walk((e) => e instanceof UserRejectedRequestError);
    if (rejected) {
      return {
        kind: "rejected",
        title: "Transaction cancelled",
        detail: "You declined the request in your wallet. Nothing was sent and nothing was charged.",
        raw,
      };
    }

    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      const args = (reverted.data?.args ?? []) as readonly unknown[];

      if (name && CONTRACT_ERRORS[name]) {
        const built = CONTRACT_ERRORS[name](args);
        return {
          ...built,
          kind: name === "BadMerkleProof" ? "eligibility" : "contract",
          raw,
        };
      }

      return {
        kind: "contract",
        title: "The contract refused this action",
        detail: name
          ? `It reverted with ${name}, which this interface doesn't have a friendlier explanation for yet.`
          : "It reverted without giving a reason this interface can decode.",
        raw,
      };
    }
  }

  const text = raw.toLowerCase();

  const fromLog = fromEnclaveLog(raw);
  if (fromLog) return { ...fromLog, raw };

  if (text.includes("insufficient funds")) {
    return {
      kind: "contract",
      title: "Not enough C2FLR",
      detail: "This account can't cover the amount plus gas.",
      hint: "Top up from the Coston2 faucet at faucet.flare.network/coston2.",
      raw,
    };
  }

  if (
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("load failed") ||
    text.includes("cors")
  ) {
    return {
      kind: "network",
      title: "Couldn't reach the enclave proxy",
      detail: "The request to the confidential compute proxy failed before it got a reply.",
      hint: "The proxy may be offline. Your round is unaffected — nothing has been lost.",
      raw,
    };
  }

  if (text.includes("timed out") || text.includes("timeout")) {
    return {
      kind: "network",
      title: "The enclave didn't answer in time",
      detail: "It may still be working. Waiting and checking again is usually enough.",
      hint: "If it never answers, the computation can be requested again after 30 minutes.",
      raw,
    };
  }

  if (text.includes("addressed to")) {
    return {
      kind: "eligibility",
      title: "That reply isn't yours",
      detail: "The enclave addressed its answer to a different account than the one connected.",
      hint: "Switch back to the account that made the request.",
      raw,
    };
  }

  return {
    kind: "unknown",
    title: "Something went wrong",
    detail: "The action didn't complete. The technical details below may help.",
    raw,
  };
}

/** Convenience for the several places that only need a sentence. */
export function errorSentence(error: unknown): string {
  const friendly = humanizeError(error);
  return friendly.hint ? `${friendly.detail} ${friendly.hint}` : friendly.detail;
}
