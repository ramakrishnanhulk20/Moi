export type EligibilityReason = "restricted_place" | "unknown_place" | "no_declaration";

export type EligibilityResult = { ok: true } | { ok: false; reason: EligibilityReason };

// The union of two sources, each code tagged with where it comes from:
// [web3]   the Binance Web3 API prohibited regions page (reference/program/forms.md section D,
//          saved in full at reference/gift/terms/binance-web3-api-prohibited-regions.md)
// [bstocks] the bStocks terms (reference/briefs/gift-feasibility.md section 6): "Tokenized
//          Securities are not offered, sold, distributed, made available, or accessible in the
//          United States or to, or for the account or benefit of, U.S. persons."
// The bStocks sentences name no other country. This is the issuer's list, not one Moi invented
// (standard 1); it covers IP-based location only and not VPNs or false declarations (N4).
const RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set([
  "US", // United States [web3] [bstocks]
  "GU", // Guam [web3]
  "MP", // Northern Mariana Islands [web3]
  "PR", // Puerto Rico [web3]
  "VI", // U.S. Virgin Islands [web3]
  "AS", // American Samoa [web3]
  "UM", // U.S. Minor Outlying Islands [web3]
  "CA", // Canada [web3]
  "NL", // Netherlands [web3]
  "IR", // Iran [web3]
  "CU", // Cuba [web3]
  "KP", // North Korea [web3]
  "GB", // United Kingdom [web3]
  // Japan [web3], listed as conditional. The exemption needs all three of a Binance account login,
  // a KYC country off the list and a server in Japan. Moi has no Binance login, so it always applies.
  "JP",
]);

// Ukraine is refused only in these ISO 3166-2:UA regions, which the [web3] page lists under its own
// labels UA-CR, UA-DPR and UA-LPR. Hosting platforms report the part after "UA-".
const RESTRICTED_UA_REGIONS: ReadonlySet<string> = new Set([
  "43", // UA-43 Autonomous Republic of Crimea [web3] "Crimea Region"
  // UA-40 Sevastopol [web3] "Crimea Region". ISO gives the city its own code, but it sits on the
  // Crimean peninsula, so the page's Crimea entry covers it; checking 43 alone would let it through.
  "40",
  "14", // UA-14 Donetsk Oblast [web3] "Donetsk People's Republic"
  "09", // UA-09 Luhansk Oblast [web3] "Luhansk People's Republic"
]);

const COUNTRY_CODE = /^[A-Z]{2}$/;
const UA_REGION_CODE = /^(?:UA-)?([0-9]{2})$/;

// ISO 3166-1 keeps AA, QM to QZ, XA to XZ and ZZ for private use. Geolocation services use them
// for "unknown" or "anonymous proxy" (Cloudflare sends XX), so none of them names a real place.
function isUserAssigned(code: string): boolean {
  if (code === "AA" || code === "ZZ") return true;
  const [first, second] = code;
  return (first === "Q" && second !== undefined && second >= "M") || first === "X";
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * C30: decides whether a claim request may go on, from the place the hosting platform reports and
 * the friend's declaration. `country` is an ISO 3166-1 alpha-2 code and `region` the ISO 3166-2
 * subdivision part (for example "43", or "UA-43"); both are trimmed and upper-cased first.
 * Refuses, in this order:
 * - unknown_place: no country (unless `devAllowUnknown` is exactly true), a country that is not two
 *   letters, a private-use code such as XX, or Ukraine with a missing or malformed region;
 * - restricted_place: a country on the list above, or Ukraine in region 43, 40, 14 or 09;
 * - no_declaration: `declaration` is anything but the boolean true (the string "true" included).
 * Never throws. Covers honest requests through Moi only; it does not cover VPNs, a false
 * declaration or a direct on-chain call (N4).
 */
export function checkEligibility(
  ctx: { country?: string | null; region?: string | null; devAllowUnknown?: boolean },
  declaration: unknown,
): EligibilityResult {
  const place = checkPlace(ctx);
  if (!place.ok) return place;
  if (declaration !== true) return { ok: false, reason: "no_declaration" };
  return { ok: true };
}

function checkPlace(ctx: { country?: string | null; region?: string | null; devAllowUnknown?: boolean }): EligibilityResult {
  const rawCountry: unknown = ctx?.country;
  if (isMissing(rawCountry)) {
    return ctx?.devAllowUnknown === true ? { ok: true } : { ok: false, reason: "unknown_place" };
  }
  if (typeof rawCountry !== "string") return { ok: false, reason: "unknown_place" };
  const country = rawCountry.trim().toUpperCase();
  if (!COUNTRY_CODE.test(country) || isUserAssigned(country)) return { ok: false, reason: "unknown_place" };
  if (RESTRICTED_COUNTRIES.has(country)) return { ok: false, reason: "restricted_place" };
  if (country === "UA") {
    const rawRegion: unknown = ctx.region;
    if (typeof rawRegion !== "string") return { ok: false, reason: "unknown_place" };
    const region = UA_REGION_CODE.exec(rawRegion.trim().toUpperCase())?.[1];
    if (region === undefined) return { ok: false, reason: "unknown_place" };
    if (RESTRICTED_UA_REGIONS.has(region)) return { ok: false, reason: "restricted_place" };
  }
  return { ok: true };
}
