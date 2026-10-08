"use client";

import "./zodNoEval";
import { useEffect, useState } from "react";
import { MoiPrivy } from "@/components/privy/MoiPrivy";
import { ClaimFlow } from "./ClaimFlow";
import { takeClaimKey, type ClaimKeyResult } from "./claimKey";
import "./claim.css";

export function ClaimPage({ giftId, nonce }: { giftId: string; nonce: string | undefined }) {
  const [boot, setBoot] = useState<ClaimKeyResult | null>(null);

  // The key leaves the address bar here, before Privy exists on the page. It waits one task so that
  // Next has finished hooking into history first: only then does the router learn the new address,
  // and a later router refresh cannot put the key back.
  useEffect(() => {
    const timer = window.setTimeout(() => setBoot(takeClaimKey(giftId)), 0);
    return () => window.clearTimeout(timer);
  }, [giftId]);

  if (boot === null) return <div className="claim-page" data-boot="waiting" />;
  return (
    <MoiPrivy nonce={nonce}>
      <ClaimFlow giftId={giftId} boot={boot} />
    </MoiPrivy>
  );
}
