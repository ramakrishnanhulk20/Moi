import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Mermaid } from "./Mermaid";

export function getMDXComponents(): MDXComponents {
  return { ...defaultMdxComponents, Mermaid };
}
