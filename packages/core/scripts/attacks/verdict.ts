import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** What one attack proved: refused, with the refusal in a few words, or not, with what got through. */
export type Verdict = { refused: boolean; result: string };

/** One attack: the invariant it targets (C<n>), what it tries in plain words, and the attempt itself. */
export type Attack = { id: string; attack: string; run: () => Promise<Verdict> };

/**
 * Refused only when every check holds; otherwise the first check that failed is the result. Each
 * check is [held, what it means when it did not hold].
 */
export function verdict(result: string, checks: readonly (readonly [boolean, string])[]): Verdict {
  const failed = checks.find(([held]) => !held);
  return failed === undefined ? { refused: true, result } : { refused: false, result: failed[1] };
}

/** A brand-new externally owned address nobody holds the key to after this line. */
export function freshAddress(): `0x${string}` {
  return privateKeyToAccount(generatePrivateKey()).address;
}
