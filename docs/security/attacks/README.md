# Attack record

Every rule in section C of [the threat model](../threat-model.md) (C1 to C50), the attack run against it,
where it ran, and what came back. Two runs produced the record on 2026-10-08:

| File | What it attacks | Command |
|---|---|---|
| [contract.txt](contract.txt) | The real GiftVault on BSC mainnet, `0x808EB6B3dC1ad50Ca114F5eA9d053BEAd958975C`, on a fork of block 126,415,011. 19 tests, 19 refused. | `cd packages/contracts && forge test --match-path "test/attacks/*" --fork-url https://bsc-dataseed.bnbchain.org -vvv` |
| [server.txt](server.txt) | The real API dispatcher `route()`, its handlers and the relayer, in process, against a fresh vault on an anvil fork of block 126,419,208. 41 attacks, 41 refused. | `npm run attacks --workspace=@moi/core` |

The contract tests act as the real owner, the real relayer, Binance's own pause and blocklist operators and
the Venus vNVDAB market, but only on the fork: nothing is signed for mainnet and no token moves on mainnet.
The server run never reads `.env`, never touches the shared store or a running server, and exits 0 only
when every attack was refused. It needs Foundry's `anvil` and a built `packages/contracts/out`. It forks from
Blast's public archive node, because a full node drops a block's state about a minute after it and a run
lasts about 90 seconds; set `MOI_ATTACK_FORK_URL` to use another archive node.

Where a row says "existing test", that unit test already is the attack, and it passes in `npm test` (core
and agent) or `forge test`. Where a rule cannot be attacked by a script, the row says why.

## The record

| Rule | The attack | Where it runs | Result |
|---|---|---|---|
| C1 | Claim live gifts 1 and 2 a second time, refund claimed gift 1 after its expiry, then refund an expired live gift and try to refund and claim it again. | Live-vault fork: `test_attack_C1_claimAgainOnGiftsAlreadyClaimedOnMainnet`, `test_attack_C1_refundAfterClaimAndSecondPayoutAfterRefund`. A token calling back into the vault: existing `test/Reentrancy.t.sol` (eight tests with a mock token, since real bStocks make no callbacks). | REFUSED GiftNotOpen; the refund paid the stored sender exactly once |
| C2 | Claim each of the eight open live gifts with a key that is not theirs, send malformed signatures, and move a valid signature to another recipient, gift, vault or chain, or malleate it to high s. | Live-vault fork: `test_attack_C2_wrongKeyAndMalformedSignaturesOnRealOpenGifts`, `test_attack_C2_validSignatureMovedToAnotherRecipientGiftVaultOrChain` | REFUSED BadSigner on 8 live gifts, ECDSAInvalidSignature, ECDSAInvalidSignatureLength, ECDSAInvalidSignatureS |
| C3 | Create a gift with a zero key, the key live gift 1 already used, a zero amount, USDT, a too-short or millisecond expiry, and a 513-byte note. | Live-vault fork: `test_attack_C3_createGiftBreakingEachRuleReverts` | REFUSED ZeroClaimKey, ClaimKeyAlreadyUsed, ZeroAmount, TokenNotListed, ExpiryOutOfRange, NoteTooLong |
| C4 | Check live liabilities against the open gifts for all nine listed tokens, then donate stray NVDAB to the vault so it counts as debt. | Live-vault fork: `test_attack_C4_liabilitiesEqualOpenGiftsAndDonationsAddNone` | REFUSED as debt: liabilities unchanged; 9 of 9 balances cover their open gifts; the next gift records exactly what arrived |
| C5 | The live owner uses every power it has against the open gifts: pause, delist, rescue, make itself relayer and claim, refund early, upgrade, renounce. | Live-vault fork: `test_attack_C5_ownerUsesEveryPowerAndMovesNoGift`, `test_attack_C5_rescueSurplusNeverReachesGiftBalances`, `test_attack_C5_renounceOwnershipReverts`, `test_attack_C5_pauseAndDelistNeverBlockRefundsOrExistingClaims`, `test_attack_C5_upgradeCallsFailAndNoProxySlotsAreSet` | REFUSED NothingToRescue, NotRelayer, BadSigner, GiftNotExpired, RenounceDisabled, no upgrade function; a rescue takes only a stray donation; refunds and existing claims still pay while paused or delisted |
| C6 | Binance pauses NVDAB, then the relayer claims a gift and a stranger refunds an expired live gift. | Live-vault fork: `test_attack_C6_issuerPauseRevertsClaimAndRefundAndGiftsStayOpen` | REFUSED TokenPaused; both gifts stay Open and pay after the unpause |
| C7 | Binance blocklists a sender, who then claims its own gift to a fresh wallet, on chain and through the API. | Live-vault fork: `test_attack_C7_issuerBlockedSenderCannotExitThroughClaim`; server in-process run | REFUSED SenderNotCompliant; API 409 sender_blocked, nothing sent |
| C8 | Refund a live gift before expiry as its sender and as a stranger, claim at or after expiry, and claim to the zero address or the vault, on chain and through the API. | Live-vault fork: `test_attack_C8_expiryBoundaryAndDeadEndRecipients`; server in-process run (2 attacks) | REFUSED GiftNotExpired, GiftExpired, BadRecipient; API 400 bad_recipient and 409 gift_expired |
| C9 | Read every live note straight from the chain, and open a note fetched from /api/gift with a key that is not the link's. | Live-vault fork: `test_attack_C9_everyLiveNoteIsSealedCiphertext`; server in-process run | 10 of 10 live notes are sealed blobs; REFUSED LinkError invalid, /api/gift carries ciphertext only |
| C10 | Make TSLAB revert on every call and pause it, then claim and refund NVDAB gifts and try to make a TSLAB gift. | Live-vault fork: `test_attack_C10_brokenTokenCannotTouchNvdabGifts` | NVDAB claim and live refund still pay; the TSLAB gift is REFUSED |
| C11 | Make a claim key while watching Math.random and Web Crypto. | Existing test: `packages/core/test/gift.test.ts` "draws from crypto.getRandomValues and never from Math.random (C11)" | PASS: keys come only from crypto.getRandomValues |
| C12 | Run the claim page's whole flow (load, sign, claim, confirm) through a recorder and search every Moi and chain request for the claim key. | Server in-process run | REFUSED: 0 hits in 2 Moi requests and 10 chain requests, gift claimed. The Google sign-in leg needs a real browser and Privy; it is the recording-proxy check in the finishing sweep |
| C13 | Not attacked here: the /g/ pages live in `packages/web`, which this order may not run or touch. | Not scriptable in this order: `web/next.config.ts` sets no redirects; the live walk in the finishing sweep requests a real /g/ link | Not run |
| C14 | Feed the stock list upstream logo URLs on javascript:, plain http, a lookalike host and a foreign host. | Server in-process run | REFUSED logoUrl null for all four (a bnbstatic.com logo passes). Text rendering and the Content Security Policy are website rules in `packages/web` |
| C15 | Open a real gift id on the claim page with a key that is not its own. | Server in-process run (`loadGift` through `route()`) | REFUSED keyMatches false: no amount, token or note shown |
| C16 | Claim to a contract recipient (the USDT token) with a valid signature. | Server in-process run | REFUSED 400 bad_recipient, nothing sent. The tap-to-claim rule is a website rule |
| C17 | Check every transaction the relayer key signed during the server run. | Server in-process run (sweep) | 4 of 4 were vault.claim with no value on chain 56; nothing else was signed |
| C18 | Send a landed claim again, and race three identical claims at the same moment. | Server in-process run (2 attacks) | REFUSED: one broadcast each, the same hash returned, relayer nonce unchanged |
| C19 | Make the Web3 API fail with secret text, then search every response and log line for the relayer key, judge seed, claim keys and judge code. | Server in-process run (2 attacks) | REFUSED 502 upstream_unavailable; 0 hits for 22 secrets in 110 responses and 73 log lines |
| C20 | Send six crafted paths: dot segments, a hex id, a leading zero, a query, an encoded slash, a store key. | Server in-process run | REFUSED 404 not_found for all six |
| C21 | Ask for a quote whose upstream approval is unlimited, and one whose approval names a foreign spender. | Server in-process run (2 attacks) | REFUSED 422 quote_refused, no swap fetched |
| C22 | Ask for a quote for TSLAB, a real bStock this vault does not list. | Server in-process run | REFUSED 400 not_listed, Web3 API never asked |
| C23 | Send 31 claims in a minute from one address with a new X-Forwarded-For each, and 20 stock-list requests from 20 addresses. | Server in-process run (2 attacks) | REFUSED 429 rate_limited on the 31st; the Web3 API was asked once for 20 requests |
| C24 | Pay the wrap fee to another address, underpay it, ask for the 402 with forged Host headers, and claim a gift whose fee was never paid. | Server in-process run (4 attacks) | REFUSED 402 payment_mismatch; payee and resource unchanged; 402 gift_not_wrapped |
| C25 | Claim with a gift id that carries a store key. | Server in-process run | REFUSED 400 bad_gift_id |
| C26 | Ask for a judge gift with a wrong code, with a 10-minute-old wallet proof, twice as the same judge, and as a second judge on the same network. | Server in-process run (4 attacks) | REFUSED 403 bad_judge_code, 401 proof_expired, 409 already_claimed, 429 too_many_from_network |
| C27 | Hand the website's payer a 402 asking 5 USD, or one paying another address. | Server in-process run; the agent's side is existing test `packages/agent/test/gift.test.ts` "refuses a 402 that asks for %s and never calls x402-payment" | REFUSED: no requirement picked, nothing signed |
| C28 | Create a gift on the live vault 90 days and one second out. | Live-vault fork: `test_attack_C28_expiryBeyondNinetyDaysReverts` | REFUSED ExpiryOutOfRange (90 days exactly is accepted). Keeping the domain for those 90 days is a process rule |
| C29 | Not attacked: the allowed origins are a setting in the Privy dashboard, outside the code. | Not scriptable: a third-party dashboard setting | Not run |
| C30 | Claim from the United States, and ask for a quote with no country from the platform. | Server in-process run (2 attacks) | REFUSED 403 restricted_place, 403 unknown_place |
| C31 | Claim a fresh gift and a live gift with a valid signature from the owner, the sender, the friend, the link holder, a stranger and vNVDAB. | Live-vault fork: `test_attack_C31_nonRelayerCannotClaimEvenWithValidSignature` | REFUSED NotRelayer |
| C32 | Copy a pending createGift and send it from another address, and use a key proof made for another sender. | Live-vault fork: `test_attack_C32_copiedKeyProofFromAnotherAddressReverts` | REFUSED BadKeyProof |
| C33 | Ask for a quote whose swap simulation sends the stock to someone else. | Server in-process run | REFUSED 422 simulation_refused |
| C34 | Look for a gas field in every handed-out transaction, and offer the relayer a gas price or gas limit above its ceiling. | Existing tests: `packages/core/test/quote.test.ts` "hands out only to, data and value: no transaction carries a gas or gasPrice field (C34)"; `relayer.test.ts` "sends nothing when the gas price is above the ceiling" and "sends nothing when the padded gas limit is above the claim cap" | PASS: no gas field handed out; nothing sent above the ceiling or cap |
| C35 | Leave a claim reverted, dropped or with its nonce taken, then ask for the gift again. | Existing tests: `packages/core/test/relayer.test.ts`, the four tests named "(C35)" | PASS: retried only when the gift is still Open, same signed bytes first |
| C36 | Claim with a signature by a key that is not the gift's. | Server in-process run | REFUSED 400 bad_signature, no claim lock taken, relayer sent nothing |
| C37 | Claim 30 seconds before the gift expires. | Server in-process run | REFUSED 409 gift_expiring, relayer sent nothing |
| C38 | Boot the server, and build the relayer, without the shared store. | Existing tests: `server.test.ts` "refuses a memory store unless MOI_ALLOW_MEMORY_STORE is exactly 1, and warns when it is used (C38)"; `relayer.test.ts` "refuses a memory store, or a wrapper around one, unless allowMemoryStore is true, and accepts the shared store (C38)" | PASS: refused to start |
| C39 | Have the node keep reporting a stale, lower pending count, or lose a nonce's bytes. | Existing tests: `relayer.test.ts`, the three tests named "(C39)" | PASS: no nonce reused |
| C40 | Boot with the deployer key present in the environment. | Existing test: `server.test.ts` "never reads DEPLOYER_PRIVATE_KEY, even when the environment holds it (C40)" | PASS: never read |
| C41 | Let a request outlive its 60-second gift lock while a second request takes the gift over. | Existing test: `relayer.test.ts` "sends one claim, not two, when a request outlives its 60 second gift lock and a second request takes it over (C41)" | PASS: one claim sent |
| C42 | Have the facilitator report success for a transaction that paid nothing, and replay one settled payment for a second gift, as it is and with its resource field stripped. | Server in-process run (3 attacks) | REFUSED 502 settlement_unexpected, 402 payment_mismatch, 402 payment_reused; b402 never asked for the replays |
| C43 | Boot with a relayer key that is not the vault's relayer, and run the mainnet deploy without an owner handover. | Existing tests: `server.test.ts` "boots only when the vault's relayer on chain is the relayer key's address (C43)"; `packages/contracts/test/fork/GiftVaultFork.t.sol` `test_deployScript_refusesMainnetDeployWithoutOwnerHandover` | PASS: BootError; NoOwnerHandover |
| C44 | Have the facilitator answer a second gift's payment with the first gift's settlement. | Server in-process run | REFUSED 502 settlement_unexpected, second gift not wrapped |
| C45 | Wrap through a node that reports chain 97. | Server in-process run | REFUSED 502 chain_unavailable |
| C46 | Search every store key and value written in the server run for client addresses and judge ids, plain or SHA-256. | Server in-process run (sweep) | 0 hits for 68 identities in 320 store writes |
| C47 | Let a request's gift lock run out during its own broadcast while a second request takes the gift over. | Existing test: `relayer.test.ts` "sends one claim, not two, when a request's gift lock runs out during its own broadcast and a second request takes the gift over (C47)" | PASS: one claim sent |
| C48 | Show the agent and the website a mined transaction whose calldata is not the one Moi built, and a gift stored under a claim key Moi did not make. | Existing tests: `packages/agent/test/gift.test.ts`, the two tests named "(C48)"; `packages/core/test/client-send.test.ts` "stops when the chain's copy of a transaction is not the calldata Moi built (C48), before locking anything" | PASS: stopped, no link saved, key file kept |
| C49 | Send a claim body over 8 KB. | Server in-process run | REFUSED 413 body_too_large. The 150-second function limit is hosting config (`maxDuration` in the web API route and `vercel.json`) |
| C50 | Have two senders pay with the same Permit2 nonce, and one sender reuse theirs. | Existing test: `packages/core/test/wrap.test.ts` "binds a payment nonce per payer, so two senders paying with the same Permit2 nonce both wrap, and one sender cannot reuse theirs" | PASS: both wrap; the reuse is refused |

## What these runs do not cover

- The server run uses fakes for three outside services: a Privy verifier that reads the access token as the
  user id (`privy.test.ts` covers the real check), a b402 facilitator that does not check the buyer's
  signature (its settle moves real U on the fork, so the receipt checks read a real Transfer), and a Web3 API
  that replays the recorded live quote answers.
- The website's pages, its Content Security Policy and its sign-in round trip are not attacked here; they
  belong to the finishing sweep's live walk and recording-proxy check.
- The fork is a copy of mainnet at one block. It proves the live code and state refuse each attack; it says
  nothing about what changes on mainnet afterwards, such as an issuer's beacon upgrade.
- The named non-goals N1 to N9 in the threat model are weaknesses Moi does not defend against, so they have
  no attack here: a seen link is a bearer instrument, a compromised deploy, issuer powers, no KYC, the
  friend's account at the wallet provider, market risk, the sender agent's machine, lookalike domains, and
  on-chain privacy.
