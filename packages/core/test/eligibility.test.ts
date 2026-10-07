// Not covered here: where the country and region come from. These tests feed the values a hosting
// platform would put in its geolocation headers; whether the platform reports them correctly, and
// VPNs or false declarations (N4), are outside this function.
import { describe, expect, it } from "vitest";
import { checkEligibility } from "../src/eligibility.js";

const OK = { ok: true };
const restricted = { ok: false, reason: "restricted_place" };
const unknown = { ok: false, reason: "unknown_place" };
const noDeclaration = { ok: false, reason: "no_declaration" };

describe("checkEligibility", () => {
  it("refuses the US and the UK", () => {
    expect(checkEligibility({ country: "US" }, true)).toEqual(restricted);
    expect(checkEligibility({ country: "GB" }, true)).toEqual(restricted);
  });

  it("allows India and Singapore", () => {
    expect(checkEligibility({ country: "IN" }, true)).toEqual(OK);
    expect(checkEligibility({ country: "SG", region: "01" }, true)).toEqual(OK);
  });

  it("refuses every listed place, whatever the letter case or the dev flag", () => {
    for (const country of ["US", "GU", "MP", "PR", "VI", "AS", "UM", "CA", "NL", "IR", "CU", "KP", "GB", "JP"]) {
      expect(checkEligibility({ country }, true)).toEqual(restricted);
      expect(checkEligibility({ country: ` ${country.toLowerCase()} `, devAllowUnknown: true }, true)).toEqual(restricted);
    }
  });

  it("refuses Sevastopol, which sits on the Crimean peninsula under its own ISO code", () => {
    expect(checkEligibility({ country: "UA", region: "40" }, true)).toEqual(restricted);
    expect(checkEligibility({ country: "ua", region: "ua-40" }, true)).toEqual(restricted);
  });

  it("refuses Ukraine only in Crimea, Donetsk and Luhansk", () => {
    expect(checkEligibility({ country: "UA", region: "43" }, true)).toEqual(restricted);
    expect(checkEligibility({ country: "UA", region: "14" }, true)).toEqual(restricted);
    expect(checkEligibility({ country: "UA", region: "UA-09" }, true)).toEqual(restricted);
    expect(checkEligibility({ country: "UA", region: "30" }, true)).toEqual(OK);
  });

  it("fails closed for Ukraine with no region or a malformed one", () => {
    expect(checkEligibility({ country: "UA" }, true)).toEqual(unknown);
    expect(checkEligibility({ country: "UA", region: null }, true)).toEqual(unknown);
    expect(checkEligibility({ country: "UA", region: "" }, true)).toEqual(unknown);
    expect(checkEligibility({ country: "UA", region: "9" }, true)).toEqual(unknown);
    expect(checkEligibility({ country: "UA", region: "UA-CR" }, true)).toEqual(unknown);
    expect(checkEligibility({ country: "UA", devAllowUnknown: true }, true)).toEqual(unknown);
  });

  it("treats a missing country as unknown unless the dev flag is exactly true", () => {
    expect(checkEligibility({}, true)).toEqual(unknown);
    expect(checkEligibility({ country: null }, true)).toEqual(unknown);
    expect(checkEligibility({ country: "  " }, true)).toEqual(unknown);
    expect(checkEligibility({ devAllowUnknown: true }, true)).toEqual(OK);
    expect(checkEligibility({ country: null, devAllowUnknown: "true" as unknown as boolean }, true)).toEqual(unknown);
  });

  it("refuses country text that is not a real two-letter code, even with the dev flag", () => {
    for (const country of ["XX", "T1", "USA", "U", "ZZ", "QM", "AA", "1N"]) {
      expect(checkEligibility({ country, devAllowUnknown: true }, true)).toEqual(unknown);
    }
    expect(checkEligibility({ country: ["IN"] as unknown as string }, true)).toEqual(unknown);
  });

  it("needs the declaration to be exactly the boolean true", () => {
    expect(checkEligibility({ country: "IN" }, "true")).toEqual(noDeclaration);
    expect(checkEligibility({ country: "IN" }, undefined)).toEqual(noDeclaration);
    expect(checkEligibility({ country: "IN" }, 1)).toEqual(noDeclaration);
    expect(checkEligibility({ country: "IN" }, { declaration: true })).toEqual(noDeclaration);
  });

  it("reports the place before the declaration", () => {
    expect(checkEligibility({ country: "US" }, false)).toEqual(restricted);
  });
});
