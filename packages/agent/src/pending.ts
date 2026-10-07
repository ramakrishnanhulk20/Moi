import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { giftVaultAbi } from "@moi/core/src/generated/giftVaultAbi.js";
import { buildLink, claimKeyMatches, parseClaimKey } from "@moi/core/src/gift.js";
import { readGift } from "@moi/core/src/vault.js";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { GiftDeps } from "./gift.js";
import { saveNewLink, unwrappedMarker } from "./linkfile.js";

/** First line of a key file whose createGift has been sent for approval but may not exist yet. */
export const PENDING_MARKER = "# not created yet: approve this gift in the Binance App, then run `npm run moi -- status`";

const PENDING_NAME = /^pending-(0x[0-9a-f]{40})\.txt$/;
const MAX_KEY_FILE_BYTES = 4_096;
// Bounds on what one `moi status` reads: a person has at most a few gifts waiting at once, and a
// gift approved in the App lands within the latest few hundred gifts of the vault.
const MAX_PENDING_FILES = 20;
const MAX_GIFTS_SCANNED = 1_000n;
const SCAN_BATCH = 25n;

/**
 * Saves the claim key, before the createGift transaction can exist, as
 * `${linkDir}/pending-<claim key address>.txt` with mode 0600. WHY: if the Binance App holds the
 * transaction for the sender's approval, or the process dies before the receipt, the gift can
 * still be made later, and without this file its key would be gone.
 */
export async function savePendingKey(linkDir: string, claimKey: Hex, claimKeyAddress: Address): Promise<string> {
  await mkdir(linkDir, { recursive: true, mode: 0o700 });
  const file = path.join(linkDir, `pending-${claimKeyAddress.toLowerCase()}.txt`);
  await writeFile(file, `${PENDING_MARKER}\n${claimKey}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

export async function removePendingKey(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** The pending key files in `linkDir`, at most 20, oldest name first. */
export async function listPendingKeys(linkDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(linkDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => PENDING_NAME.test(n))
    .sort()
    .slice(0, MAX_PENDING_FILES)
    .map((n) => path.join(linkDir, n));
}

async function findGiftId(client: PublicClient, vault: Address, claimKeyAddress: Address): Promise<bigint | null> {
  const next = await client.readContract({ address: vault, abi: giftVaultAbi, functionName: "nextGiftId" });
  const lowest = next - MAX_GIFTS_SCANNED > 1n ? next - MAX_GIFTS_SCANNED : 1n;
  for (let high = next - 1n; high >= lowest; high -= SCAN_BATCH) {
    const ids: bigint[] = [];
    for (let id = high; id > high - SCAN_BATCH && id >= lowest; id -= 1n) ids.push(id);
    const gifts = await Promise.all(ids.map((id) => readGift(client, vault, id)));
    const found = gifts.findIndex((g) => g.claimKey === claimKeyAddress);
    if (found >= 0) return ids[found] ?? null;
  }
  return null;
}

/**
 * For `moi status`: for each pending key file, asks the vault whether that claim key has been
 * used. If so, finds the gift id among the latest 1,000 gifts, saves the link file under the
 * "not wrapped yet" line, and only then deletes the pending file. A file that is damaged, or whose
 * key does not match its name, is left untouched. Never prints the key.
 */
export async function resolvePendingGifts(deps: Pick<GiftDeps, "client" | "pinned" | "linkDir" | "log">): Promise<void> {
  const { client, pinned, log } = deps;
  for (const file of await listPendingKeys(deps.linkDir)) {
    const text = await readFile(file, "utf8");
    const [first, keyLine] = text.split("\n");
    const named = getAddress(PENDING_NAME.exec(path.basename(file))?.[1] ?? "");
    let claimKey: Hex;
    try {
      claimKey = parseClaimKey(keyLine ?? "");
    } catch {
      log(`${file} is damaged, so Moi left it alone.`);
      continue;
    }
    if (text.length > MAX_KEY_FILE_BYTES || first !== PENDING_MARKER || !claimKeyMatches(claimKey, named)) {
      log(`${file} is damaged, so Moi left it alone.`);
      continue;
    }
    const used = await client.readContract({ address: pinned.vault, abi: giftVaultAbi, functionName: "claimKeyUsed", args: [named] });
    if (!used) {
      log(`A gift is still waiting for your OK in the Binance App; its key is kept in ${file}. If you turned it down there, you can delete that file.`);
      continue;
    }
    const giftId = await findGiftId(client, pinned.vault, named);
    if (giftId === null) {
      log(`The gift whose key is in ${file} was made, but Moi could not find its number among the latest gifts. Keep that file.`);
      continue;
    }
    const link = buildLink(pinned.linkOrigin, giftId, claimKey);
    const linkFile = await saveNewLink(deps.linkDir, giftId, `${unwrappedMarker(giftId)}\n${link}\n`);
    await removePendingKey(file);
    log(`Gift ${giftId} was made after your approval. Its link is saved in ${linkFile}, but it is not wrapped yet: run \`npm run moi -- wrap ${giftId}\`.`);
  }
}
