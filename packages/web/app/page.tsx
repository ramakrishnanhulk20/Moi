import { headers } from "next/headers";
import { Hero } from "@/components/hero/Hero";
import { AgentRun } from "@/components/sections/AgentRun";
import { Credits } from "@/components/sections/Credits";
import { ForJudges } from "@/components/sections/ForJudges";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { LiveNumbers } from "@/components/sections/LiveNumbers";
import "./home.css";

export default async function Home() {
  // Privy's sign-in script needs this response's nonce to pass the page policy in proxy.ts.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <main className="home">
      <Hero />
      <HowItWorks />
      <ForJudges nonce={nonce} />
      <LiveNumbers />
      <AgentRun />
      <Credits />
    </main>
  );
}
