import { NextResponse, type NextRequest } from "next/server";

// The same public node as DEFAULT_BSC_RPC_URL in packages/core/src/chain.ts. The browser never gets
// the server's BSC_RPC_URL, which may carry a provider key.
const BSC_RPC_ORIGIN = "https://bsc-dataseed.bnbchain.org";

// From Privy's CSP guide (docs.privy.io/security/implementation-guide/content-security-policy):
// its iframe and WalletConnect's verify frames, its API, RPC and wallet relays, and Cloudflare
// Turnstile, the one script host Privy's base policy names, for its captcha.
const PRIVY_FRAMES = ["https://auth.privy.io", "https://verify.walletconnect.com", "https://verify.walletconnect.org"];
const PRIVY_CONNECT = [
  "https://auth.privy.io",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "wss://www.walletlink.org",
  "https://*.rpc.privy.systems",
  "https://explorer-api.walletconnect.com",
];
const TURNSTILE = "https://challenges.cloudflare.com";

// React rebuilds server error stacks with eval in development only; production never allows it.
const DEV_EVAL = process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : [];

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The one Content Security Policy for every page (C14). Scripts run only with this response's
 * nonce, which Next stamps on its own scripts, or when loaded by such a script ('strict-dynamic');
 * 'self' and the Turnstile host are the fallback for browsers without 'strict-dynamic'. Inline
 * script without the nonce never runs. Styles keep 'unsafe-inline' without a nonce, because a
 * nonce in style-src switches 'unsafe-inline' off and Privy's modal styles itself inline.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", `'nonce-${nonce}'`, "'strict-dynamic'", TURNSTILE, ...DEV_EVAL].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.bnbstatic.com",
    "font-src 'self'",
    ["connect-src 'self'", BSC_RPC_ORIGIN, ...PRIVY_CONNECT].join(" "),
    ["child-src", ...PRIVY_FRAMES].join(" "),
    ["frame-src", ...PRIVY_FRAMES, TURNSTILE].join(" "),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Gives every page request a fresh 16-byte nonce. Next reads it from the request's
 * Content-Security-Policy header and puts it on the scripts it renders; x-nonce carries it to
 * server components that load a script themselves. Both request headers are overwritten, so a
 * caller can never choose the nonce.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

// Pages only: the API sets its own headers in core's http.ts, and built assets carry no markup.
export const config = {
  matcher: ["/((?!api/|_next/static/|_next/image).*)"],
};
