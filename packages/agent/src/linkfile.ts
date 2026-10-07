import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseLink } from "@moi/core/src/gift.js";
import { GiftError } from "./errors.js";

// A link file is one short line; anything far bigger is not ours and is left alone.
const MAX_LINK_FILE_BYTES = 4_096;

/** The first line of a link file whose gift has not been wrapped yet. */
export function unwrappedMarker(giftId: bigint): string {
  return `# not wrapped yet: run \`npm run moi -- wrap ${giftId}\``;
}

/**
 * Writes a new link file `gift-<id>.txt` in `linkDir` (created with mode 0700) with mode 0600, and
 * never overwrites one: a name clash only happens across vaults, and losing either file would lose
 * a gift, so the new one takes the next free name, `gift-<id>-2.txt` and so on.
 */
export async function saveNewLink(linkDir: string, giftId: bigint, content: string): Promise<string> {
  await mkdir(linkDir, { recursive: true, mode: 0o700 });
  for (let n = 1; n <= 100; n += 1) {
    const file = path.join(linkDir, n === 1 ? `gift-${giftId}.txt` : `gift-${giftId}-${n}.txt`);
    try {
      await writeFile(file, content, { mode: 0o600, flag: "wx" });
      return file;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
  }
  throw new GiftError("Moi could not find a free file name for the gift link.");
}

/**
 * Replaces `file`'s content through a fresh 0600 file renamed over it. WHY: writeFile keeps an
 * existing file's mode only by luck, and an interrupted in-place write could leave half a link,
 * which would lose the key. A rename is all or nothing.
 */
export async function rewritePrivate(file: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, content, { mode: 0o600, flag: "wx" });
  try {
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * After `moi wrap`: finds the link file in `linkDir` for `giftId` that still starts with the
 * "not wrapped yet" line and holds a link to that gift, and rewrites it without that line.
 * Returns the file, or null when there is none. The key in the file is read only to rewrite it.
 */
export async function clearUnwrappedMarker(linkDir: string, giftId: bigint): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(linkDir);
  } catch {
    return null;
  }
  const own = new RegExp(`^gift-${giftId}(?:-\\d{1,3})?\\.txt$`);
  for (const name of names.filter((n) => own.test(n)).sort()) {
    const file = path.join(linkDir, name);
    const text = await readFile(file, "utf8");
    if (text.length > MAX_LINK_FILE_BYTES) continue;
    const [first, link, ...rest] = text.split("\n");
    if (first !== unwrappedMarker(giftId) || link === undefined || rest.some((line) => line.trim() !== "")) continue;
    try {
      if (parseLink(link).giftId !== giftId) continue;
    } catch {
      continue;
    }
    await rewritePrivate(file, `${link}\n`);
    return file;
  }
  return null;
}
