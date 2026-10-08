import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Local runs share the one repo-root .env with core and the agent. Vercel has no such file and sets
// every variable in the project settings. This runs before Next collects NEXT_PUBLIC_ values, so
// NEXT_PUBLIC_PRIVY_APP_ID reaches the browser bundle. Values already in the environment win.
const ROOT_ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(ROOT_ENV_FILE)) {
  try {
    process.loadEnvFile(ROOT_ENV_FILE);
  } catch {
    // The parser's own message could quote a line of the file, which holds keys.
    throw new Error("The repo-root .env exists but could not be read or parsed.");
  }
}

const WEB_DIR = fileURLToPath(new URL("./", import.meta.url));
const CORE_SRC = fileURLToPath(new URL("../core/src/", import.meta.url));

const nextConfig: NextConfig = {
  // Verification builds point this at a second folder so they never touch the running dev server's.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Otherwise next dev writes an AGENTS.md scaffold back into the app on every start.
  agentRules: false,
  poweredByHeader: false,
  // Builds run on webpack, not Turbopack: core is TypeScript source imported by ".js" paths, which
  // Turbopack 16.4 cannot map to the ".ts" files and webpack's extensionAlias can.
  webpack(config) {
    config.module.rules.push(
      {
        test: /\.[cm]?tsx?$/,
        include: [WEB_DIR, CORE_SRC],
        exclude: /[\\/]node_modules[\\/]/,
        resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
      },
      // core's env.ts finds the repo-root .env with new URL(..., import.meta.url). Left on, webpack
      // copies that file, keys included, into the build output as an asset.
      { include: CORE_SRC, parser: { url: false } },
    );
    return config;
  },
  // C13: no redirects are configured anywhere, so nothing under /g/ can send the claim tab to
  // another origin. The API sets its own headers in core's http.ts, so only pages get these. The
  // Content Security Policy is not here: proxy.ts sets it, with a fresh script nonce per request.
  async headers() {
    return [
      {
        source: "/((?!api/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // C12: a gift link's path must never travel to another site in a Referer header.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
