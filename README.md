# Moi

Moi is the cash gift guests give at a Tamil wedding, written into the family's notebook so it can be returned one day. Moi does the same with stocks, and the notebook is BNB Chain.

**Send someone their first stock with a link.** You pick a company and an amount. Moi buys the real tokenized share (a bStock on BNB Smart Chain) through the Binance Web3 API and locks it in a small vault. Your friend opens the link, signs in with email or Google, and owns the share in about thirty seconds, with no seed phrase and no gas to pay.

Built for BNB Hack: Tokenized Stocks Edition. Work in progress: the backend is being proven on BSC mainnet first; the website comes after.

## What is in this repo

| Folder | What it does |
|---|---|
| `packages/contracts` | `GiftVault`, the vault that holds a gift until the link holder claims it through Moi's relayer, or the sender takes it back after expiry. Foundry: unit, fuzz, invariant and fork tests against the real NVDAB token. |
| `packages/core` | The Binance Web3 API client and everything around it: quotes checked and simulated before anyone signs, gift link cryptography, the gas-free claim relayer, b402 gift wrapping, judge gifts, and the prove command. |
| `packages/agent` | `moi`, a sender agent for the Binance Agentic Wallet: buy, lock, wrap and hand back the link, with every address and payee pinned. |
| `docs/security` | The system description and the threat model the code is built against. |

## Run the tests

```bash
npm install
npm test
```

Contracts (needs [Foundry](https://getfoundry.sh)):

```bash
cd packages/contracts && sh install-deps.sh && forge test
```

## Status

| Piece | State |
|---|---|
| A real bStock bought through the Binance Trading API on BSC mainnet | Done: [tx](https://bscscan.com/tx/0x6a1623c52a0403c6aba600d8cf35fbc77a8830f614138152066c7a7d906aa9f3) |
| GiftVault on BSC mainnet | Live at [0x808EB6B3dC1ad50Ca114F5eA9d053BEAd958975C](https://bscscan.com/address/0x808EB6B3dC1ad50Ca114F5eA9d053BEAd958975C), source verified on Sourcify (exact match) |
| End to end on mainnet | Proved: buy, gift and gas-free claim into a brand-new wallet ([claim tx](https://bscscan.com/tx/0x6a13e2e8f14630a8a4777bf7bae7befa21154fe64ba0e64d58a7ccdca71978e8)) |
| Agentic Wallet sender agent with b402 | Proved: gift 2 made by the Binance Agentic Wallet, wrapped with a real b402 payment ([settlement](https://bscscan.com/tx/0x8ec1e0666350aa500bbf2f7d36b1cd97bb8dfb2e9fd5ba328b75b899a36c38d6)), claimed gas-free ([claim](https://bscscan.com/tx/0x660e8ebcc983db623db05e87fa7e0c7f4583ff208f7fdb884864d86c0825e28e)) |
| Website | Not started |

MIT licence.
