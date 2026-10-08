// The browser flows the website wires its buttons to. Everything here is browser-safe: viem, zod
// and Web Crypto only, with every network and wallet effect passed in through a deps object.
export {
  buildPayment,
  decodePaymentRequired,
  PaymentRequestError,
  PERMIT2_ADDRESS,
  permit2ApprovalTx,
  pickRequirement,
  WRAP_FEE_CEILING_USD,
} from "./x402.js";
export type { BuiltPayment, PaymentRequired, Permit2Approval, WalletSigner } from "./x402.js";

export { callMoi, errorCodeOf, moiErrorText, recoverPendingGift, sendGift, SendGiftError, wrapGift } from "./send.js";
export type {
  MoiApi,
  MoiReply,
  PendingGift,
  SendGiftDeps,
  SendGiftErrorCode,
  SendGiftInput,
  SendStep,
  WrapFee,
  WrapGiftDeps,
  WrapStep,
} from "./send.js";

export { claimGift, ClaimFlowError, confirmClaimed, loadGift, readLinkFromLocation } from "./claim.js";
export type { ClaimFlowErrorCode, GiftView, LoadedGift } from "./claim.js";

export { claimJudgeGift } from "./judge.js";
