import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";

// Gift pages are private links: a crawler must never list one, even though their keys never reach it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/g/", "/api/"] },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
