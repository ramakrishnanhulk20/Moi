// Real BSC mainnet transactions behind the page. Each hash was checked with eth_getTransactionReceipt
// (status 1) before it went in; scratchpad/wo7e/check-receipts.mjs does that check again on demand.
export const PROOF = {
  firstBuy: "0x6a1623c52a0403c6aba600d8cf35fbc77a8830f614138152066c7a7d906aa9f3",
  gift1Locked: "0xc01b783813eb3cde47888012996e09031b98cc8d49408e7521a694b218e2c087",
  gift1Claimed: "0x6a13e2e8f14630a8a4777bf7bae7befa21154fe64ba0e64d58a7ccdca71978e8",
  gift2Wrapped: "0x8ec1e0666350aa500bbf2f7d36b1cd97bb8dfb2e9fd5ba328b75b899a36c38d6",
  gift2Claimed: "0x660e8ebcc983db623db05e87fa7e0c7f4583ff208f7fdb884864d86c0825e28e",
} as const;

/** A hash or address as 0x, the first four characters, three dots and the last four: 0x6a16...a9f3. */
export function shortHex(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function txUrl(hash: string): string {
  return `https://bscscan.com/tx/${hash}`;
}

export function addressCodeUrl(address: string): string {
  return `https://bscscan.com/address/${address}#code`;
}
