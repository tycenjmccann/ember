"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  ShellChannel,
  decodeFrame,
  decodeText,
  encodeStdin,
  encodeResize,
  encodeHeartbeat,
} from "@/lib/ember/shell-protocol";

type Status = "connecting" | "connected" | "closed" | "error";

/**
 * Live PTY terminal into a session's microVM. The browser connects DIRECTLY to
 * the AgentCore runtime over a presigned wss:// URL (minted by our API); our
 * server never proxies the socket. Speaks the K8s channel-prefix protocol.
 */
export default function ShellTerminal({
  sessionId,
  resumeSessionId,
  resumeFirstPrompt,
  onSeedConsumed,
}: {
  sessionId: string;
  // When set, the shell auto-runs `claude --resume <resumeSessionId>` on connect
  // (ported session opened in the Terminal tab). resumeFirstPrompt, if given, is
  // typed as the first message to the resumed agent.
  resumeSessionId?: string;
  resumeFirstPrompt?: string;
  // Called once after the first-prompt seed has been typed, so the parent can
  // persist a clear (clearPendingSeed). Reopening then re-attaches via
  // `claude --resume` WITHOUT re-typing the seed.
  onSeedConsumed?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [err, setErr] = useState<string | null>(null);
  // Resume should fire exactly once per attach, even if onopen re-runs.
  const resumedRef = useRef(false);
  // Live socket + terminal refs so the key accessory bar (below) can send
  // control bytes and re-focus the TUI after a tap.
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Accessory bar collapse toggle (persisted so it stays how the user left it).
  const [keysOpen, setKeysOpen] = useState(true);
  // Held-key auto-repeat (hold an arrow to scroll a long TUI menu).
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const term0 = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,        // a little air so glyphs don't look cramped
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 600,
      scrollback: 5000,        // keep history so there's something to scroll
      scrollSensitivity: 3,    // smoother wheel/touch scroll
      // allowProposedApi enables the WebGL addon's char-atlas hooks.
      allowProposedApi: true,
      theme: { background: "#0b0f17", foreground: "#e2e8f0" },
    });
    term = term0;
    termRef.current = term0;
    fit = new FitAddon();
    fitRef.current = fit;
    term0.loadAddon(fit);
    if (hostRef.current) {
      term0.open(hostRef.current);
      // GPU renderer — DPR-aware glyph rasterization, so text stays crisp on
      // retina/HiDPI instead of the blurry default canvas atlas. If the GL
      // context is lost (backgrounded tab, driver reset), dispose and let xterm
      // fall back to its DOM renderer rather than freezing on a dead canvas.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term0.loadAddon(webgl);
      } catch { /* no WebGL2 — xterm keeps its canvas/DOM renderer */ }
      fit.fit();
      // xterm's scrollable element is .xterm-viewport, NOT our host div. Let it
      // pan vertically on touch (finger-scroll the terminal) and contain the
      // overscroll so the gesture never chains up to scroll the page behind it.
      const vp = hostRef.current.querySelector(".xterm-viewport") as HTMLElement | null;
      if (vp) {
        vp.style.touchAction = "pan-y";
        vp.style.overscrollBehavior = "contain";
      }
    }
    term0.writeln("\x1b[90mConnecting to your session…\x1b[0m");

    (async () => {
      try {
        const res = await fetch(`/api/ember/sessions/${sessionId}/shell`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed to get shell URL");
        if (disposed) return;

        ws = new WebSocket(data.url);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          setStatus("connected");
          if (fit && term0) {
            ws!.send(encodeResize(term0.cols, term0.rows));
          }
          heartbeat = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) ws.send(encodeHeartbeat());
          }, 30_000);

          // Ported session opened in Terminal: cd into the cloned workspace and
          // natively resume the laptop conversation, then type the first prompt.
          // WORKSPACE_DIR is exported per-session by shell-init; fall back to the
          // session's workspace path. The agent picks up with full history.
          if (resumeSessionId && !resumedRef.current) {
            resumedRef.current = true;
            const safeSid = sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
            // Sanitize the resume id before it enters a shell command (it's a
            // cc-/uuid id from session data — keep only id-legal chars).
            const safeResume = resumeSessionId.replace(/[^A-Za-z0-9._-]/g, "");
            // RESUME FROM THE RIGHT CWD. The runtime installs the transcript under
            // the Claude project slug of the *workdir* it cloned into
            // (sessions/<sid>/<repo>, sessions/<sid>/workspace for self-contained,
            // or sessions/<sid> itself for a bare port). `claude --resume` only
            // finds it when launched from that same cwd. On a slow warm the
            // checkout may not exist yet when the PTY connects, so we POLL: each
            // second, test every candidate workdir's slug for the transcript and
            // cd into the one that has it. This both waits for a delayed warm AND
            // guarantees the cwd matches where the transcript landed — fixing the
            // race where we'd fall back to $WORKSPACE_ROOT and resume from the
            // wrong slug. Falls through to a usable shell after ~90s.
            const sidDir = `"$WORKSPACE_ROOT/sessions/${safeSid}"`;
            const findAndCd =
              `target=""; ` +
              `for i in $(seq 1 90); do ` +
                `for cand in ${sidDir}/*/ ${sidDir}; do ` +
                  `[ -d "$cand" ] || continue; ` +
                  `slug=$(realpath "$cand" 2>/dev/null | sed "s/[^a-zA-Z0-9]/-/g"); ` +
                  `if [ -e "$CLAUDE_CONFIG_DIR/projects/$slug/${safeResume}.jsonl" ]; then target="$cand"; break 2; fi; ` +
                `done; ` +
                `sleep 1; ` +
              `done; ` +
              `cd "${'${target:-$WORKSPACE_ROOT}'}" 2>/dev/null || cd "$WORKSPACE_ROOT"`;
            const resume = `claude --resume ${safeResume}`;
            // Send find+cd + resume as one line; the agent opens in the TUI.
            setTimeout(() => {
              if (ws?.readyState !== WebSocket.OPEN) return;
              ws.send(encodeStdin(`${findAndCd} && ${resume}\n`));
              // The first-prompt seed is typed ONCE (it's a long nudge). Tell the
              // parent so it persists a clear — reopening re-runs `claude --resume`
              // above (idempotent) but never re-types this seed (which would stack
              // in the transcript). Re-attach without a seed skips this block.
              if (resumeFirstPrompt) {
                setTimeout(() => {
                  if (ws?.readyState !== WebSocket.OPEN) return;
                  // Fill the composer, THEN press Enter as a separate keystroke.
                  // Claude's TUI (Ink) treats a trailing newline inside the same
                  // write as a literal newline — the text would sit unsubmitted in
                  // the input box (and Claude persists that draft, so it reappears
                  // on every reopen). A standalone \r after the paste settles is a
                  // real Return and actually submits the turn.
                  ws.send(encodeStdin(resumeFirstPrompt));
                  setTimeout(() => {
                    // Only consume the seed once Return actually goes out. If the
                    // socket closed during the gap the prompt was merely pasted,
                    // never submitted — leave pendingSeed so reopening retries it.
                    if (ws?.readyState !== WebSocket.OPEN) return;
                    ws.send(encodeStdin("\r"));
                    onSeedConsumed?.();
                  }, 500);
                }, 4000);
              }
            }, 600);
          }
        };

        ws.onmessage = (ev) => {
          const f = decodeFrame(ev.data as ArrayBuffer);
          if (f.channel === ShellChannel.STDOUT || f.channel === ShellChannel.STDERR) {
            term0.write(f.payload);
          } else if (f.channel === ShellChannel.STATUS) {
            try {
              const s = JSON.parse(decodeText(f.payload));
              if (s.status === "Failure") {
                term0.writeln(`\r\n\x1b[90m[session ended: ${s.message || s.reason || "exit"}]\x1b[0m`);
              }
            } catch {
              /* ignore non-JSON status */
            }
          } else if (f.channel === ShellChannel.CLOSE) {
            setStatus("closed");
          }
        };

        ws.onerror = () => {
          setErr("connection error");
          setStatus("error");
        };
        ws.onclose = () => {
          if (!disposed) setStatus((s) => (s === "error" ? s : "closed"));
        };

        term0.onData((d) => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodeStdin(d));
        });
        term0.onResize(({ cols, rows }) => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodeResize(cols, rows));
        });
      } catch (e) {
        if (disposed) return;
        setErr((e as Error).message);
        setStatus("error");
        term0.writeln(`\r\n\x1b[31m${(e as Error).message}\x1b[0m`);
      }
    })();

    const onWinResize = () => fit?.fit();
    window.addEventListener("resize", onWinResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onWinResize);
      if (heartbeat) clearInterval(heartbeat);
      ws?.close();
      term?.dispose();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      if (repeatRef.current) clearInterval(repeatRef.current);
    };
  }, [sessionId]);

  // Refit + resend the PTY size whenever the accessory bar changes the terminal's
  // available height (it mounts on connect, and grows/shrinks on toggle). Without
  // this the PTY keeps its pre-bar row count and the bottom rows of Claude's TUI
  // render underneath the bar. rAF lets the new layout settle before measuring.
  useEffect(() => {
    if (status !== "connected") return;
    const id = requestAnimationFrame(() => {
      const fit = fitRef.current, term = termRef.current, ws = wsRef.current;
      if (!fit || !term) return;
      try { fit.fit(); } catch { /* host not laid out yet */ }
      if (ws?.readyState === WebSocket.OPEN) ws.send(encodeResize(term.cols, term.rows));
    });
    return () => cancelAnimationFrame(id);
  }, [keysOpen, status]);

  // Restore the bar's open/closed preference.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("ember.shellKeys");
    if (saved != null) setKeysOpen(saved === "1");
  }, []);
  const toggleKeys = () => {
    setKeysOpen((v) => {
      const next = !v;
      try { window.localStorage.setItem("ember.shellKeys", next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
    termRef.current?.focus();
  };

  // Send raw bytes to the PTY, then return focus to the terminal so the soft
  // keyboard stays attached to it (tapping a button blurs xterm otherwise).
  const sendKey = (seq: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(encodeStdin(seq));
    termRef.current?.focus();
  };
  // Press: fire once, then auto-repeat while held (arrows/backspace only).
  const startKey = (seq: string, repeat?: boolean) => {
    sendKey(seq);
    if (!repeat) return;
    if (repeatRef.current) clearInterval(repeatRef.current);
    repeatRef.current = setInterval(() => sendKey(seq), 110);
  };
  const stopKey = () => {
    if (repeatRef.current) { clearInterval(repeatRef.current); repeatRef.current = null; }
  };

  // Keys a phone soft-keyboard can't produce but Claude Code's TUI prompts need
  // (↑/↓ to move a selection, Enter to confirm, Esc to cancel, Tab, Ctrl-C).
  // ESC sequences are the standard xterm input codes. `repeat` = hold-to-repeat;
  // `accent` = primary key (Enter) gets the accent fill.
  type Key = { label: string; seq: string; repeat?: boolean; accent?: boolean; wide?: boolean };
  const KEYS: Key[] = [
    { label: "esc", seq: "\x1b" },
    { label: "tab", seq: "\t" },
    { label: "⌃C", seq: "\x03" },
    { label: "←", seq: "\x1b[D", repeat: true },
    { label: "↓", seq: "\x1b[B", repeat: true },
    { label: "↑", seq: "\x1b[A", repeat: true },
    { label: "→", seq: "\x1b[C", repeat: true },
    { label: "return", seq: "\r", accent: true, wide: true },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <span
          className={`w-2 h-2 rounded-full ${
            status === "connected"
              ? "bg-green-400"
              : status === "connecting"
              ? "bg-amber-400 animate-pulse"
              : "bg-[var(--color-text-muted)]"
          }`}
        />
        <span className="text-[var(--color-text-muted)]">
          {status === "connected"
            ? "live terminal — attached to the session microVM"
            : status === "connecting"
            ? "connecting…"
            : err || "disconnected"}
        </span>
      </div>
      {/* Touch scrolling is wired on the inner .xterm-viewport (see effect)
          so finger-scroll pans the terminal, not the page. Tap anywhere to focus
          the TUI and raise the soft keyboard on mobile. */}
      <div
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        className="flex-1 min-h-0 p-2 bg-[#0b0f17] overscroll-contain"
      />
      {/* Key accessory bar — styled to read as an extension of the soft keyboard:
          it sits flush above it (keyboard-gray fill, raised key-caps with the
          subtle bottom shadow iOS keys have). It supplies the keys a phone
          keyboard lacks but Claude Code's TUI prompts need, and it's the only way
          to answer a ↑/↓ + Enter menu on a touchscreen.

          onPointerDown + preventDefault keeps focus on the terminal (no blur, the
          keyboard stays up). Arrows hold-to-repeat. Collapsible via the chevron,
          preference persisted. Hidden entirely until the socket is live. */}
      {status === "connected" && (
        <div
          className="border-t border-black/40 bg-[#2c2c2e] select-none"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {keysOpen ? (
            <div className="flex items-stretch gap-1.5 px-2 py-2">
              <div className="flex flex-1 items-stretch gap-1.5 overflow-x-auto">
                {KEYS.map((k) => (
                  <button
                    key={k.label}
                    onPointerDown={(e) => { e.preventDefault(); startKey(k.seq, k.repeat); }}
                    onPointerUp={stopKey}
                    onPointerLeave={stopKey}
                    onPointerCancel={stopKey}
                    aria-label={k.label}
                    className={`shrink-0 min-w-[2.6rem] h-9 px-2 grid place-items-center rounded-[7px]
                      text-[15px] leading-none font-medium tracking-tight
                      shadow-[0_1px_0_rgba(0,0,0,0.5)] active:translate-y-px active:shadow-none
                      transition-[transform,background-color] duration-75
                      ${k.wide ? "flex-1 min-w-[5rem]" : ""}
                      ${k.accent
                        ? "bg-[#0a84ff] text-white active:bg-[#0a6fd6]"
                        : "bg-[#5b5b60] text-white active:bg-[#48484c]"}`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <button
                onPointerDown={(e) => { e.preventDefault(); toggleKeys(); }}
                aria-label="Hide key bar"
                className="shrink-0 w-9 h-9 grid place-items-center rounded-[7px]
                  bg-[#3a3a3c] text-white/70 shadow-[0_1px_0_rgba(0,0,0,0.5)]
                  active:translate-y-px active:shadow-none"
              >
                <span className="text-[13px]">⌄</span>
              </button>
            </div>
          ) : (
            <button
              onPointerDown={(e) => { e.preventDefault(); toggleKeys(); }}
              aria-label="Show key bar"
              className="w-full flex items-center justify-center gap-1.5 py-1.5
                text-[11px] text-white/55 active:text-white/80"
            >
              <span className="text-[13px]">⌃</span> keys
            </button>
          )}
        </div>
      )}
    </div>
  );
}
