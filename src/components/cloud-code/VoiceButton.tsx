"use client";

/**
 * VoiceButton — Telegram-style push-to-talk for the composer.
 *
 *   • Tap & hold the mic to record; release to finish and keep the text.
 *   • While holding, slide UP past the lock threshold to LOCK hands-free —
 *     then release; recording continues until you tap the stop pill.
 *   • Slide LEFT past the cancel threshold (and release) to discard.
 *
 * Transcription streams live into the composer via the parent's onText. This
 * component owns only the gesture + the recording affordances (waveform pulse,
 * timer, lock rail, slide-to-cancel hint).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Lock, ChevronUp, Square, Trash2 } from "lucide-react";
import { useVoiceInput } from "@/lib/cloud-code/use-voice-input";

const LOCK_THRESHOLD = 72;   // px dragged up to latch hands-free
const CANCEL_THRESHOLD = 90; // px dragged left to discard

export default function VoiceButton({
  onText,
  onError,
  onActiveChange,
  disabled,
}: {
  onText: (text: string) => void;
  onError?: (msg: string) => void;
  /** Fires true while recording/locked so the parent keeps the mic mounted even
   *  once dictated text fills the composer (otherwise the send arrow would swap
   *  in and unmount us mid-sentence). */
  onActiveChange?: (active: boolean) => void;
  disabled?: boolean;
}) {
  const voice = useVoiceInput(onText);
  const [locked, setLocked] = useState(false);
  const [dragY, setDragY] = useState(0); // negative = up
  const [dragX, setDragX] = useState(0); // negative = left
  const startPt = useRef<{ x: number; y: number } | null>(null);
  const lockedRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);

  // Recording timer.
  useEffect(() => {
    if (!voice.listening) { setElapsed(0); return; }
    const started = performance.now();
    const id = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 250);
    return () => window.clearInterval(id);
  }, [voice.listening]);

  useEffect(() => {
    if (voice.error && voice.error !== "unsupported") {
      onError?.(voice.error === "not-allowed" ? "Microphone access denied" : `Voice error: ${voice.error}`);
    }
  }, [voice.error, onError]);

  // Keep the parent's send/mic swap from unmounting us while we're live.
  useEffect(() => {
    onActiveChange?.(voice.listening || locked);
  }, [voice.listening, locked, onActiveChange]);

  const cancelHint = -dragX >= CANCEL_THRESHOLD;

  const endGesture = useCallback(() => {
    startPt.current = null;
    if (lockedRef.current) { setDragY(0); setDragX(0); return; } // stay recording, locked
    // Not locked: a release ends the take.
    if (-dragX >= CANCEL_THRESHOLD) voice.cancel();
    else voice.stop();
    setDragY(0); setDragX(0);
  }, [dragX, voice]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (disabled || !voice.supported) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    startPt.current = { x: e.clientX, y: e.clientY };
    lockedRef.current = false;
    setLocked(false);
    setDragY(0); setDragX(0);
    voice.start();
  }, [disabled, voice]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startPt.current || lockedRef.current) return;
    const dy = e.clientY - startPt.current.y;
    const dx = e.clientX - startPt.current.x;
    setDragY(Math.min(0, dy));
    setDragX(Math.min(0, dx));
    if (-dy >= LOCK_THRESHOLD && -dx < CANCEL_THRESHOLD) {
      lockedRef.current = true;
      setLocked(true);
      setDragY(0); setDragX(0);
    }
  }, []);

  const stopLocked = useCallback(() => {
    lockedRef.current = false;
    setLocked(false);
    voice.stop();
  }, [voice]);

  const cancelLocked = useCallback(() => {
    lockedRef.current = false;
    setLocked(false);
    voice.cancel();
  }, [voice]);

  if (!voice.supported) return null; // hide entirely where on-device STT is unavailable

  const recording = voice.listening;
  const mmss = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;

  return (
    <>
      {/* Idle / hold mic button (replaces send when composer empty). */}
      {!locked && (
        <button
          type="button"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          aria-label="Hold to talk"
          className="press-sm relative w-[34px] h-[34px] mb-0.5 rounded-full flex items-center justify-center flex-shrink-0 touch-none select-none transition-transform"
          style={{
            background: recording ? "var(--ios-red)" : "var(--ios-fill-tertiary)",
            color: recording ? "#fff" : "var(--color-text-secondary)",
            transform: recording ? `translate(${dragX * 0.4}px, ${dragY * 0.4}px) scale(${cancelHint ? 0.9 : 1.25})` : "none",
            boxShadow: recording ? "0 4px 16px rgba(255,59,48,0.45)" : "none",
          }}
        >
          <Mic className="w-[18px] h-[18px]" strokeWidth={2.3} />
          {recording && (
            <span
              className="absolute inset-0 rounded-full -z-10 animate-ping"
              style={{ background: "var(--ios-red)", opacity: 0.35 }}
            />
          )}
        </button>
      )}

      {/* While holding (unlocked): lock rail above + slide-to-cancel hint. */}
      {recording && !locked && (
        <div className="absolute inset-x-0 -top-12 z-20 pointer-events-none flex flex-col items-center gap-2">
          <div
            className="flex flex-col items-center text-[var(--color-text-muted)] transition-opacity"
            style={{ opacity: -dragY > 8 ? 1 : 0.5 }}
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center mb-1"
              style={{
                background: -dragY >= LOCK_THRESHOLD ? "var(--ios-blue)" : "var(--ios-fill-secondary)",
                color: -dragY >= LOCK_THRESHOLD ? "#fff" : "var(--color-text-muted)",
              }}
            >
              <Lock className="w-4 h-4" strokeWidth={2.3} />
            </div>
            <ChevronUp className="w-4 h-4" strokeWidth={2.6} />
          </div>
          <div
            className="text-[13px] font-medium transition-colors"
            style={{ color: cancelHint ? "var(--ios-red)" : "var(--color-text-muted)" }}
          >
            {cancelHint ? "Release to cancel" : "‹ slide to cancel · slide up to lock"}
          </div>
        </div>
      )}

      {/* Locked: full recording bar with timer + cancel + stop. */}
      {locked && (
        <div className="flex-1 flex items-center gap-2 px-1 animate-[fadeIn_120ms_ease-out]">
          <button
            type="button"
            onClick={cancelLocked}
            aria-label="Cancel recording"
            className="press-sm w-[34px] h-[34px] rounded-full flex items-center justify-center flex-shrink-0"
            style={{ color: "var(--ios-red)" }}
          >
            <Trash2 className="w-[18px] h-[18px]" strokeWidth={2.2} />
          </button>

          <div className="flex-1 flex items-center gap-2 text-[var(--ios-red)]">
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--ios-red)" }} />
            <span className="text-[15px] tabular-nums font-medium">{mmss}</span>
            {voice.interimText && (
              <span className="text-[13px] text-[var(--color-text-muted)] truncate">{voice.interimText}</span>
            )}
          </div>

          <button
            type="button"
            onClick={stopLocked}
            aria-label="Stop and keep"
            className="press-sm w-[34px] h-[34px] rounded-full flex items-center justify-center flex-shrink-0 text-white"
            style={{ background: "var(--ios-blue)" }}
          >
            <Square className="w-[15px] h-[15px] fill-current" strokeWidth={0} />
          </button>
        </div>
      )}
    </>
  );
}
