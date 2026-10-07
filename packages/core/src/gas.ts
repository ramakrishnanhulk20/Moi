import type { Address, Hex, PublicClient } from "viem";

/** Thrown when no safe gas limit exists: the estimate failed, or the padded limit is above the cap. */
export class GasLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GasLimitError";
  }
}

/**
 * The gas limit for one transaction Moi sends or hands out (DECISIONS.md): the higher of
 * `tx.gas` (a figure an API supplied, if any) and eth_estimateGas at the latest block, plus 30
 * percent, never above `cap`.
 * Throws GasLimitError when the estimate fails (a refusal, never a guess), when `cap` is not
 * above zero, or when the padded limit is above `cap`. Sends nothing.
 *
 * Why: on 2026-10-07 the Trading API's own gas figure (450,000) was below what its route needed
 * (eth_estimateGas 457,419) and a live swap ran out of gas. The higher figure plus 30 percent
 * covers that, and the cap stops a changed contract or a lying node from naming any price.
 */
export async function gasLimitFor(
  client: PublicClient,
  from: Address,
  tx: { to: Address; data: Hex; value?: bigint; gas?: bigint },
  cap: bigint,
): Promise<bigint> {
  if (cap <= 0n) throw new GasLimitError("gas cap must be above zero");
  let estimate: bigint;
  try {
    estimate = await client.estimateGas({ account: from, to: tx.to, data: tx.data, value: tx.value ?? 0n, blockTag: "latest" });
  } catch {
    throw new GasLimitError("gas estimate failed against the latest block");
  }
  const given = tx.gas ?? 0n;
  const base = estimate > given ? estimate : given;
  const limit = (base * 13n) / 10n;
  if (limit <= 0n || limit > cap) throw new GasLimitError(`gas limit ${limit} is outside 1 to ${cap}`);
  return limit;
}
