"use client";

import { Environment, Html, Lightformer } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { Certificate, type CertificateProps } from "./Certificate";

const BODY_W = 2.4;
const BODY_H = 1.5;
const BODY_D = 0.05;
const FLAP_H = 0.95;
const FLAP_OPEN = -2.8;
const GOLD = "#F2B13D";
// The envelope is a hollow shell with an open top, so the lined back panel shows through the mouth.
const PANEL = 0.012;
const REST_TURN = -0.32;
const OPEN_TURN = -0.12;
const REST_LEAN = 0.12;

// The certificate is 880 by 568 CSS pixels. drei's Html turns one pixel into DISTANCE_FACTOR / 400
// world units, so a factor of 1 makes it 2.2 units wide next to the 2.4 unit envelope.
const DISTANCE_FACTOR = 1;
const CERT_PX = { w: 880, h: 568 };
const CERT_W = (CERT_PX.w * DISTANCE_FACTOR) / 400;
const CERT_H = (CERT_PX.h * DISTANCE_FACTOR) / 400;
const MOUTH_Y = BODY_H / 2;
const RISE_TO = 1.35;
// The certificate's top edge never rises closer than this to the top of the canvas, in screen pixels.
// On desktop the canvas starts under the 72px nav, so the margin clears the nav links too, with room
// for the lift toward the camera early in the flight.
const TOP_MARGIN_PX = 16;
const TOP_MARGIN_DESKTOP_PX = 112;
const SINK = 0.5;
// Mid-flight the certificate lifts toward the camera, so it clears the envelope's front panel instead of sliding through it.
const LIFT = 0.4;
const SINK_DIM = 0.65;

// In the claim layout progress.value is seconds into the opening, driven by the claim page's timeline.
// The seal breaks by 0.25, the flap is open by 1.0, the certificate rises halfway from 0.6 to 1.6 and
// holds there until the claim lands, then rises the rest of the way and settles over 1.2 more seconds.
const CLAIM_SEAL_END = 0.25;
const CLAIM_FLAP_END = 1;
const CLAIM_RISE_START = 0.6;
const CLAIM_HOLD = 1.6;
const CLAIM_SETTLE = 1.2;
// The settled certificate never grows taller than this share of the box, so on a wide, short desktop box it stays whole.
const CLAIM_MAX_HEIGHT_SHARE = 0.9;
const CLAIM_FINAL_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.04));

const FLAP_EDGE_LENGTH = Math.hypot(BODY_W / 2, FLAP_H);
const FLAP_EDGE_ANGLE = Math.atan2(FLAP_H, BODY_W / 2);

const FRONT_STRIPS: readonly { position: [number, number, number]; size: [number, number, number] }[] = [
  { position: [0, 0.66, 0.027], size: [2.24, 0.02, 0.004] },
  { position: [0, -0.66, 0.027], size: [2.24, 0.02, 0.004] },
  { position: [-1.11, 0, 0.027], size: [0.02, 1.34, 0.004] },
  { position: [1.11, 0, 0.027], size: [0.02, 1.34, 0.004] },
];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Where the envelope rests and where the certificate lands, as fractions of the canvas. Read from CSS by HeroStage. */
export type HeroLayout = { restX: number; restY: number; finalX: number; finalY: number; finalW: number };

type Parts = {
  root: RefObject<THREE.Group | null>;
  tilt: RefObject<THREE.Group | null>;
  flap: RefObject<THREE.Group | null>;
  seal: RefObject<THREE.Group | null>;
  card: RefObject<THREE.Group | null>;
  face: RefObject<HTMLDivElement | null>;
  dimmable: readonly { material: THREE.MeshStandardMaterial; base: THREE.Color; glow: number }[];
  sealMaterials: readonly THREE.MeshStandardMaterial[];
};

type Progress = { value: number };

/** "hero" is driven by scroll. "claim" fills its own box, is driven by time from outside and has no cursor tilt. */
export type SceneMode = "hero" | "claim";

function makeMaterials() {
  // Black lacquer: a dark body under a full clearcoat, so what reads against the page is the highlight and the gold.
  const body = new THREE.MeshPhysicalMaterial({ color: "#1E0E10", roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.15 });
  const foil = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.25 });
  // The seal fades out as it breaks, so both of its materials are transparent from the start.
  const seal = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.2, transparent: true });
  const emboss = new THREE.MeshStandardMaterial({ color: "#C8891E", metalness: 1, roughness: 0.3, transparent: true });
  const liner = new THREE.MeshStandardMaterial({ color: "#C8891E", metalness: 0.6, roughness: 0.35 });
  // A faint glow in each material's own colour keeps any face from going black where no light reaches it.
  const glows: [THREE.MeshStandardMaterial, number][] = [
    [body, 0.1],
    [foil, 0.3],
    [seal, 0.3],
    [emboss, 0.3],
    [liner, 0.2],
  ];
  for (const [material, glow] of glows) {
    material.emissive.copy(material.color);
    material.emissiveIntensity = glow;
  }
  // The gold takes more from the dim environment than the lacquer does, so it stays bright while the body stays black.
  for (const material of [foil, seal, emboss, liner]) material.envMapIntensity = 3;
  const dimmable = glows.map(([material, glow]) => ({ material, base: material.color.clone(), glow }));
  return { body, foil, seal, emboss, liner, dimmable, sealMaterials: [seal, emboss] };
}

/**
 * Moves every part each frame from the scroll progress (0 to 1) that GSAP ScrollTrigger publishes.
 * It sits before the certificate in the tree on purpose: drei's Html reads the group's position in
 * its own frame callback, and callbacks run in tree order, so the DOM never lags the canvas by a frame.
 */
function Animator({
  progress,
  layout,
  compact,
  mode,
  parts,
  onFirstFrame,
}: {
  progress: Progress;
  layout: HeroLayout;
  compact: boolean;
  mode: SceneMode;
  parts: Parts;
  onFirstFrame: () => void;
}) {
  const claim = mode === "claim";
  const frames = useRef(0);
  const pointer = useRef({ x: 0, y: 0 });
  const cursor = useRef({ x: 0, y: 0 });
  const eases = useMemo(
    () => ({
      power2InOut: gsap.parseEase("power2.inOut"),
      power2In: gsap.parseEase("power2.in"),
      power3Out: gsap.parseEase("power3.out"),
    }),
    [],
  );
  // Scratch objects, so a frame allocates nothing.
  const scratch = useMemo(
    () => ({
      pocketPos: new THREE.Vector3(),
      pocketQuat: new THREE.Quaternion(),
      localQuat: new THREE.Quaternion(),
      tiltInverse: new THREE.Quaternion(),
      slant: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.5, 0)),
      finalPos: new THREE.Vector3(),
      finalQuat: new THREE.Quaternion(),
      bottom: new THREE.Vector3(),
    }),
    [],
  );
  // Three turns counter-clockwise on screen with a positive z angle, the opposite of CSS rotateZ, so
  // the certificate keeps the up-to-the-right tilt of the poster drawing.
  const finalQuats = useMemo(
    () => ({
      desktop: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.24, 0.1)),
      compact: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.07)),
    }),
    [],
  );

  useEffect(() => {
    if (compact || claim) return;
    const onMove = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [compact, claim]);

  useFrame((state) => {
    const { root, tilt, flap, seal, card, face, dimmable, sealMaterials } = parts;
    if (!root.current || !tilt.current || !flap.current || !seal.current || !card.current) return;

    let flapT: number;
    let sealT: number;
    let riseT: number;
    let travelT: number;
    if (claim) {
      const seconds = Math.max(0, progress.value);
      flapT = eases.power2InOut(clamp01(seconds / CLAIM_FLAP_END));
      sealT = eases.power2In(clamp01(seconds / CLAIM_SEAL_END));
      travelT = eases.power2InOut(clamp01((seconds - CLAIM_HOLD) / CLAIM_SETTLE));
      riseT = 0.5 * eases.power3Out(clamp01((seconds - CLAIM_RISE_START) / (CLAIM_HOLD - CLAIM_RISE_START))) + 0.5 * travelT;
    } else {
      const p = clamp01(progress.value);
      flapT = eases.power2InOut(clamp01(p / 0.4));
      sealT = eases.power2In(clamp01((p - 0.04) / 0.1));
      riseT = eases.power3Out(clamp01((p - 0.3) / 0.3));
      travelT = eases.power2InOut(clamp01((p - 0.55) / 0.3));
    }

    // Objects are placed as fractions of the canvas on the z = 0 plane.
    const { viewport, size } = state;
    const float = 0.06 * Math.sin((state.clock.elapsedTime * Math.PI * 2) / 6);
    root.current.position.set(
      viewport.width * (layout.restX - 0.5),
      viewport.height * (0.5 - layout.restY) + float - SINK * travelT,
      0,
    );

    // The cursor adds up to 8 degrees on top of a three-quarter pose that turns toward the camera as the flap opens.
    const max = (8 * Math.PI) / 180;
    const targetY = compact || claim ? 0 : pointer.current.x * max;
    const targetX = compact || claim ? 0 : pointer.current.y * max;
    cursor.current.y += (targetY - cursor.current.y) * 0.08;
    cursor.current.x += (targetX - cursor.current.x) * 0.08;
    tilt.current.rotation.set(REST_LEAN + cursor.current.x, THREE.MathUtils.lerp(REST_TURN, OPEN_TURN, flapT) + cursor.current.y, 0);
    root.current.updateMatrixWorld(true);

    flap.current.rotation.x = FLAP_OPEN * flapT;

    // The seal breaks before the flap has turned far enough to show its back.
    seal.current.visible = sealT < 1;
    seal.current.scale.setScalar(Math.max(1 - sealT, 0.0001));
    for (const material of sealMaterials) material.opacity = 1 - sealT;

    // Pocket pose: the certificate rises out of the mouth, turning square to the camera on the way. On a
    // short canvas 1.35 units would push its top off the screen, so the rise stops where the top has a margin.
    const pixelsPerUnit = size.width / viewport.width;
    const restWorldY = viewport.height * (0.5 - layout.restY);
    const topMargin = size.width >= 1024 && !claim ? TOP_MARGIN_DESKTOP_PX : TOP_MARGIN_PX;
    const topLimit = viewport.height / 2 - topMargin / pixelsPerUnit;
    const rise = Math.min(RISE_TO, topLimit - CERT_H / 2 - restWorldY);
    scratch.pocketPos.set(0, rise * riseT, 0.03).applyMatrix4(tilt.current.matrixWorld);
    scratch.tiltInverse.copy(tilt.current.quaternion).invert();
    scratch.localQuat.copy(scratch.slant).slerp(scratch.tiltInverse, riseT);
    scratch.pocketQuat.copy(tilt.current.quaternion).multiply(scratch.localQuat);

    // Final pose: where the poster certificate lands, sized in screen pixels.
    let finalWidth: number;
    if (claim) {
      finalWidth = Math.min(layout.finalW * size.width, (CLAIM_MAX_HEIGHT_SHARE * size.height * CERT_PX.w) / CERT_PX.h);
    } else {
      finalWidth = compact ? layout.finalW * size.width : Math.min(layout.finalW * window.innerWidth, 1.55 * 0.62 * window.innerHeight);
    }
    const finalScale = finalWidth / (pixelsPerUnit * CERT_W);
    scratch.finalPos.set(viewport.width * (layout.finalX - 0.5), viewport.height * (0.5 - layout.finalY), 0);
    scratch.finalQuat.copy(claim ? CLAIM_FINAL_QUAT : compact ? finalQuats.compact : finalQuats.desktop);

    card.current.position.copy(scratch.pocketPos).lerp(scratch.finalPos, travelT);
    card.current.position.z += LIFT * Math.sin(Math.PI * travelT);
    card.current.quaternion.copy(scratch.pocketQuat).slerp(scratch.finalQuat, travelT);
    card.current.scale.setScalar(THREE.MathUtils.lerp(1, finalScale, travelT));

    // The part of the certificate still inside the envelope is cut off along the mouth. The cut is
    // released over the first quarter of the flight, once the certificate has started to leave the pocket.
    const element = face.current;
    if (element) {
      const certHeight = CERT_H * card.current.scale.x;
      scratch.bottom.set(0, -certHeight / 2, 0).applyQuaternion(card.current.quaternion).add(card.current.position);
      tilt.current.worldToLocal(scratch.bottom);
      const below = clamp01((MOUTH_Y - scratch.bottom.y) / certHeight);
      const inside = clamp01(1 - (scratch.bottom.z - 0.03) / 0.1);
      const released = clamp01(travelT / 0.25);
      const hidden = below * inside * (1 - released * released * (3 - 2 * released));
      element.style.visibility = riseT > 0 ? "visible" : "hidden";
      element.style.clipPath = hidden > 0.001 ? `inset(0 0 ${(hidden * 100).toFixed(2)}% 0)` : "none";
    }

    const dim = 1 - SINK_DIM * travelT;
    for (const entry of dimmable) {
      entry.material.color.copy(entry.base).multiplyScalar(dim);
      entry.material.emissiveIntensity = entry.glow * dim;
    }

    frames.current += 1;
    if (frames.current === 3) onFirstFrame();
  });

  return null;
}

function Envelope({
  progress,
  layout,
  compact,
  mode,
  certificate,
  layer,
  onFirstFrame,
}: {
  progress: Progress;
  layout: HeroLayout;
  compact: boolean;
  mode: SceneMode;
  certificate: CertificateProps | undefined;
  layer: RefObject<HTMLDivElement | null>;
  onFirstFrame: () => void;
}) {
  const root = useRef<THREE.Group>(null);
  const tilt = useRef<THREE.Group>(null);
  const flap = useRef<THREE.Group>(null);
  const seal = useRef<THREE.Group>(null);
  const card = useRef<THREE.Group>(null);
  const face = useRef<HTMLDivElement>(null);

  const materials = useMemo(makeMaterials, []);
  useEffect(
    () => () => {
      for (const { material } of materials.dimmable) material.dispose();
    },
    [materials],
  );

  const flapGeometry = useMemo(() => {
    const shape = new THREE.Shape([new THREE.Vector2(-BODY_W / 2, 0), new THREE.Vector2(BODY_W / 2, 0), new THREE.Vector2(0, -FLAP_H)]);
    return new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: false });
  }, []);
  // The gold lining is its own triangle just behind the flap, turned to face backwards, so it is the
  // face you see once the flap is open.
  const linerGeometry = useMemo(() => {
    const shape = new THREE.Shape([new THREE.Vector2(-BODY_W / 2, 0), new THREE.Vector2(BODY_W / 2, 0), new THREE.Vector2(0, -FLAP_H)]);
    return new THREE.ShapeGeometry(shape);
  }, []);
  const chevronGeometry = useMemo(() => {
    const shape = new THREE.Shape([
      new THREE.Vector2(-0.12, 0.07),
      new THREE.Vector2(0, -0.07),
      new THREE.Vector2(0.12, 0.07),
      new THREE.Vector2(0.08, 0.07),
      new THREE.Vector2(0, -0.015),
      new THREE.Vector2(-0.08, 0.07),
    ]);
    return new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: false });
  }, []);
  useEffect(
    () => () => {
      flapGeometry.dispose();
      linerGeometry.dispose();
      chevronGeometry.dispose();
    },
    [flapGeometry, linerGeometry, chevronGeometry],
  );

  const parts: Parts = { root, tilt, flap, seal, card, face, dimmable: materials.dimmable, sealMaterials: materials.sealMaterials };

  // The strips sit just inside each slanted edge of the flap, on both of its faces.
  const edgeMid = { x: BODY_W / 4, y: -FLAP_H / 2 };
  const edgeNormal = { x: Math.sin(FLAP_EDGE_ANGLE), y: Math.cos(FLAP_EDGE_ANGLE) };
  const inset = 0.05;

  return (
    <>
      <Animator progress={progress} layout={layout} compact={compact} mode={mode} parts={parts} onFirstFrame={onFirstFrame} />
      <group ref={root}>
        <group ref={tilt}>
          <mesh position={[0, 0, BODY_D / 2 - PANEL / 2]} material={materials.body}>
            <boxGeometry args={[BODY_W, BODY_H, PANEL]} />
          </mesh>
          <mesh position={[0, 0, -(BODY_D / 2 - PANEL / 2)]} material={materials.body}>
            <boxGeometry args={[BODY_W, BODY_H, PANEL]} />
          </mesh>
          <mesh position={[-(BODY_W / 2 - PANEL / 2), 0, 0]} material={materials.body}>
            <boxGeometry args={[PANEL, BODY_H, BODY_D - 2 * PANEL]} />
          </mesh>
          <mesh position={[BODY_W / 2 - PANEL / 2, 0, 0]} material={materials.body}>
            <boxGeometry args={[PANEL, BODY_H, BODY_D - 2 * PANEL]} />
          </mesh>
          <mesh position={[0, -(BODY_H / 2 - PANEL / 2), 0]} material={materials.body}>
            <boxGeometry args={[BODY_W - 2 * PANEL, PANEL, BODY_D - 2 * PANEL]} />
          </mesh>
          <mesh position={[0, -0.025, -(BODY_D / 2 - PANEL) + 0.0005]} material={materials.liner}>
            <planeGeometry args={[2.3, 1.4]} />
          </mesh>

          {FRONT_STRIPS.map((strip, index) => (
            <mesh key={index} position={strip.position} material={materials.foil}>
              <boxGeometry args={strip.size} />
            </mesh>
          ))}

          <group ref={flap} position={[0, BODY_H / 2, 0.032]}>
            <mesh material={materials.body} geometry={flapGeometry} />
            <mesh position={[0, 0, -0.001]} rotation={[0, Math.PI, 0]} material={materials.liner} geometry={linerGeometry} />
            <mesh
              position={[-edgeMid.x + edgeNormal.x * inset, edgeMid.y + edgeNormal.y * inset, 0.005]}
              rotation={[0, 0, -FLAP_EDGE_ANGLE]}
              material={materials.foil}
            >
              <boxGeometry args={[FLAP_EDGE_LENGTH * 0.94, 0.02, 0.018]} />
            </mesh>
            <mesh
              position={[edgeMid.x - edgeNormal.x * inset, edgeMid.y + edgeNormal.y * inset, 0.005]}
              rotation={[0, 0, FLAP_EDGE_ANGLE]}
              material={materials.foil}
            >
              <boxGeometry args={[FLAP_EDGE_LENGTH * 0.94, 0.02, 0.018]} />
            </mesh>
            <group ref={seal} position={[0, -0.8, 0.03]}>
              <mesh rotation={[Math.PI / 2, 0, 0]} material={materials.seal}>
                <cylinderGeometry args={[0.2, 0.2, 0.04, 48]} />
              </mesh>
              <mesh position={[0, 0, 0.02]} material={materials.emboss} geometry={chevronGeometry} />
            </group>
          </group>
        </group>
      </group>

      {/* The certificate is not a child of the envelope: it starts in the pocket and then flies to its own pose. */}
      <group ref={card}>
        <Html ref={face} portal={layer as RefObject<HTMLElement>} transform distanceFactor={DISTANCE_FACTOR} pointerEvents="none">
          <div style={{ width: CERT_PX.w }}>
            <Certificate {...certificate} />
          </div>
        </Html>
      </group>
    </>
  );
}

/**
 * The 3D envelope and certificate. Lighting is procedural: three plain lights and an Environment
 * made of two Lightformers, so nothing is downloaded. Scroll progress comes in through `progress.value`.
 */
export function EnvelopeScene({
  progress,
  layout,
  compact,
  mode = "hero",
  certificate,
  active,
  layer,
  onFirstFrame,
}: {
  progress: Progress;
  layout: HeroLayout;
  compact: boolean;
  mode?: SceneMode;
  certificate?: CertificateProps;
  active: boolean;
  layer: RefObject<HTMLDivElement | null>;
  onFirstFrame: () => void;
}) {
  return (
    <Canvas
      dpr={[1, compact ? 1.5 : 2]}
      gl={{ antialias: true, alpha: true }}
      camera={{ fov: 35, position: [0, 0, 6] }}
      frameloop={active ? "always" : "never"}
    >
      <ambientLight intensity={0.6} color="#FFF1DC" />
      <directionalLight position={[-3, 4, 5]} intensity={2.2} color="#FFE3B3" />
      <directionalLight position={[0, 0.5, 6]} intensity={0.8} color="#FFE3B3" />
      <directionalLight position={[3, 1, -3]} intensity={1.6} color={GOLD} />
      <Environment resolution={256} frames={1}>
        <color attach="background" args={["#2A1E10"]} />
        <Lightformer form="rect" intensity={2} color="#FFDDAA" position={[-2.6, -0.9, 6.5]} scale={[0.8, 6, 1]} />
        <Lightformer form="ring" intensity={1} color={GOLD} position={[5.5, 0.5, 3]} scale={3.5} />
      </Environment>
      <Envelope progress={progress} layout={layout} compact={compact} mode={mode} certificate={certificate} layer={layer} onFirstFrame={onFirstFrame} />
    </Canvas>
  );
}
