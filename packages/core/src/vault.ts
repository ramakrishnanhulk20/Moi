import { decodeErrorResult, getAddress, isHex, type Address, type Hex, type PublicClient } from "viem";
import { giftVaultAbi } from "./generated/giftVaultAbi.js";

export type GiftState = "None" | "Open" | "Claimed" | "Refunded";

/** A gift record as the vault stores it. Amounts are raw token units, expiry is Unix seconds. */
export type Gift = {
  token: Address;
  sender: Address;
  claimKey: Address;
  expiry: bigint;
  state: GiftState;
  amount: bigint;
  sealedNote: Hex;
};

/** The name of any custom error in the GiftVault ABI, its OpenZeppelin bases and libraries included. */
export type VaultErrorName = Extract<(typeof giftVaultAbi)[number], { type: "error" }>["name"];

// Index order is the Solidity enum order in GiftVault.State.
const STATES: readonly GiftState[] = ["None", "Open", "Claimed", "Refunded"];

const VAULT_ERROR_NAMES: ReadonlySet<string> = new Set(
  giftVaultAbi.filter((item) => item.type === "error").map((item) => item.name),
);

/**
 * Reads one gift with getGift. An id that was never created comes back with state "None".
 * Every address goes through getAddress. Throws when the call fails or the vault returns a state
 * number this code does not know (fail closed: an unknown state is never treated as Open).
 */
export async function readGift(client: PublicClient, vault: Address, giftId: bigint): Promise<Gift> {
  const raw = await client.readContract({ address: getAddress(vault), abi: giftVaultAbi, functionName: "getGift", args: [giftId] });
  const state = STATES[raw.state];
  if (state === undefined) throw new Error("The vault returned a gift state this code does not know.");
  return {
    token: getAddress(raw.token),
    sender: getAddress(raw.sender),
    claimKey: getAddress(raw.claimKey),
    expiry: BigInt(raw.expiry),
    state,
    amount: raw.amount,
    sealedNote: raw.sealedNote,
  };
}

/** The vault's token list, the single list Moi trusts (C22), each address through getAddress. */
export async function readListedTokens(client: PublicClient, vault: Address): Promise<Address[]> {
  const tokens = await client.readContract({ address: getAddress(vault), abi: giftVaultAbi, functionName: "listedTokens" });
  return tokens.map((t) => getAddress(t));
}

/** True only when the vault's own C7 test would pass for this gift's sender right now. */
export async function readSenderIsCompliant(client: PublicClient, vault: Address, giftId: bigint): Promise<boolean> {
  return client.readContract({ address: getAddress(vault), abi: giftVaultAbi, functionName: "senderIsCompliant", args: [giftId] });
}

/** The one address the vault lets call claim (C31). */
export async function readRelayer(client: PublicClient, vault: Address): Promise<Address> {
  return getAddress(await client.readContract({ address: getAddress(vault), abi: giftVaultAbi, functionName: "relayer" }));
}

function revertDataIn(node: object): Hex[] {
  const found: Hex[] = [];
  const consider = (value: unknown) => {
    if (typeof value === "string" && value.length >= 10 && isHex(value, { strict: true })) found.push(value as Hex);
  };
  const { raw, data } = node as { raw?: unknown; data?: unknown };
  consider(raw);
  consider(data);
  if (typeof data === "object" && data !== null) consider((data as { data?: unknown }).data);
  return found;
}

/**
 * Finds the revert data in a failed call and names the GiftVault custom error it encodes.
 * Walks the error and its causes (viem nests the node's reply a few levels down) and decodes
 * only against the GiftVault ABI. Returns null when there is no revert data, the selector is not
 * a GiftVault error (a token's own error, Error(string) or Panic), or the input is not an error.
 * Never throws. The returned name is one of a fixed set from the ABI, never upstream text.
 */
export function decodeVaultError(err: unknown): VaultErrorName | null {
  let node: unknown = err;
  // Real viem errors nest three or four levels; the bound keeps a cyclic cause chain finite.
  for (let depth = 0; depth < 16 && typeof node === "object" && node !== null; depth += 1) {
    for (const data of revertDataIn(node)) {
      try {
        const { errorName } = decodeErrorResult({ abi: giftVaultAbi, data });
        if (VAULT_ERROR_NAMES.has(errorName)) return errorName as VaultErrorName;
      } catch {
        // Not a GiftVault error selector; keep walking in case a deeper cause carries one.
      }
    }
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}
