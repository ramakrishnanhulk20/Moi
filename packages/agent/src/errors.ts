/** A refusal written for the sender. Its message never holds the claim key or the link (C12). */
export class GiftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiftError";
  }
}

/** The sender answered no at a confirmation. Nothing after that question ran. */
export class GiftCancelled extends GiftError {
  constructor(message: string) {
    super(message);
    this.name = "GiftCancelled";
  }
}

/**
 * The gift exists in the vault and its link file is saved with a "not wrapped yet" line, but the
 * wrapping fee was declined, refused or not settled. `npm run moi -- wrap <id>` finishes it.
 */
export class GiftNotWrapped extends GiftError {
  readonly giftId: bigint;
  readonly linkFile: string;
  readonly declined: boolean;
  constructor(giftId: bigint, linkFile: string, declined: boolean, message: string) {
    super(message);
    this.name = "GiftNotWrapped";
    this.giftId = giftId;
    this.linkFile = linkFile;
    this.declined = declined;
  }
}

/** The wrapping payment reached the server, but Binance's settlement had not finished in time. */
export class WrapStillSettling extends GiftError {
  constructor(message: string) {
    super(message);
    this.name = "WrapStillSettling";
  }
}
