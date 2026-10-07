// Not covered here: Privy's real servers and real tokens. Every token is signed with a key made in
// the test, and the key set is served by a fake fetch, as Privy's own "mocking tokens" recipe
// advises. Whether the live Privy app has identity tokens switched on is a dashboard setting no
// unit test can see; access tokens need no setting.
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { getAddress } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { PrivyTokenError, verifyPrivyAccessToken, verifyPrivyIdentityToken, type PrivyTokenErrorKind } from "../src/privy.js";

const APP_ID = "cmuy05pes00wz0ckz26av3gig";
const USER = "did:privy:cm0judge0000000000000000a";
const EMBEDDED = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const EXTERNAL = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const NOW_S = 1_800_000_000;

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let privy: Keys;
let stranger: Keys;
let rotated: Keys;
let publicJwk: JWK;
let rotatedJwk: JWK;

beforeAll(async () => {
  privy = await generateKeyPair("ES256", { extractable: true });
  stranger = await generateKeyPair("ES256", { extractable: true });
  rotated = await generateKeyPair("ES256", { extractable: true });
  publicJwk = { ...(await exportJWK(privy.publicKey)), kid: "privy-1", alg: "ES256", use: "sig" };
  rotatedJwk = { ...(await exportJWK(rotated.publicKey)), kid: "privy-2", alg: "ES256", use: "sig" };
});

const LINKED = JSON.stringify([
  { type: "email", address: "judge@example.com", lv: NOW_S },
  { type: "wallet", address: EMBEDDED, chain_type: "ethereum", wallet_client_type: "privy", id: "w1", lv: NOW_S },
  { type: "wallet", address: EXTERNAL, chain_type: "ethereum", wallet_client_type: "metamask", lv: NOW_S },
  { type: "wallet", address: "So11111111111111111111111111111111111111112", chain_type: "solana", wallet_client_type: "privy", lv: NOW_S },
  { type: "smart_wallet", address: EXTERNAL, smart_wallet_type: "kernel", lv: NOW_S },
]);

let urlCount = 0;
type Served = { jwks: unknown; status?: number };
// A fresh key set address per call keeps each test out of the module's ten-minute cache. Each fetch
// serves the next response in order, and the last one repeats.
function keySet(...served: Served[]) {
  const responses = served.length > 0 ? served : [{ jwks: { keys: [publicJwk] } }];
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const r = responses[Math.min(calls.length, responses.length - 1)]!;
    calls.push(String(url));
    return new Response(JSON.stringify(r.jwks), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  urlCount += 1;
  return { jwksUrl: `https://keys.test/${urlCount}/jwks.json`, fetchImpl, calls };
}

async function mint(
  opts: {
    payload?: JWTPayload;
    claims?: JWTPayload;
    key?: Keys["privateKey"] | Uint8Array;
    alg?: string;
    kid?: string;
    iss?: string;
    aud?: string | string[];
    exp?: number;
  } = {},
) {
  return new SignJWT({ ...(opts.payload ?? { linked_accounts: LINKED }), ...opts.claims })
    .setProtectedHeader({ alg: opts.alg ?? "ES256", typ: "JWT", kid: opts.kid ?? "privy-1" })
    .setIssuer(opts.iss ?? "privy.io")
    .setAudience(opts.aud ?? APP_ID)
    .setSubject(USER)
    .setIssuedAt(NOW_S - 60)
    .setExpirationTime(opts.exp ?? NOW_S + 3600)
    .sign(opts.key ?? privy.privateKey);
}

// An access token in the shape Privy documents: sid, sub, iss, aud, iat and exp, no user data.
const mintAccess = (opts: Parameters<typeof mint>[0] = {}) => mint({ ...opts, payload: { sid: "cm0session000000000000000a" } });

const at = (seconds: number) => () => seconds * 1000;

async function refusal(token: string, set = keySet(), now = at(NOW_S), verify: typeof verifyPrivyAccessToken = verifyPrivyIdentityToken): Promise<PrivyTokenErrorKind> {
  try {
    await verify(token, { appId: APP_ID, jwksUrl: set.jwksUrl, fetchImpl: set.fetchImpl, now });
  } catch (err) {
    expect(err).toBeInstanceOf(PrivyTokenError);
    const message = (err as Error).message;
    expect(message).not.toContain(token);
    expect(message).not.toContain(USER);
    return (err as PrivyTokenError).kind;
  }
  throw new Error("expected a refusal");
}

describe("verifyPrivyIdentityToken", () => {
  it("accepts a valid token and returns only the embedded Ethereum wallets, checksummed", async () => {
    const set = keySet();
    const result = await verifyPrivyIdentityToken(await mint(), { appId: APP_ID, jwksUrl: set.jwksUrl, fetchImpl: set.fetchImpl, now: at(NOW_S) });
    expect(result).toEqual({ userId: USER, wallets: [getAddress(EMBEDDED)] });
  });

  it("refuses a token for another app", async () => {
    expect(await refusal(await mint({ aud: "someotherapp" }))).toBe("invalid");
    expect(await refusal(await mint({ aud: [APP_ID, "someotherapp"] }))).toBe("invalid");
  });

  it("refuses a token from another issuer", async () => {
    expect(await refusal(await mint({ iss: "evil.io" }))).toBe("invalid");
  });

  it("refuses an expired token past 60 seconds of skew, and allows it within them", async () => {
    const token = await mint({ exp: NOW_S - 61 });
    expect(await refusal(token)).toBe("expired");
    const set = keySet();
    const inside = await verifyPrivyIdentityToken(await mint({ exp: NOW_S - 59 }), { appId: APP_ID, jwksUrl: set.jwksUrl, fetchImpl: set.fetchImpl, now: at(NOW_S) });
    expect(inside.userId).toBe(USER);
  });

  it("refuses an HS256 token, even one keyed with the public key text", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
    expect(await refusal(await mint({ alg: "HS256", key: secret }))).toBe("invalid");
  });

  it("refuses a token signed by a key that is not in the key set", async () => {
    expect(await refusal(await mint({ key: stranger.privateKey }))).toBe("invalid");
    expect(await refusal(await mint({ key: stranger.privateKey, kid: "stranger-1" }))).toBe("invalid");
  });

  it("refuses a token whose payload was changed after signing", async () => {
    const [header, payload, signature] = (await mint()).split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    claims.linked_accounts = JSON.stringify([{ type: "wallet", address: EXTERNAL, chain_type: "ethereum", wallet_client_type: "privy" }]);
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    expect(await refusal(forged)).toBe("invalid");
  });

  it("refuses guest accounts and unreadable user data", async () => {
    expect(await refusal(await mint({ claims: { guest: "t" } }))).toBe("guest_account");
    expect(await refusal(await mint({ claims: { linked_accounts: "not json" } }))).toBe("bad_claims");
    const badWallet = JSON.stringify([{ type: "wallet", address: "0x1234", chain_type: "ethereum", wallet_client_type: "privy" }]);
    expect(await refusal(await mint({ claims: { linked_accounts: badWallet } }))).toBe("bad_claims");
  });

  it("refuses a malformed token before any key fetch, and a broken key set as unavailable", async () => {
    const set = keySet();
    expect(await refusal("not.a-token", set)).toBe("malformed");
    expect(set.calls).toHaveLength(0);
    expect(await refusal(await mint(), keySet({ jwks: { keys: [publicJwk] }, status: 500 }))).toBe("keys_unavailable");
    expect(await refusal(await mint(), keySet({ jwks: { keys: [{ kty: "oct", k: "c2VjcmV0" }] } }))).toBe("keys_unavailable");
  });

  it("fetches the key set once per ten minutes", async () => {
    const set = keySet();
    const token = await mint({ exp: NOW_S + 7200 });
    const opts = (seconds: number) => ({ appId: APP_ID, jwksUrl: set.jwksUrl, fetchImpl: set.fetchImpl, now: at(seconds) });
    await verifyPrivyIdentityToken(token, opts(NOW_S));
    await verifyPrivyIdentityToken(token, opts(NOW_S + 599));
    expect(set.calls).toHaveLength(1);
    await verifyPrivyIdentityToken(token, opts(NOW_S + 600));
    expect(set.calls).toHaveLength(2);
  });

  it("refetches the key set once for an unknown key id, at most once per 60 seconds, keeping working keys", async () => {
    const both = { keys: [publicJwk, rotatedJwk] };
    const set = keySet({ jwks: { keys: [publicJwk] } }, { jwks: both }, { jwks: both, status: 500 });
    const opts = (seconds: number) => ({ appId: APP_ID, jwksUrl: set.jwksUrl, fetchImpl: set.fetchImpl, now: at(seconds) });
    const newKeyToken = await mint({ key: rotated.privateKey, kid: "privy-2", exp: NOW_S + 7200 });
    const madeUpKid = await mint({ key: stranger.privateKey, kid: "nobody", exp: NOW_S + 7200 });

    expect(await refusal(newKeyToken, set, at(NOW_S))).toBe("invalid");
    expect(set.calls).toHaveLength(1);
    expect((await verifyPrivyIdentityToken(newKeyToken, opts(NOW_S + 60))).userId).toBe(USER);
    expect(set.calls).toHaveLength(2);

    expect(await refusal(madeUpKid, set, at(NOW_S + 61))).toBe("invalid");
    expect(set.calls).toHaveLength(2);
    // The next refetch fails at Privy's end; the keys already held stay in use.
    expect(await refusal(madeUpKid, set, at(NOW_S + 121))).toBe("invalid");
    expect(set.calls).toHaveLength(3);
    expect((await verifyPrivyIdentityToken(newKeyToken, opts(NOW_S + 122))).userId).toBe(USER);
    expect(set.calls).toHaveLength(3);
  });
});

describe("verifyPrivyAccessToken", () => {
  const access = (token: string, set = keySet()) => refusal(token, set, at(NOW_S), verifyPrivyAccessToken);

  it("accepts a valid access token and returns the user id from sub", async () => {
    const set = keySet();
    const result = await verifyPrivyAccessToken(await mintAccess(), { appId: APP_ID, jwksUrl: set.jwksUrl, fetchImpl: set.fetchImpl, now: at(NOW_S) });
    expect(result).toEqual({ userId: USER });
  });

  it("refuses a token for another app or from another issuer", async () => {
    expect(await access(await mintAccess({ aud: "someotherapp" }))).toBe("invalid");
    expect(await access(await mintAccess({ aud: [APP_ID, "someotherapp"] }))).toBe("invalid");
    expect(await access(await mintAccess({ iss: "evil.io" }))).toBe("invalid");
  });

  it("refuses an expired token past 60 seconds of skew", async () => {
    expect(await access(await mintAccess({ exp: NOW_S - 61 }))).toBe("expired");
  });

  it("refuses an HS256 token and a token signed by a key not in the key set", async () => {
    expect(await access(await mintAccess({ alg: "HS256", key: new TextEncoder().encode(JSON.stringify(publicJwk)) }))).toBe("invalid");
    expect(await access(await mintAccess({ key: stranger.privateKey }))).toBe("invalid");
    expect(await access(await mintAccess({ key: stranger.privateKey, kid: "stranger-1" }))).toBe("invalid");
  });

  it("refuses a token whose payload was changed after signing, or that lacks a session id", async () => {
    const [header, payload, signature] = (await mintAccess()).split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    claims.sub = "did:privy:someoneelse000000000000000";
    expect(await access(`${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`)).toBe("invalid");
    expect(await access(await mint({ payload: {} }))).toBe("bad_claims");
  });
});
