import { config } from "zod";

// The page's Content Security Policy forbids eval. Zod checks whether it may build a fast parser by
// trying `new Function`, and a strict policy reports that caught attempt as a violation. Turning the
// fast parser off first skips the attempt. This must run before core's schemas are built, so it is
// the first import of ClaimPage and the work happens here, as the module loads.
config({ jitless: true });
