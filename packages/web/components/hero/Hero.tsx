import { Grain } from "./Grain";
import { HeroCopy } from "./HeroCopy";
import { HeroStage } from "./HeroStage";
import { SmoothScroll } from "./SmoothScroll";

/**
 * The whole hero: nav, copy, the envelope-and-certificate scene, the price ticker and the film
 * grain, with smooth scrolling. The stage sits after the copy in the markup so that on a phone it
 * falls below the copy without any reordering, which also keeps it out of the way of the pin.
 * Moving it to the home page is one import.
 */
export function Hero() {
  return (
    <>
      <SmoothScroll />
      <section className="hero" aria-label="Moi">
        <HeroCopy />
        <HeroStage />
        <Grain />
      </section>
    </>
  );
}
