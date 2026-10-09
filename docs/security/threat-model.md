# Moi threat model

This file says who would attack Moi, what they want, how their data reaches it, and the rules the code
must keep. Section C is the definition of done. Every rule is numbered so work orders and tests can cite
it. Written at the architecture gate on 2026-10-07 from `docs/security/system-description.md`, before any
code, by the reviewer using the prompt in the Monad Foundation's article on writing secure code with LLMs.
Rules marked "Ram's call" wait on a decision recorded in DECISIONS.md.

## A. App-class risk profile

In security terms Moi is five systems joined together:
1. A bearer-link escrow. One shared contract holds many people's tokens, and the only credential for a
   gift is a secret carried inside a URL. Whoever holds the link owns the gift.
2. A gas relayer. A server wallet spends its own BNB on transactions that anonymous callers ask for.
3. An authenticated proxy and transaction builder. The server signs requests to Binance's Web3 API with
   Moi's key, and hands users unsigned transactions that they sign, often without reading them.
4. A paid endpoint and a free-value faucet. /api/wrap sells a flag for a payment, and the judge button
   gives value away.
5. A page that renders other people's text next to a secret. The claim page shows the sender's note and
   token data from upstream on the same page that holds the claim key.

Categories that typically hit this class, each tied to a Moi data flow:

1. Secret leakage from capability URLs. Applies. The link `/g/<id>#<key>` travels through WhatsApp,
   email and chat. Browsers do not send the fragment in HTTP requests, but the full URL is still seen by:
   - messaging servers and email link scanners, some of which open links in a full browser
   - browser history and sync
   - any script on the claim page (wallet SDK, analytics, error reporting) that reads the page address
   - the target of any HTTP redirect from the claim page to another origin, because a redirect without
     its own fragment carries the old one forward

   One leak loses the gift.
2. Broken authorization in a multi-tenant escrow. Applies. claim(giftId, recipient, signature) is the
   only gate between a stranger and the tokens. These bugs break it:
   - raw ecrecover returns the zero address for a junk signature, so a gift stored with a zero claim key
     is claimable by anyone
   - a signature not bound to vault, chain, gift and recipient can be replayed
   - updating state after the token transfer allows a double payout through a callback
   - claim and refund both open at the same moment
   - one gift's accounting touching another's

   bStocks are beacon proxies whose code one owner key can replace. "This token makes no callbacks" is
   true today and not promised for tomorrow.
3. Time, unit and accounting errors. Applies.
   - Expiry is set by the sender's browser or agent. JavaScript time is in milliseconds and chain time is
     in seconds, so a mix-up locks tokens for a thousand times longer.
   - USDT on BSC has 18 decimals, not 6.
   - bStock raw units differ from share units, which move with uiMultiplier.
   - The vault could record the amount requested instead of the amount received.
4. Stored content injection: script injection, and phishing on a page people trust. Applies. The note
   goes from createGift onto the chain, then back out through /api/gift onto the claim page. Token names,
   tickers and logo URLs come from the RWA Data API. Script running on the claim page can read the key
   and swap the recipient. Even as plain text, a note can pretend to be Moi ("verify your wallet at ...").
5. Confused deputy against an upstream API. Applies. /api/quote and /api/wrap turn anonymous input into
   requests signed with Moi's key. If an input becomes a path segment, a query string or a key in the
   body, the attacker chooses what Moi's key signs. Upstream error bodies can also echo request headers
   back.
6. Trusting outputs that users sign. Applies. /api/quote passes on approve and swap transactions from the
   Trading API, and the sender signs them. If one carries an unlimited approval, a foreign spender or
   recipient, or no minimum output (a sandwich target on BSC), the user pays. The same holds for the
   agent paying a 402 answer or forwarding calldata.
7. Cost amplification and exhaustion. Applies.
   - /api/claim: junk claims broadcast without simulation cost the relayer gas and the attacker nothing.
   - Concurrent requests can jam the relayer's nonce queue.
   - /api/quote and /api/stocks spend the Web3 API quota, which risks throttling or suspension of the key.
   - The judge pool of 10 to 15 links empties in 15 requests.
8. Payment bypass. Applies, at /api/wrap. The bypasses are:
   - marking a gift wrapped after verify but before settle
   - reusing one payment for many gifts
   - building payment requirements from the Host header
   - comparing the verified payment to a copy parsed a different way at settle
9. Race conditions. Applies. The races are:
   - judge handout (two visitors get one link, or one visitor gets two)
   - duplicate claim broadcasts
   - the gap between verify and settle
   - the gap between simulation and inclusion
   - claim and refund at the expiry boundary
10. Command and prompt injection in the sender agent. Applies to the optional path. If `baw` command
    lines are built as shell strings from the request and from server responses, that is command
    injection on the sender's machine. If a language model reads the request and the responses, any text
    it reads (token names, notes, error messages) can steer a wallet that has contract-call.
11. Compliance abuse. Applies. The token checks the parties of each transfer. At claim the transfer goes
    from the vault to the recipient, so the original sender is never checked again. Restricted persons
    can receive, because nothing on chain checks who they are. And Moi's server, in a non-restricted
    region, relays Binance API calls for callers wherever they are.
12. Privacy leakage. Applies. The sender address, amount, time, note and recipient are public on chain,
    and they link the sender's wallet to the friend's.
13. Key management. Applies. The server holds the relayer key, the API secret, the judge claim keys and
    the b402 merchant identity. The owner key is Ram's.
14. Domain and hosting takeover, a long-tail risk. Applies. Every unclaimed link names the Moi domain. If
    the domain lapses or the hosting project is deleted, the new owner can serve a page that reads every
    key opened afterwards.
15. Front-running. Applies only in part.
    - The sender's swap can be sandwiched (see 6).
    - A claim copied from the mempool still pays the same friend, because the recipient is signed. It
      only wastes relayer gas.
    - The vault reads no prices, so oracle manipulation does not apply.

Categories that do not apply, and why:
- SQL or NoSQL injection. There is no database with a query language, and the key-value store only does
  key lookups. The nearest risk is key collision, covered by C25.
- SSRF, where the server is tricked into fetching a URL. The server fetches no user-supplied URL, and its
  hosts are fixed. This turns live if the image optimiser accepts broad remote patterns or the server
  fetches upstream logo URLs (C20 keeps it closed).
- Cross-site request forgery. No cookie or session gives /api/* any authority. Every state change is
  authorised by a signature or a payment inside the request. Revisit if Moi ever adds cookie sessions.
- File upload, path traversal and unsafe deserialization. Moi takes no files. It takes only JSON and a
  base64 JSON payment header, both parsed with size caps.
- Session management. Sign-in sessions belong to the wallet provider. Moi issues none.

## B. Threat model

### Trust boundaries
1. Internet to the Moi API: every /api/* body, path, query and header from anonymous callers.
2. Internet to GiftVault: anyone can call createGift, claim and refund with any arguments, in any order,
   while watching the mempool.
3. GiftVault to the stock tokens: every transfer runs issuer code that can pause, block, or be replaced
   by a beacon upgrade.
4. Binance Web3 API to the Moi server: quotes, unsigned transactions, stock lists, logo URLs, prices,
   b402 verify and settle results, error bodies.
5. BSC JSON-RPC to the server and pages: gift records, notes, the token list, simulations and receipts
   all arrive through a third-party node.
6. Wallet provider SDK to the claim page: the friend's address, wallet type and session.
7. Messaging channel to the friend's browser: the link, key included, passes through chat apps, email,
   scanners and browser history before it reaches the claim page.
8. Chain and upstream text to the claim page: the note and token data are rendered next to the key.
9. Moi responses to the sender's wallet and the sender agent: unsigned transactions, 402 requirements and
   links leave Moi and get signed, paid or printed.
10. The key-value store to the server: values written earlier and read back.
11. Inside the sender agent: the sender's request and every server string the agent reads, on their way
    to `baw`.
12. The build and deploy pipeline to the Moi origin: every dependency in the bundle is served on the
    domain the claim key trusts.

### Attacker-controlled inputs
Direct, to the server:
- /api/quote: the stock identifier, the USDT amount, the sender address.
- /api/claim: the gift id, the recipient address, the signature bytes.
- /api/wrap: the gift id, plus the payment header and every decoded field in it (payer, amount, asset,
  payee, nonce, deadline, network).
- /api/gift/:id and /g/:id: the id in any form (leading zeros, hex, huge, negative, not a number).
- The judge handout: how many requests, how fast, when, and the client address they claim.
- Headers on any route: Host, X-Forwarded-For, Origin, Referer, User-Agent, Content-Length, Content-Type.
- Body size, JSON nesting depth, duplicate keys.

Direct, to the chain:
- createGift: the token, the amount, the claim key address, the expiry (in any unit), the note (any
  bytes, any length).
- claim: any gift id, any recipient, any signature of any length.
- refund: any gift id, from any address.
- Unsolicited token transfers into the vault.
- Transaction ordering and gas price: front-running, and racing a claim against a refund at expiry.

Direct, to pages:
- A crafted link: any gift id with any fragment, including a real gift id paired with a key that is not
  its own.
- A malicious sender's own note.

Indirect:
- Gift fields stored on chain and read back: note, sender, claim key, amount, expiry, token.
- Web3 API responses: approve spender and amount, swap target, calldata, value, minimum output, deadline,
  token names, tickers, logo URLs, prices, market status, token addresses, b402 results, error text.
- RPC responses: any value, from a lying or stale node, or a timeout.
- Stock token behaviour: pause, blocklist and sanctions state, return values, gas used, and new code
  after a beacon upgrade.
- Wallet provider output: the address, whether it is a plain wallet or a smart account, and which chain
  it lives on.
- Key-value store values: wrapped flags and judge-handout records.
- The full link as seen by messaging servers, email scanners, in-app browsers and link previews.
- Redirect targets during the sign-in round trip.
- DNS and ownership of the Moi domain and hosting project after the hackathon.
- Everything the sender agent reads: the sender's request, server responses, 402 requirements, `baw`
  output.
- The block timestamp, which validators can shift by a few seconds.

### Privileged position and assets
- The vault's balance: every unclaimed gift from every sender, in one contract.
- The Moi origin. Browsers trust its code with the claim key in the fragment. It is the allowed origin
  for the wallet provider app, and it is printed in every link. Whoever ships code to it can read every
  key opened while that code runs.
- The relayer key and its BNB, and its role as the account that submits claims.
- The Binance Web3 API key and secret: Moi's identity and quota with Binance, and whatever endpoints the
  key can reach.
- The b402 merchant identity, which pays out to Ram's wallet.
- The judge gift claim keys the server hands out, and the key-value record of which went out.
- The vault owner key (Ram's, not on the server): it controls pause and the token list.
- Egress from a non-restricted region: Binance accepts Moi's calls on behalf of callers it would refuse
  directly.
- Not held by the server, by design: friends' claim keys, senders' wallet keys and friends' embedded
  wallet keys. A full server compromise cannot move a user gift through the server alone. It can through
  the code the server serves (N2).

### Attacker goals
1. Take someone else's unclaimed gift. The ways in:
   - a link leak through boundary 7
   - scripts or redirects on the claim page
   - script injection through a note
   - a domain taken over later
   - a weak key from a browser or the agent
   - a flaw in claim verification: a zero claim key, replay, or a double payout through a token callback
2. Make Moi pay. The ways in:
   - junk or racing /api/claim requests that the relayer broadcasts
   - scripted /api/quote and /api/stocks calls that burn the Web3 API quota until the key is throttled
     or suspended
   - a wrap recorded without a settled payment, or one payment reused across gifts
3. Empty the judge pool before judges arrive, with scripted calls to the handout or a cached handout
   response that gives away all 10 to 15 keys.
4. Make a sender sign something harmful. The ways in:
   - a quote with an unlimited approval, a foreign spender or recipient, or no minimum output
   - a 402 answer asking the agent for more money or a different payee
   - text that steers an agent holding contract-call
   - a link dressed up as a large gift to push the friend toward a phishing step
5. Use Moi against the issuer's rules, or get the issuer to freeze Moi. The ways in:
   - a sender blocked after giving a gift exits through claim to a fresh address
   - a restricted person claims through the relayer
   - enough of either that the issuer blocks the vault, freezing every gift in that token

## C. Defensive-programming standards (definition of done)

Each rule is an outcome. A work order cites it by number. The builder's report names the file and
function that upholds it and the test that proves it.

### Vault
C1. Each gift ends in exactly one final state, claimed or refunded. It pays out at most once, in full, to
exactly one address: the recipient in a valid claim, or the stored sender on refund. No sequence of calls
breaks this, including a listed token that calls back into the vault during a transfer. Proof: a
reentrancy test with a callback token, plus double claim, claim after refund and refund after claim, all
reverting.

C2. A claim succeeds only with a signature by that gift's stored claim key over: this vault's address,
the chain id at call time, that gift id and that recipient. A signature that fails to recover never
matches anything. Malleable and wrong-length signatures are rejected. This covers replay across gifts,
vaults, chains and recipients, and the zero-address match. It does not cover a stolen link (N1).

C3. No gift can exist that can be claimed without its key, shares a claim key with another gift, is
empty, or locks tokens past the maximum expiry. createGift reverts on any of these:
- a zero claim key
- a claim key any earlier gift already used
- a zero amount
- an unlisted token
- an expiry outside the allowed window, for example 1 hour to 90 days from now, which also rejects
  milliseconds passed as seconds
- a note above a fixed byte cap

C4. For every token, the vault's balance is at least the sum of its open gifts. A gift records the amount
the vault actually received, measured from its own balance, not the amount asked for. This covers a token
that takes a fee or changes after an upgrade. It does not cover the issuer burning or seizing tokens from
the vault (N3).

C5. Nobody, the owner included, can move, redirect or permanently freeze escrowed tokens.
- The vault has no upgrade path, and only claim and refund ever send gift tokens.
- Owner powers are exactly three: pause and unpause createGift and claim, edit the token list, and set
  the relayer address. None of them can move a gift without its claim key.
- Pausing or delisting never blocks refund after expiry, and delisting never blocks claims on existing
  gifts.
- Any rescue of stray tokens can take only the surplus above C4's liabilities.

C6. A gift changes state only if its token transfer succeeds. If the issuer pauses the token or blocks
the vault or the recipient, claim and refund revert whole and the gift stays open. Once the issuer allows
transfers again, the link holder can claim before expiry and the sender can refund after it.

C7. (Ram's call, decided 2026-10-07: enforce.) The vault never releases a gift whose original
sender the token would currently refuse. Claim reverts while the sender is blocked or sanctioned for that
token, judged by the token's own compliance contract at the moment of release. A compliance call that
errors counts as blocked. This covers the vault becoming an escape hatch for an address frozen after it
gave a gift. It does not cover a clean sender gifting to a bad actor's fresh address, because the token
checks recipients itself.

C8. Claim and refund share one boundary on block time: claim works only strictly before expiry, refund
only at or after it. A key that leaks after expiry is worthless. A claim to the zero address or to the
vault itself reverts. This covers those two dead ends. It does not cover other contracts that cannot move
tokens, which C16 handles off-chain.

C9. (Ram's call, decided 2026-10-07: sealed.) The note is encrypted under a key derived from the claim key
so only link holders can read it; only ciphertext reaches the chain. In addition, no Moi page lists notes from many gifts together, so one sender's note
never appears on another gift's page.

C10. A misbehaving listed token can affect only gifts in that token. No gift's state depends on another
token's return values, gas use or callbacks.

### Claim key and claim page
C11. Every claim key comes from the platform's cryptographic random source: Web Crypto in the browser,
node:crypto in the agent. Never Math.random, never a seed derived from gift data, never a key written out
by a language model.

C12. A claim key never appears in any network request: not to Moi's server, analytics, error reporting,
logs, the wallet provider or a sign-in redirect. Once the claim page reads it, the key leaves the address
bar and lives only in that tab until the claim confirms. Then it is erased. Proof: run the full claim
flow, Google sign-in included, through a recording proxy. Search every request URL, header and body for
the key in hex, with and without 0x. Zero hits.

C13. No response under /g/ redirects to another origin. Nothing navigates the claim tab to another origin
while the key is still in its URL.

C14. No attacker-influenced value runs as code on the Moi origin.
- Notes, token names, tickers and stored values render as text only, and links inside notes are not made
  clickable.
- A logo URL is used only when the standard URL parser reports https and a host Moi expects.
- A Content Security Policy forbids inline script and every third-party script except the wallet
  provider's and its bot check (Cloudflare Turnstile), and it limits where the claim page can send data.

This covers script injection through notes and upstream strings. It does not cover a compromised
dependency in Moi's own build (N2).

C15. The claim page shows a gift's contents only after confirming that the key in the link produces the
claim-key address stored on chain for that gift id, with both sides parsed by the same functions.
Otherwise it says the link is not valid. This stops a real gift id paired with a fake key from being
dressed up as a large gift.

C16. A claim is submitted only after an explicit tap by a signed-in person. Loading the page never
claims, whether a person or a link scanner's browser loads it.
- The recipient is an externally owned account on chain 56 that the friend can export. It is never a
  guest wallet, and never a smart-account address that may not exist on BSC.
- The page shows "claimed" only from a confirmed receipt showing that gift claimed to that recipient,
  never from a returned transaction hash.

### Relayer and server
C31. (Ram's call, decided 2026-10-07.) Only the relayer address the owner sets may call claim(). A
relayer that is compromised still cannot claim any gift without that gift's claim-key signature (C2); the
worst it can do is refuse to claim, and then the sender refunds after expiry (C8).

C17. The relayer key signs only transactions to the vault's claim function. The server encodes the
calldata itself from a parsed gift id, a parsed address and a 65-byte signature. The relayer owns nothing
else: it is not the vault owner, has no token allowances and is not the fee wallet. It holds a small
float, for example 0.05 BNB, which is about 10,000 claims at today's 0.05 gwei.

C18. The relayer never broadcasts a claim that fails simulation against the latest block.
- It broadcasts at most once per gift id. Concurrent requests for the same gift get the same transaction
  hash.
- It uses a fixed gas limit and a gas price ceiling, and assigns nonces one at a time.
- It answers "try again later" once a daily spend cap is reached.

This covers a free gas drain with junk claims and a jammed nonce queue. It does not cover an attacker
funding real gifts to have them claimed, which costs the attacker more than the relayer (createGift gas
plus the token), and the cap bounds it.

C19. The Web3 API key and secret, the relayer key and the judge claim keys never reach a browser, a log
line, an error message or the repo. Upstream error bodies are replaced with Moi's own short error before
they reach a client.

C20. Anonymous input reaches the Web3 API only as typed values of parameters the server names. Host,
method and path are fixed for each Moi route. No input becomes a path segment, a raw query string or a
key in a signed body. The server connects only to fixed hosts: the Web3 API, the RPC endpoint and the
wallet provider. No input or upstream field picks a host, and that includes the image optimiser.

C21. Every transaction Moi hands a sender is checked as if the sender had typed it:
- chain id 56
- approvals only to the expected router or the vault, only for the exact amount of that operation, never
  unlimited
- the swap's output token is the requested stock, and its recipient is the sender's own address
- a minimum output within a stated slippage of the quote, and a deadline
- the vault address comes from Moi's own constant, never from a response
- a Permit2 wrap payment names one spender only: b402's settlement contract
  0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633, pinned in chain.ts as B402_PERMIT2_SPENDER. Gift 2's wrap
  payment proves it: transaction 0x8ec1e0666350aa500bbf2f7d36b1cd97bb8dfb2e9fd5ba328b75b899a36c38d6 went
  to that contract and succeeded, and its Permit2 signature recovers to the payer only with that spender.
  The server drops a /supported kind that names any other spender, and the browser refuses to sign one

A quote that fails any check is refused, not repaired.

C22. Every token address Moi shows, quotes or uses is checked against the vault's on-chain token list,
read from chain. No second list exists to drift from it.
- Amounts are parsed once from decimal strings into integer base units, with decimals read from the token
  contract (USDT on BSC has 18).
- No floating-point number touches an amount.
- Share figures are computed from raw units with the token's own multiplier at read time.

C23. No anonymous caller can make Moi do unbounded work.
- Per-client and global rate limits are keyed on the client address the hosting platform supplies, never
  the leftmost X-Forwarded-For value.
- Every route has a body size cap, and every upstream and RPC call has a timeout.
- /api/stocks is served from a short cache, so traffic cannot spend the Web3 API quota.

### Wrap payments and stored state
C24. A gift is marked wrapped only after its payment has settled on chain for exactly the wrap price, in
the expected asset, on chain 56, to Ram's payout wallet from server config.
- Each settled payment marks one gift, once. A payment that verifies but does not settle marks nothing.
- The 402 payment requirements are built only from config and the parsed gift id, never from Host or
  another request header.
- The same decoded payment object goes to verify and to settle.

C25. The key-value store holds only values the server generated: parsed gift ids, booleans, timestamps,
transaction hashes. Keys are built from canonical parsed values under fixed prefixes, so no input can
reach another namespace. No request text is stored and later read back into a page.

### Judge gifts
C26. One person gets at most one judge gift, and a script cannot empty the pool.
- Each handout is atomic, so no key goes to two visitors.
- A response carrying a key is never cached by a CDN or rendered at build time.
- Judge keys live in server secrets, never in the repo, the client bundle or logs.
- One gift per network per UTC day. A network is an IPv4 address itself, or the first 64 bits of an
  IPv6 address, because one home or mobile line is handed a whole /64 and one machine can rotate
  through it.
- At most four judge gifts go out in any UTC hour, across every judge and network. The fifth claim in
  an hour is answered judges_busy and leaves no mark, and a claim that hands nothing out gives its
  place back. This bounds the rate, not the total: a script holding the judge code, several sign-ins
  and several networks can still take four gifts an hour.
- A relayer failure that may follow a broadcast (a timeout, a node naming another hash, a store error)
  keeps the judge, the network and the gift marked and answers claim_pending, so a retry is
  already_claimed, never a second gift.

A design where the server keeps the key and signs the claim for one signed-in visitor's verified wallet
never hands out a key at all, and meets this rule more strongly.

### Sender agent
C27. The sender agent never signs, approves or pays anything whose target, amount, token or payee came
from a server response or from model text without matching its own pinned values: the vault address, the
USDT address, the token list read from the vault, a fee ceiling and Ram's payee address.
- It calls `baw` with an argument array, never a shell string.
- It builds the approve and createGift calldata itself and never forwards server-supplied calldata to
  contract-call.
- The link it prints is never sent to a model provider or written to a log.
- A Permit2 wrap payment pays only b402's pinned spender (B402_PERMIT2_SPENDER, C21). The agent signs
  through Binance's wallet from the server's 402, and the server never offers another spender. The
  agent does not yet check the spender itself.

### Operations
C28. The longest allowed expiry is no longer than the time Moi commits to keep its domain and hosting
project. With C8, a link opened after the domain changes hands has already expired, so its key is
worthless.

C29. The wallet provider app accepts sessions only from Moi's production origin, plus localhost in
development.

C30. (Ram's call, decided 2026-10-07: gate.) /api/claim and /api/quote refuse requests that the hosting
platform places in the issuer's restricted places. The claim page also records the friend's "not a US
person, not in a restricted place" declaration before claiming. This covers honest users. It does not
cover VPNs or a direct on-chain claim (N4).

### Added after the backend gate review (2026-10-07)
C32. No third party can make a sender's valid createGift revert. createGift requires a signature by the
claim key over the sender's address (EIP-712, this vault's domain), so a key seen in a pending
transaction cannot be registered first by anyone else. This keeps C3's one-key-one-gift rule.

C33. No swap is handed to a sender until it passes the swap simulation check (wallet pays exactly the
amount, gains at least the minimum of the requested stock, loses nothing else, gains no allowance) on
current state. When an approval is still needed, the approval goes out alone and the swap is quoted
again after it is mined.

C34. Gas limits and gas prices in any transaction Moi sends or hands out come from Moi's own rule, never
from an upstream response: a handed-out transaction carries no gas fields (the wallet estimates), and a
transaction Moi sends uses max(upstream, eth_estimateGas) x 1.3 under a cap and the node's price under a
ceiling.

C35. A stored claim hash counts only while its transaction is pending or succeeded. A claim that reverted
or was dropped while the gift is still Open may be retried: the relayer rebroadcasts the same signed
bytes first if the transaction is unknown, and claims again if the receipt shows a revert.

C36. No request whose claim signature fails an off-chain check against the gift's stored claim key takes
a per-gift lock or any relayer resource. A waiter whose lock holder finished without a hash retries.

C37. The relayer refuses a claim when less than 60 seconds remain before the gift's expiry by the latest
block time, so it never pays for a claim that lands after expiry.

C38. Outside tests, the relayer refuses to start without the shared store, so every server instance sees
the same claim records, locks and spend counter.

C39. Relayer nonces come from the relayer's own counter in the shared store, reconciled with the chain
under the send lock, never from a single read of a load-balanced node.

C40. The hosted server holds only the relayer key, the Web3 API key and secret, the store token and the
judge-gift keys. It never needs the deployer key or the owner key.

### Added after the pre-deploy re-check (2026-10-07)
C41. The per-gift claim lock is still held, checked by its own token, at the moment a claim is signed;
a request that outlived its lock sends nothing (sharpens C18).

C42. A b402 payment binds to exactly one (vault, gift id) pair, and "settled" means a confirmed receipt
read from the chain with a Transfer of the exact price in a listed asset to the configured payee
(sharpens C24).

C43. The server refuses to start unless the vault's relayer() equals the address of its relayer key, and
the mainnet deploy refuses to run without an owner handover target.

### Added after Ram's Fable audit (2026-10-08)
C44. One Transfer inside one settlement receipt marks one gift, once. Before a gift is marked, the exact
Transfer the receipt check (C42) accepted is bound in the store to that vault and gift id, under the
payee, by transaction hash and log position, for good. A second gift handed the same hash takes the
next unbound exact Transfer in that receipt or is refused (settlement_unexpected), so a facilitator
that answers an old hash marks nothing and a batched settlement marks exactly as many gifts as it
holds Transfers. A replay of the same payment for the same gift finds its own binding and marks.
Sharpens C24 and C42.

C45. The wrap route reads no gift record and no receipt from a node until that node has reported chain
56; a node on another chain is "chain_unavailable" and marks nothing. The relayer and every token
reader already refuse such a node; this closes the one reader that did not.

C46. A client address or a user id is stored or logged only as a keyed hash: HMAC-SHA256 under a key
only the server holds, derived once at boot from the relayer key by HKDF with its own salt. A plain
SHA-256 of an IPv4 address is undone by trying all 2^32 addresses; the keyed hash is not. This covers
the rate-limit counters, the judge per-user and per-network marks and the eight-character tag in refusal
logs. It does not cover someone who holds the relayer key, who has the server anyway.

C47. The relayer never broadcasts a second claim for a gift because the first request's lock ran out
while its bytes were in flight. A claim's record is written before the send lock is released, and the
next holder of the send lock reads the gift's record after its own lock check and before it signs; a
record it has not already judged replaceable is the answer, with the spend reservation given back.
Sharpens C18 and C41.

C48. The sender agent trusts a mined transaction only when the chain's own copy of it carries exactly
the calldata the agent built, from the agent's wallet, to the agent's target; a receipt alone proves
nothing about the calldata, because the wallet that signed is Binance's, not the agent's. After
createGift it reads the gift back from the vault and saves a link only when the stored claim key is
the one it made and the token is the one it bought; otherwise the pending key file stays and the
sender is told they can refund after expiry. Sharpens C27.

C49. Every hosted route carries the same body cap as http.ts (8 KB) and a function time limit above the
work it does (150 seconds for /api/wrap, which polls a settlement for 25 seconds and may wait on
b402 for 25 more per call); a platform default shorter than that would cut a wrap off after the
payment settled. For the website build; nothing hosted exists yet.

C50. A payment nonce is bound per payee, payer and nonce, never per nonce alone. b402 spends an
authorization once per (payer, nonce), and Permit2 nonces are each wallet's own counter, so two
senders can both sign nonce 0; a mark without the payer would call the second sender's first payment
"reused" for 30 days. Sharpens C24.

### The five general standards, applied to Moi
1. Primitives over lists. Where Moi keeps a list, it is the only one, and its gaps are named here.
   - Token list: the vault's on-chain list is the single authority (C22). It covers "only these tokens".
     It does not cover a listed token's code changing after a beacon upgrade (N3).
   - Compliance: the token's own compliance contract is the test (C7). Moi keeps no deny list of its own.
   - Signatures: OpenZeppelin ECDSA, which rejects high-s values and bad v values and reverts instead of
     returning zero. Never raw ecrecover (C2).
   - Addresses: one library function validates and checksums every address (viem getAddress).
   - URLs: the standard URL parser decides scheme and host. Never a regex or a prefix match (C14).
   - Router: a list of one expected router (C21). It covers today's router. A router change fails closed
     until Moi updates the list.
   - Dead-end recipients: the zero address and the vault (C8). Other contracts that cannot move tokens
     are handled off-chain by C16.
   - Restricted places (C30): the issuer's list, checked by IP. It does not cover VPNs.
   - Content Security Policy origins (C14): the browser enforces them. They do not cover a compromised
     script from an allowed origin.
2. Normalize before you compare. One parser per value, shared by every place that checks or uses it.
   - Gift id: a decimal integer string, with no sign, no leading zeros and no hex, below 2^256. The same
     parse runs in /g/, /api/gift, /api/claim, /api/wrap and the store keys.
   - Address: getAddress on both sides of every comparison.
   - Claim key: exactly 64 hex characters with an optional 0x, nothing else. A trailing full stop or
     bracket added by a chat app fails as "link damaged". The same function feeds the address check
     (C15) and the signing (C16).
   - Claim message: one encoding (EIP-712 recommended), with a fixed test vector that both the Solidity
     tests and the TypeScript tests check.
   - Amounts: parseUnits with decimals read from chain.
   - Time: seconds from block timestamps everywhere: the contract, the server and the page.
   - Client address for rate limits: the hosting platform's field, through canonicalClientIp, then the
     keyed hash (C46).
   - Payment: one decoded object goes to verify, to settle, and into the comparison with the
     requirements.
   - Settlement: one Transfer, named by hash and log position, is one mark (C44).
3. Validate outputs like inputs. Each output, and the consumer that will act on it:
   - Unsigned transactions go to the sender's wallet (C21).
   - 402 requirements go to a paying agent or browser (C24, C27).
   - /api/gift JSON, note included, goes to the claim page and the agent (C14).
   - /api/stocks names, logos and addresses go to pages and the agent (C14, C22).
   - Judge links go to one visitor and never into a cache (C26).
   - Transaction hashes go to the claim page, which confirms the receipt before it says "claimed" (C16).
   - Logs and errors go to anyone with log access (C12, C19).
   - Events carrying notes go to explorers and indexers. No Moi page renders them except as text.
4. Fail closed.
   - When something fails, deny:
     - Simulation fails: no broadcast.
     - A compliance call errors: no release.
     - A quote check fails: no transaction.
     - An RPC or upstream call times out or disagrees: refuse with "try again".
     - The key-value store is unavailable: no handout and no wrap mark.
     - A key or id fails to parse: "link not valid".
     - A payment fails to parse: answer 402 again.
   - Fixed limits:
     - timeouts on every upstream call, for example 10 seconds for the Web3 API and 5 seconds for RPC
     - a body cap on every route, for example 8 KB
     - a note byte cap on chain
     - a daily relayer spend cap
5. Name the non-goals. Moi does not defend against:
   - N1. Someone who sees a link before the friend. A link is a bearer instrument, like cash in an
     envelope: whoever claims first gets the gift. That includes the sender, who generated the key and
     can always claim the gift back before the friend does.
   - N2. A compromised Moi deploy, hosting account or dependency. The fragment keeps keys out of server
     logs. It does not protect against code the server ships to the claim page.
   - N3. Issuer powers. The issuer can pause one token or all of them, and block or sanction any address,
     the vault included. One beacon-owner key can replace every bStock's code. Gifts can freeze, and Moi
     cannot override that. Whether the issuer can burn tokens held by the vault is unconfirmed. Two
     consequences named plainly: a sender blocked after gifting freezes that gift for both parties (C7
     refuses the claim and the token refuses the refund) until the issuer lifts the block; and a beacon
     upgrade that gave the same balances a second token address would let rescueSurplus treat gift
     tokens as surplus under that alias.
   - N4. Proving who the friend is. Moi does no KYC. The eligibility gate covers requests through Moi's
     relayer (the only account allowed to call claim) and honest declarations. It does not cover VPNs or a
     false declaration.
   - N5. The friend's account security at the wallet provider. A taken-over email or Google account loses
     the wallet.
   - N6. Market risk: price moves, slippage within the stated bound, and dividend changes through the
     multiplier.
   - N7. The sender agent's machine and the Binance app's spending limits. Both are the sender's to
     secure.
   - N8. Lookalike phishing domains sending fake gift links.
   - N9. Privacy of everything except the key. The sender address, recipient address, amount and timing
     are public on chain, and together they link the two wallets.
