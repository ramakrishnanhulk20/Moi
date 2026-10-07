import { USDT } from "@moi/core/src/chain.js";
import { getAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";

/** The most the agent will ever pay to wrap one gift, in US dollars. Moi's price is 0.05. */
export const WRAP_FEE_CEILING_USD = "0.10";

/**
 * The only values the sender agent trusts (C27). Every amount, address and payee the agent signs,
 * approves or pays is compared with these, never with a value from a server reply or model text.
 */
export type Pinned = {
  chainId: 56;
  vault: Address;
  usdt: Address;
  payTo: Address;
  wrapFeeCeilingUsd: typeof WRAP_FEE_CEILING_USD;
  serverOrigin: string;
  linkOrigin: string;
};

/** Names the environment variables that are missing or malformed, never their values. */
export class PinnedConfigError extends Error {
  readonly variables: string[];
  constructor(variables: string[]) {
    super(`Missing or malformed setting(s): ${variables.join(", ")}. Check the repo-root .env against .env.example.`);
    this.name = "PinnedConfigError";
    this.variables = variables;
  }
}

const nonZeroAddress = z
  .string()
  .refine((a) => {
    try {
      return getAddress(a) !== zeroAddress;
    } catch {
      return false;
    }
  })
  .transform((a) => getAddress(a));

// Plain http only on localhost, where a developer runs the server. The standard URL parser decides
// scheme and host, and the value must be an origin only, so `${origin}/api/...` can never be
// steered by a path, query or user name hidden in the setting.
const origin = z
  .string()
  .refine((u) => {
    try {
      const url = new URL(u);
      const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
      return schemeOk && url.href === `${url.origin}/`;
    } catch {
      return false;
    }
  })
  .transform((u) => new URL(u).origin);

const schema = z.object({
  MOI_VAULT_ADDRESS: nonZeroAddress,
  MOI_PAYOUT_ADDRESS: nonZeroAddress,
  MOI_SERVER_ORIGIN: origin,
  MOI_PUBLIC_ORIGIN: origin,
});

/**
 * Reads the agent's pinned values from `env`: MOI_VAULT_ADDRESS (the vault), MOI_PAYOUT_ADDRESS
 * (Ram's payout wallet, the only payee a wrap fee may go to), MOI_SERVER_ORIGIN (where gifts are
 * wrapped) and MOI_PUBLIC_ORIGIN (printed in gift links). Both origins must be https, or
 * http://localhost, with no path. USDT and the 0.10 USD fee ceiling are constants. Every address
 * goes through getAddress, and a zero address is refused.
 * Throws PinnedConfigError naming the failing variables only.
 */
export function loadPinned(env: Record<string, string | undefined>): Pinned {
  const blankToUndefined = (v: string | undefined) => (v === "" ? undefined : v);
  const parsed = schema.safeParse({
    MOI_VAULT_ADDRESS: blankToUndefined(env.MOI_VAULT_ADDRESS),
    MOI_PAYOUT_ADDRESS: blankToUndefined(env.MOI_PAYOUT_ADDRESS),
    MOI_SERVER_ORIGIN: blankToUndefined(env.MOI_SERVER_ORIGIN),
    MOI_PUBLIC_ORIGIN: blankToUndefined(env.MOI_PUBLIC_ORIGIN),
  });
  if (!parsed.success) {
    throw new PinnedConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "unknown")))]);
  }
  return {
    chainId: 56,
    vault: parsed.data.MOI_VAULT_ADDRESS,
    usdt: getAddress(USDT),
    payTo: parsed.data.MOI_PAYOUT_ADDRESS,
    wrapFeeCeilingUsd: WRAP_FEE_CEILING_USD,
    serverOrigin: parsed.data.MOI_SERVER_ORIGIN,
    linkOrigin: parsed.data.MOI_PUBLIC_ORIGIN,
  };
}
