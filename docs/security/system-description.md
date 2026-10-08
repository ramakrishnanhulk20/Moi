# Moi: system description

Functional description of the system, written before any code for the threat model pass. It says what
the system does, not how it is protected.

## What Moi does

A person (the sender) gives another person (the friend) a real share of a US company as a tokenized
stock on BNB Smart Chain mainnet (chain id 56). The sender pays in USDT. The friend receives a link,
opens it in a browser, signs in with an email address or a Google account (no seed phrase), and the
stock is moved into a wallet that belongs to them. The stocks are bStocks: BEP-20 tokens issued by
Binance's partner, 1:1 backed, which record dividends by raising an on-chain multiplier (ERC-8056
`uiMultiplier()`), so one token can represent slightly more than one share.

## Components

1. **Web app** (Next.js). Public pages: landing page, "send a gift" page, claim page (`/g/...`),
   docs. Runs in the browser.
2. **Moi server** (Next.js route handlers, hosted in a non-restricted region). Holds the Binance Web3
   API key and secret and signs every Web3 API request (HMAC-SHA256 over timestamp, method, path,
   body). Exposes JSON endpoints to the web app and to the sender agent:
   - `GET /api/stocks`: the list of giftable stocks (name, ticker, logo, token address, live price,
     market status), built from the Web3 API RWA Data endpoints plus on-chain reads.
   - `POST /api/quote`: given a stock and a USDT amount, returns a Trading API quote and the
     unsigned swap and approve transactions for the sender's wallet address.
   - `POST /api/claim`: given a gift id, the friend's wallet address and a signature, submits the
     claim transaction to the chain from the relayer wallet and returns the transaction hash. Only
     gifts whose 5-cent wrapping fee has settled through b402, or gifts created by Moi's own sponsor
     wallet (judge gifts), are delivered.
   - `POST /api/wrap`: the gift-wrapping fee endpoint, priced with b402 (Binance's x402 payment
     rail): it answers HTTP 402 with payment requirements; the payer retries with a signed payment;
     the server verifies and settles it through the Web3 API b402 endpoints (`/api/v2/b402/verify`,
     `/settle`) and records that the gift with that id is wrapped.
   - `GET /api/gift/:id`: public status of a gift (stock, amount, sender's note, claimed or not,
     expiry), read from the chain.
3. **Relayer wallet**: a server-held BSC private key funded with a little BNB. It sends the claim
   transactions so the friend never needs BNB. One claim costs about 127,000 gas.
4. **GiftVault contract** (Solidity, BSC mainnet, one deployment). Holds gifted stock tokens until
   they are claimed or refunded.
   - `createGift(token, amount, claimKey, expiry, sealedNote, keyProof)`: requires `keyProof`, a
     signature by the claim key over the caller's address, so nobody can register a key they do not
     hold. Pulls `amount` of a listed stock token from the caller (the sender) into the vault, stores
     the gift with a new id, the sender's address, the claim key's public address, the expiry and
     the sealed (encrypted) note. Emits an event.
   - `claim(giftId, recipient, signature)`: if `signature` is a signature by the gift's claim key
     over (vault address, chain id, gift id, recipient), transfers the gift's tokens to `recipient`
     and marks the gift claimed. Only the relayer address set by the owner may submit it (Ram's
     decision, 2026-10-07).
   - `refund(giftId)`: after expiry, the sender can take an unclaimed gift back.
   - Owner functions: pause and unpause new gifts and claims; set the list of stock tokens that may be
     gifted; set the relayer address; send out tokens held above what open gifts owe (surplus only).
     Ownership cannot be renounced.
5. **The gift link**: `https://<moi-domain>/g/<giftId>#<claimKeyPrivateKey>`. The claim key is a fresh
   secp256k1 key pair generated in the sender's browser (or by the sender agent) for each gift. The
   public address goes into `createGift`; the private key lives only in the link's fragment, which
   browsers do not send to servers. The sender passes the link to the friend by any channel
   (WhatsApp, email, in person).
6. **Friend's wallet**: an embedded wallet from a third-party wallet provider (Privy, Dynamic or
   thirdweb) created when the friend signs in with email or Google in the claim page. The provider
   holds the key material; the friend can export the key later. The claim page reads the friend's
   wallet address from the provider SDK, signs the claim message with the claim key from the
   fragment, and calls `POST /api/claim`.
7. **Sender agent** (optional path): a script on the sender's own computer that drives the Binance
   Agentic Wallet command line (`baw ... --json`), the sender's own MPC wallet whose spending limits
   are set in the Binance app. On a request like "gift $5 of Nvidia, note 'Happy Diwali'", it calls
   `/api/quote`, runs `baw market-order swap` to buy the stock into the Agentic Wallet, runs
   `baw ... contract-call` (Developer Mode) to approve the vault and call `createGift`, pays the
   wrapping fee to `/api/wrap` with `baw x402-payment`, generates the claim key, and prints the link.
8. **Web sender path**: a sender with a browser wallet (MetaMask, Binance Web3 Wallet) connects it on
   the "send a gift" page, signs the USDT approve and swap returned by `/api/quote`, then the stock
   approve and `createGift`, and pays the wrapping fee through the same `/api/wrap`.
9. **Judge gifts**: before judging, the team creates 10 to 15 real gifts of about $1 each from its own
   wallet. The landing page shows a "claim a real share, on us" button that hands out one of these
   gift links to a visitor.
10. **External services called**: Binance Web3 API (RWA Data, Trading, Transaction for simulation and
    broadcast, Wallet, b402), a BSC JSON-RPC endpoint, the embedded wallet provider, and the stock
    token contracts.
11. **Data stores**: the chain (gifts, claims, refunds, token balances). The server keeps no
    database. A small shared key-value store (Upstash Redis) holds only values the server made:
    claim records (transaction hash and the signed transaction bytes), per-gift locks, the relayer's
    nonce counter, its stored signed transactions and daily spend, which gifts are wrapped, which
    payment (payer and nonce) paid for them and which settlement Transfer each one used, judge-gift
    handouts (keyed hashes of user and network ids), and rate-limit counters (keyed hashes of client
    addresses).

## Who calls what, from where

- Anonymous internet users call every public page and every `/api/*` endpoint.
- The friend's browser holds the claim key (from the fragment) and the embedded wallet session.
- The sender's browser or the sender agent holds the sender's wallet and creates gifts.
- The Moi server holds the Web3 API key and secret, the relayer private key, and the b402 merchant
  identity whose payout wallet belongs to Ram.
- The GiftVault owner key belongs to Ram.
- The stock tokens can be paused, and addresses can be blocked, by the issuer's admin keys, outside
  Moi's control.
- The bStocks issuer's terms do not allow US persons or residents of a list of restricted places to
  hold the tokens. Nothing on chain checks who holds them.
