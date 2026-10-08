import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({ dir: "content/docs" });

export default defineConfig({
  mdxOptions: {
    // Turns each mermaid fence into a <Mermaid chart="..." /> element before the code highlighter sees it.
    remarkPlugins: [remarkMdxMermaid],
    rehypeCodeOptions: { themes: { light: "vesper", dark: "vesper" } },
  },
});
