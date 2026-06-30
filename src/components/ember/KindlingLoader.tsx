"use client";

import { useEffect, useRef } from "react";

/**
 * KindlingLoader — the cold-start wait, reimagined as an ember pile catching
 * fire. A microVM clone+warm can take 10–50s; instead of a dead spinner we show
 * a coal pile (one big coal in back, three small ones across the front) whose
 * molten fill climbs from the base and whose glow grows as the session warms,
 * then settles into the brand's `warmthBreathe` loop the instant it's live.
 *
 * Two heat gradients let the coals catch independently: the small front coals
 * light first (medium floor), the big back coal lags (low floor), both climb to
 * full. The shared `--heat` var (0→1) drives brightness + outer glow in CSS.
 *
 * Pure CSS/SVG, no deps. Uses the real brand tokens (--ember-*, --coal). When
 * `lit` flips true (session ready) the pile locks to full heat and breathes.
 */

const PHASES_DEFAULT = ["warming workspace", "resuming session"];

export interface KindlingLoaderProps {
  /** Flip true when the session is live — locks the pile to full glow + breathe. */
  lit?: boolean;
  /** Phase labels to cycle through under the pile (omit for none). */
  phases?: string[];
  /** ms the heat ramp takes to reach full (default 4200). */
  rampMs?: number;
  /** Compact inline variant (chat agent-bubble) — no phase list, smaller. */
  size?: "hero" | "inline";
  /** Index of the currently-active phase (caller-driven). Defaults to internal cycle. */
  activePhase?: number;
  className?: string;
}

let SEQ = 0;

export function KindlingLoader({
  lit = false,
  phases = PHASES_DEFAULT,
  rampMs = 4200,
  size = "hero",
  activePhase,
  className = "",
}: KindlingLoaderProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const gSmallRef = useRef<SVGLinearGradientElement>(null);
  const gBigRef = useRef<SVGLinearGradientElement>(null);
  const rafRef = useRef<number | null>(null);
  // Unique gradient ids so multiple instances on one page never collide.
  const uid = useRef(`kn${++SEQ}`).current;

  // Band-climb: push the hot gradient stops upward as fill `f` (0..1+) rises.
  const BASE = [0, 0.22, 0.42, 0.6, 0.82];
  const applyBand = (grad: SVGLinearGradientElement | null, f: number) => {
    if (!grad) return;
    Array.from(grad.children).forEach((s, i) =>
      (s as SVGStopElement).setAttribute(
        "offset",
        Math.min(0.9, BASE[i] + f * (0.17 - i * 0.022)).toFixed(3)
      )
    );
  };
  const setHeat = (f: number) =>
    rootRef.current?.style.setProperty("--heat", (f * 1.05).toFixed(3));

  const SMALL_FLOOR = 0.42;
  const BIG_FLOOR = 0.18;

  // Heat ramp (or lock to full when lit).
  useEffect(() => {
    const cancel = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    if (lit) {
      cancel();
      applyBand(gSmallRef.current, 1);
      applyBand(gBigRef.current, 1.1);
      setHeat(1);
      return cancel;
    }
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / rampMs);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
      applyBand(gSmallRef.current, SMALL_FLOOR + e * (1 - SMALL_FLOOR));
      applyBand(gBigRef.current, BIG_FLOOR + e * (1.1 - BIG_FLOOR));
      setHeat(e);
      if (t < 1) rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return cancel;
  }, [lit, rampMs]);

  const dim = size === "inline" ? { w: 28, h: 19 } : { w: 64, h: 44 };
  const active = activePhase ?? phases.length - 1;

  return (
    <span
      className={`kindling kindling--${size} ${className}`}
      style={{ ["--heat" as string]: "0" }}
    >
      <span className="kindling-pile" style={{ width: dim.w, height: dim.h }}>
        <span ref={rootRef} className={`coal-pile ${lit ? "lit" : ""}`}>
          <svg
            viewBox="0 0 64 44"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            preserveAspectRatio="xMidYMax meet"
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id={`${uid}-s`}
                ref={gSmallRef}
                x1="0"
                y1="44"
                x2="0"
                y2="6"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ffc46a" />
                <stop offset="0.22" stopColor="#ff7a1a" />
                <stop offset="0.42" stopColor="#e65100" />
                <stop offset="0.6" stopColor="#5a2200" />
                <stop offset="0.82" stopColor="#241813" />
              </linearGradient>
              <linearGradient
                id={`${uid}-b`}
                ref={gBigRef}
                x1="0"
                y1="44"
                x2="0"
                y2="6"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ffc46a" />
                <stop offset="0.22" stopColor="#ff7a1a" />
                <stop offset="0.42" stopColor="#e65100" />
                <stop offset="0.6" stopColor="#5a2200" />
                <stop offset="0.82" stopColor="#241813" />
              </linearGradient>
            </defs>
            {/* big coal in back */}
            <path
              d="M18 36 Q13 18 27 13 Q42 9 49 22 Q54 34 44 40 Q31 45 23 42 Q18 40 18 36 Z"
              fill={`url(#${uid}-b)`}
              stroke="#1a0f0a"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            {/* three small coals across the front */}
            <path d="M6 40 Q3 31 13 30 Q21 29 23 36 Q24 43 15 44 Q8 44 6 40 Z" fill={`url(#${uid}-s)`} stroke="#1a0f0a" strokeWidth="1.1" strokeLinejoin="round" />
            <path d="M21 41 Q19 33 29 32 Q38 32 39 39 Q39 45 29 45 Q23 45 21 41 Z" fill={`url(#${uid}-s)`} stroke="#1a0f0a" strokeWidth="1.1" strokeLinejoin="round" />
            <path d="M37 40 Q36 32 46 31 Q55 31 56 38 Q56 44 47 44 Q40 44 37 40 Z" fill={`url(#${uid}-s)`} stroke="#1a0f0a" strokeWidth="1.1" strokeLinejoin="round" />
          </svg>
        </span>
        {size === "hero" && (
          <>
            <span className="kindling-spark s1" />
            <span className="kindling-spark s2" />
            <span className="kindling-spark s3" />
            <span className="kindling-spark s4" />
          </>
        )}
      </span>

      {size === "hero" && phases.length > 0 && (
        <ul className="kindling-phases" aria-hidden="true">
          {phases.map((p, i) => (
            <li key={p} className={lit || i < active ? "done" : i === active ? "active" : ""}>
              <span className="mark" />
              {p}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

export default KindlingLoader;
