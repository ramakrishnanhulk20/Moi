import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { Brand } from "@/components/docs/Brand";
import { Grain } from "@/components/hero/Grain";
import { source } from "@/lib/source";
import "@/components/docs/docs.css";

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <div className="moi-docs">
      <Grain />
      <RootProvider theme={{ enabled: false }} search={{ options: { api: "/docs-search" } }}>
        <DocsLayout
          tree={source.getPageTree()}
          nav={{ title: <Brand />, url: "/", mode: "top" }}
          links={[
            { text: "Send a gift", url: "/send" },
            { text: "GitHub", url: "https://github.com/ramakrishnanhulk20/Moi", external: true },
          ]}
          themeSwitch={{ enabled: false }}
        >
          {children}
        </DocsLayout>
      </RootProvider>
    </div>
  );
}
