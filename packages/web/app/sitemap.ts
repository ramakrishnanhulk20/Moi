import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";

const DOCS = ["", "/how-it-works", "/getting-started", "/agent", "/faq", "/contracts", "/api", "/security"];

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return [`${origin}/`, `${origin}/send`, ...DOCS.map((page) => `${origin}/docs${page}`)].map((url) => ({ url }));
}
