import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Lives outside /api because that folder belongs to core's fixed route list.
export const { GET } = createFromSource(source);
