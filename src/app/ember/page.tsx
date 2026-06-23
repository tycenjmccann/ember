"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Cloud, ArrowUp, Trash2, GitBranch, MessageSquare, TerminalSquare, Settings, Upload, Check, ChevronDown, ChevronLeft, X, KeyRound, Server, UserCircle } from "lucide-react";
import dynamic from "next/dynamic";
import { sseData } from "@/lib/sse";
import { MarkdownRenderer } from "@/components/ember/MarkdownRenderer";
import { CliBadge, CliMark, CLI_BRAND } from "@/components/ember/CliBrand";
import VoiceButton from "@/components/ember/VoiceButton";

// xterm touches the DOM/window — load only in the browser.
const ShellTerminal = dynamic(() => import("@/components/ember/ShellTerminal"), { ssr: false });
import type {
  EmberSession,
  EmberSessionSummary,
  EmberCli,
  EmberAuthMode,
  SessionWarmth,
} from "@/lib/ember/types";

const WARMTH_DOT: Record<SessionWarmth, string> = {
  warm: "warmth-dot warmth-dot--warm",   // ember-500, glow + breathe
  idle: "warmth-dot warmth-dot--idle",   // ember-300, dimmer
  cold: "warmth-dot warmth-dot--cold",   // ash, gone out
};
const WARMTH_LABEL: Record<SessionWarmth, string> = { warm: "Active", idle: "Idle", cold: "Asleep" };

export default function EmberPage() {
  const [sessions, setSessions] = useState<EmberSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [active, setActive] = useState<EmberSession | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "terminal">("chat");
  const [voiceActive, setVoiceActive] = useState(false); // dictating → keep mic mounted
  const [sessionsOpen, setSessionsOpen] = useState(false); // mobile session drawer
  const streamEnd = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Auto-scroll follows the bottom WHILE you're already there; if you scroll up
  // to read, it stops yanking you down and shows a "jump to latest" pill instead.
  const [stuck, setStuck] = useState(true);

  // Set while a turn's stream dropped before its reply was recovered (mobile
  // background/lock). The server finishes + persists the turn regardless; we
  // re-sync from it while the tab is visible until the reply lands. Bumping
  // recoverNonce (re-)arms the polling effect even when the tab never lost focus.
  const pendingRecover = useRef<{ sid: string; baseCount: number } | null>(null);
  const [recoverNonce, setRecoverNonce] = useState(0);

  const fetchSessions = useCallback(async () => {
    const res = await fetch("/api/ember/sessions");
    if (!res.ok) return;
    const data = await res.json();
    setSessions(data.sessions || []);
  }, []);

  // Pull the server's authoritative turns for a session and adopt them ONLY once
  // the agent reply has actually been persisted (server has ≥ baseCount+2 turns,
  // last is the agent's). Returns whether it adopted — so callers can keep
  // optimistic turns (incl. the user's message) until the real reply is ready,
  // instead of clobbering them with a not-yet-written server state.
  const recoverActiveTurn = useCallback(async (sid: string, baseCount: number): Promise<boolean> => {
    try {
      const r = await fetch(`/api/ember/sessions/${sid}`);
      if (!r.ok) return false;
      const d = await r.json();
      const turns = d?.session?.turns;
      if (!Array.isArray(turns) || turns.length < baseCount + 2) return false;
      if (turns[turns.length - 1]?.role !== "agent") return false;
      setActive((prev) => (prev && prev.sessionId === sid ? d.session : prev));
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Deep link: /ember?session=<id>[&view=terminal] selects it (the "port to
  // cloud" handoff link opens straight into the ported session, on any device).
  const deepViewRef = useRef<"chat" | "terminal" | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("session");
    if (id) {
      if (q.get("view") === "terminal") deepViewRef.current = "terminal";
      setSelectedId(id);
    }
  }, []);

  // Tracks which session's pending seed we've already auto-fired.
  const seededRef = useRef<string | null>(null);

  // Load full session when selected.
  useEffect(() => {
    if (!selectedId) {
      setActive(null);
      return;
    }
    const override = deepViewRef.current;
    deepViewRef.current = null;
    fetch(`/api/ember/sessions/${selectedId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setActive(d.session);
        setView(override ?? d.session.defaultView ?? "chat");
      })
      .catch(() => {});
  }, [selectedId]);

  const onStreamScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStuck(nearBottom);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    streamEnd.current?.scrollIntoView({ behavior });
    setStuck(true);
  }, []);

  const lastText = active?.turns[active.turns.length - 1]?.text;
  useEffect(() => {
    if (stuck) streamEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.turns.length, lastText, sending, stuck]);

  useEffect(() => {
    scrollToLatest("auto");
  }, [active?.sessionId, scrollToLatest]);

  // Auto-grow the input from 1 line up to ~6.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const createSession = async (cli: EmberCli, repo: string, authMode: EmberAuthMode) => {
    const res = await fetch("/api/ember/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cli, repo: repo || undefined, authMode }),
    });
    if (!res.ok) {
      flash("Failed to create session");
      return;
    }
    const { session } = await res.json();
    setShowNew(false);
    await fetchSessions();
    setSelectedId(session.sessionId);
  };

  const send = async () => {
    if (!active || !draft.trim() || sending) return;
    const prompt = draft.trim();
    setDraft("");
    await runTurn(prompt);
  };

  const runTurn = async (prompt: string, displayAs?: string) => {
    if (!active || !prompt || sending) return;
    const sid = active.sessionId;
    // Turn count before this turn — the server will hold baseCount+2 (user +
    // agent) once it persists, which is how recovery knows the reply is ready.
    const baseCount = active.turns.length;
    setSending(true);
    setActive((s) =>
      s ? { ...s, turns: [...s.turns, { role: "user", text: displayAs ?? prompt, at: new Date().toISOString() }] } : s
    );
    // True only once the SSE body started arriving — distinguishes a recoverable
    // mid-stream drop (the turn is running server-side) from a real failure
    // before the turn began (502/config error, buffered Codex error), which must
    // surface as before rather than spin in "Reconnecting…" forever.
    let streamStarted = false;
    try {
      const canStream = active.cli === "claude";
      const res = await fetch(
        `/api/ember/sessions/${active.sessionId}/message${canStream ? "?stream=1" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(displayAs ? { prompt, displayPrompt: displayAs } : { prompt }),
        }
      );

      if (canStream && res.body && res.headers.get("content-type")?.includes("event-stream")) {
        streamStarted = true;
        setActive((s) =>
          s ? { ...s, turns: [...s.turns, { role: "agent", text: "", at: new Date().toISOString() }] } : s
        );
        let acc = "";
        for await (const data of sseData(res.body)) {
          let obj: { type?: string; text?: string; response?: string; error?: string };
          try { obj = JSON.parse(data); } catch { continue; }
          if (obj.type === "text") acc += obj.text || "";
          else if (obj.type === "done") acc = obj.response || acc;
          else if (obj.type === "error") acc += `\n⚠ ${obj.error}`;
          setActive((s) => {
            if (!s) return s;
            const turns = s.turns.slice();
            turns[turns.length - 1] = { role: "agent", text: acc, at: turns[turns.length - 1].at };
            return { ...s, turns };
          });
        }
        fetchSessions();
      } else {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Turn failed");
        setActive(data.session);
        fetchSessions();
      }
    } catch (err) {
      if (streamStarted) {
        // The stream dropped after starting — most often a phone backgrounding/
        // locking mid-turn. The server keeps running the turn and persists the
        // reply regardless, so don't strand a dead "Network Error" bubble: try to
        // recover the finished reply now, and if it isn't written yet, arm a
        // re-sync (recoverNonce) that polls while the tab is visible.
        const recovered = await recoverActiveTurn(sid, baseCount);
        if (!recovered) {
          pendingRecover.current = { sid, baseCount };
          setRecoverNonce((n) => n + 1);
          flash("Reconnecting — your reply is still coming.");
          fetchSessions();
        }
      } else {
        // Failed before the turn ran (config/502/Codex error). Surface it.
        flash((err as Error).message);
        setActive((s) =>
          s
            ? { ...s, turns: [...s.turns, { role: "agent", text: `⚠ ${(err as Error).message}`, at: new Date().toISOString() }] }
            : s
        );
      }
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  // Re-sync a dropped turn. Two triggers: tab refocus/visibility (mobile reopen)
  // AND a poll while the tab is already visible — the drop can happen with the
  // tab in the foreground (or focus fires before the fetch rejects), so we can't
  // wait on a future focus event. Re-armed by recoverNonce; gives up after a
  // bounded window so a turn that truly never persists doesn't poll forever.
  useEffect(() => {
    if (!pendingRecover.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 10 * 60_000; // match the runtime's ~max turn

    const finish = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
    };

    async function attempt() {
      const p = pendingRecover.current;
      if (stopped || !p) return finish();
      if (document.visibilityState !== "visible") return; // resume on next focus
      if (await recoverActiveTurn(p.sid, p.baseCount)) {
        pendingRecover.current = null;
        fetchSessions();
        return finish();
      }
      if (Date.now() > deadline) {
        pendingRecover.current = null;
        flash("Couldn't reconnect — reopen the session to see the latest.");
        return finish();
      }
      timer = setTimeout(attempt, 4000);
    }

    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    attempt();
    return finish;
  }, [recoverNonce, recoverActiveTurn, fetchSessions]);

  const remove = async (id: string) => {
    await fetch(`/api/ember/sessions/${id}`, { method: "DELETE" });
    if (selectedId === id) setSelectedId(null);
    fetchSessions();
  };

  // Ported session: fire its pending seed once on open.
  useEffect(() => {
    if (!active?.pendingSeed) return;
    if (active.turns.length > 0) return;
    if (view === "terminal") return;
    if (seededRef.current === active.sessionId) return;
    seededRef.current = active.sessionId;
    const seed = active.pendingSeed;
    setActive((s) => (s ? { ...s, pendingSeed: undefined } : s));
    const label = active.branch
      ? `↪ Resuming laptop session on \`${active.branch}\` — continue from here.`
      : "↪ Resuming laptop session — continue from here.";
    runTurn(seed, label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sessionId, active?.pendingSeed, view]);

  return (
    <div className="flex h-full relative overflow-hidden bg-surface-0">
      {/* Mobile backdrop for the session drawer */}
      {sessionsOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden sheet-backdrop" onClick={() => setSessionsOpen(false)} aria-hidden="true" />
      )}

      {/* ── Sidebar — iOS Messages list ──────────────────────────────────── */}
      <aside className={`fixed md:static z-40 top-0 left-0 h-full w-[83%] max-w-[340px] md:w-80 bg-surface-1 md:bg-surface-1 flex flex-col flex-shrink-0 transition-transform duration-300 md:border-r md:border-[var(--color-border)] ${sessionsOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full md:translate-x-0"}`}>
        <div className="ios-blur hairline-b flex items-center justify-between px-4 pt-3.5 pb-2.5" style={{ paddingTop: "max(env(safe-area-inset-top), 14px)" }}>
          <h2 className="text-[22px] font-bold tracking-tight">Sessions</h2>
          <button
            onClick={() => setShowNew(true)}
            data-testid="cc-new-session"
            className="press-sm w-8 h-8 rounded-full flex items-center justify-center text-[var(--ios-blue)]"
            style={{ background: "var(--ios-fill-tertiary)" }}
            aria-label="New session"
          >
            <Plus className="w-[20px] h-[20px]" strokeWidth={2.4} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto ios-scroll px-3 py-2.5">
          {sessions.length === 0 && (
            <div className="text-center mt-16 px-6">
              <img src="/ember-icon.svg" alt="" className="h-12 w-auto mx-auto mb-3" />
              <p className="text-[14px] text-[var(--color-text-secondary)] leading-relaxed">
                No sessions yet. Tap <span className="text-[var(--ios-blue)] font-semibold">+</span> to start one — it runs in the cloud and resumes from any device.
              </p>
            </div>
          )}
          {/* Grouped inset list */}
          {sessions.length > 0 && (
            <div className="rounded-[16px] overflow-hidden" style={{ background: "var(--color-surface-2)" }}>
              {sessions.map((s, i) => (
                <div
                  key={s.sessionId}
                  data-testid="cc-session-row"
                  onClick={() => { setSelectedId(s.sessionId); setSessionsOpen(false); }}
                  className={`group relative flex items-center gap-3 pl-4 pr-2.5 py-2.5 cursor-pointer active:bg-[var(--ios-fill-tertiary)] transition-colors ${
                    selectedId === s.sessionId ? "bg-[var(--ios-fill-secondary)]" : ""
                  }`}
                >
                  {i > 0 && <span className="absolute left-4 right-0 top-0 h-px" style={{ background: "var(--ios-separator)" }} />}
                  {/* App-icon-style square */}
                  <div className="relative w-10 h-10 rounded-[11px] flex items-center justify-center shrink-0"
                    style={{ background: s.defaultView === "terminal" ? "linear-gradient(180deg,#2c2c2e,#1c1c1e)" : "radial-gradient(circle,#ffd089 0%,#ff7a1a 38%,#ff4d00 70%,#7a2c00 100%)" }}>
                    {s.defaultView === "terminal" ? (
                      <TerminalSquare className="w-5 h-5 text-white" strokeWidth={2} />
                    ) : (
                      <MessageSquare className="w-5 h-5 text-white" strokeWidth={2} />
                    )}
                    <span className={`absolute -top-0.5 -right-0.5 rounded-full ring-2 ring-[var(--color-surface-2)] ${WARMTH_DOT[s.warmth]}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold truncate flex-1">{s.title}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">{WARMTH_LABEL[s.warmth]}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[12px] text-[var(--color-text-secondary)]">
                      <CliBadge cli={s.cli} className="text-[10px] !px-1.5 !py-0" />
                      {s.repo && <span className="truncate">{s.repo.split("/").slice(-2).join("/")}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); remove(s.sessionId); }}
                    className="press-sm opacity-0 group-hover:opacity-100 md:opacity-0 p-1.5 rounded-full text-[var(--color-text-muted)] hover:text-[var(--ios-red)] hover:bg-[var(--ios-red)]/10 transition-all shrink-0"
                    title="Delete session"
                    aria-label={`Delete session: ${s.title}`}
                  >
                    <Trash2 className="w-[15px] h-[15px]" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-3 pb-3 flex flex-col gap-2" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}>
          <button
            onClick={() => setShowAccount(true)}
            data-testid="cc-account"
            className="press w-full flex items-center gap-2.5 px-4 py-3 rounded-[14px] text-[14px] font-medium text-[var(--color-text-primary)]"
            style={{ background: "var(--color-surface-2)" }}
          >
            <UserCircle className="w-[18px] h-[18px] text-[var(--ios-blue)]" /> Account &amp; sign-in
            <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">Bedrock · your plan</span>
          </button>
          <button
            onClick={() => setShowConfig(true)}
            className="press w-full flex items-center gap-2.5 px-4 py-3 rounded-[14px] text-[14px] font-medium text-[var(--color-text-primary)]"
            style={{ background: "var(--color-surface-2)" }}
          >
            <Settings className="w-[18px] h-[18px] text-[var(--ios-blue)]" /> My CLI config
            <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">MCP · skills · agents</span>
          </button>
          <p className="text-[11px] text-[var(--color-text-muted)] text-center mt-0.5 px-2 leading-snug">
            Runs on AgentCore — close the lid, resume anywhere.
          </p>
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0">
        {!active ? (
          <>
            {/* Mobile-only bar to reach sessions */}
            <div className="md:hidden ios-blur hairline-b flex items-center justify-between px-4 py-2.5">
              <button onClick={() => setSessionsOpen(true)} className="press-sm flex items-center gap-1 text-[15px] font-medium text-[var(--ios-blue)]">
                <ChevronLeft className="w-5 h-5" strokeWidth={2.4} /> Sessions
              </button>
              <button onClick={() => setShowNew(true)} className="press-sm w-8 h-8 rounded-full flex items-center justify-center text-[var(--ios-blue)]" style={{ background: "var(--ios-fill-tertiary)" }} aria-label="New session">
                <Plus className="w-5 h-5" strokeWidth={2.4} />
              </button>
            </div>
            <div className="flex flex-col items-center justify-center h-full text-center px-8">
              <img src="/ember-icon.svg" alt="ember" className="h-24 w-auto mb-5"
                style={{ filter: "drop-shadow(0 8px 28px rgba(255,106,0,0.45))" }} />
              <h3 className="text-[24px] font-bold tracking-tight mb-2">A coding agent in the cloud</h3>
              <p className="text-[15px] text-[var(--color-text-secondary)] max-w-sm mb-6 leading-relaxed">
                Give it a repo and a task. It clones, codes, builds, and opens a PR — server-side. Close your laptop; pick the session back up from any device.
              </p>
              <button
                onClick={() => setShowNew(true)}
                className="press px-6 py-3 text-white text-[16px] font-semibold rounded-full"
                style={{ background: "var(--ios-blue)", boxShadow: "0 6px 18px rgba(255,106,0,0.35)" }}
              >
                New Session
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Conversation nav bar — frosted, centered title, segmented control */}
            <div className="ios-blur hairline-b flex-shrink-0 px-3 md:px-4 py-2 flex items-center gap-2">
              <button onClick={() => { setSessionsOpen(true); }} className="md:hidden press-sm flex items-center text-[var(--ios-blue)] -ml-1 pr-1" aria-label="Back to sessions">
                <ChevronLeft className="w-6 h-6" strokeWidth={2.3} />
              </button>
              <div className="min-w-0 flex-1 md:flex-initial">
                <div className="font-semibold text-[15px] truncate leading-tight">{active.title}</div>
                <div className="text-[11.5px] text-[var(--color-text-secondary)] flex items-center gap-1.5">
                  <CliBadge cli={active.cli} className="text-[10px] !px-1.5 !py-0" />
                  <AuthChip mode={active.authMode} />
                  {active.repo && (
                    <span className="flex items-center gap-0.5 truncate">
                      <GitBranch className="w-3 h-3" /> {active.repo}
                    </span>
                  )}
                </div>
              </div>
              <div className="ios-segment ml-auto flex-shrink-0">
                <button data-on={view === "chat"} onClick={() => setView("chat")}>
                  <MessageSquare className="w-3.5 h-3.5" /> Chat
                </button>
                <button data-on={view === "terminal"} onClick={() => setView("terminal")} title="Live terminal into the session microVM">
                  <TerminalSquare className="w-3.5 h-3.5" /> Terminal
                </button>
              </div>
            </div>

            {view === "terminal" ? (
              <div className="flex-1 min-h-0">
                <ShellTerminal
                  sessionId={active.sessionId}
                  resumeSessionId={active.cli === "claude" ? active.claudeSessionId : undefined}
                  resumeFirstPrompt={active.pendingSeed || undefined}
                  onSeedConsumed={() => {
                    setActive((s) => (s ? { ...s, pendingSeed: undefined } : s));
                    fetch(`/api/ember/sessions/${active.sessionId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ clearPendingSeed: true }),
                    }).catch(() => {});
                  }}
                />
              </div>
            ) : (
            <div className="relative flex-1 min-h-0">
            <div
              ref={scrollRef}
              onScroll={onStreamScroll}
              data-testid="cc-stream"
              className="h-full overflow-y-auto ios-scroll overscroll-contain px-3.5 md:px-6 py-5 flex flex-col gap-2.5"
            >
              {active.turns.length === 0 && (
                <div className="mx-auto mt-6 max-w-sm text-center">
                  <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed px-4 py-3 rounded-2xl inline-block" style={{ background: "var(--ios-fill-tertiary)" }}>
                    First task clones the repo (warm after). Try: “add a CONTRIBUTING.md, commit on a branch, open a PR.”
                  </p>
                </div>
              )}
              {active.turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="msg-in self-end max-w-[85%] md:max-w-[70%] bubble-user px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words leading-snug">
                    {t.text}
                  </div>
                ) : (
                  <div key={i} data-testid="cc-agent-turn" className="msg-in self-stretch w-full mt-1.5">
                    <div className={`flex items-center gap-1.5 text-[11px] font-semibold mb-1 ml-1 ${CLI_BRAND[active.cli].dot}`}>
                      <CliMark cli={active.cli} className="w-3 h-3" />
                      <span className="tracking-wide">{CLI_BRAND[active.cli].label}</span>
                    </div>
                    {/* Long-form agent output reads better full-width (like ChatGPT/Claude),
                        but short replies get an iMessage gray bubble for that native feel. */}
                    {t.text.length < 160 && !t.text.includes("\n") && !t.text.includes("`") ? (
                      <div className="bubble-agent inline-block max-w-[85%] md:max-w-[70%] px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words">
                        {t.text}
                      </div>
                    ) : (
                      <div className="bubble-agent px-4 py-2.5 text-[15px] leading-relaxed">
                        <MarkdownRenderer content={t.text} />
                      </div>
                    )}
                  </div>
                )
              )}
              {sending && (
                <div className="msg-in self-start bubble-agent px-4 py-3 mt-1.5">
                  <div className="typing"><span /><span /><span /></div>
                </div>
              )}
              <div ref={streamEnd} />
            </div>
            {!stuck && (
              <button
                onClick={() => scrollToLatest("smooth")}
                className="press-sm absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-9 h-9 rounded-full flex items-center justify-center text-[var(--ios-blue)] ios-blur"
                style={{ boxShadow: "0 4px 14px rgba(0,0,0,0.18)", border: "0.5px solid var(--ios-separator)" }}
                aria-label="Jump to latest"
              >
                <ChevronDown className="w-5 h-5" strokeWidth={2.4} />
              </button>
            )}
            </div>
            )}

            {view === "chat" && (
            <div className="ios-blur hairline-t flex-shrink-0 px-3 md:px-5 pt-2.5 pb-3" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}>
              <div className="relative flex items-end gap-2">
                <div className="flex-1 flex items-end bg-[var(--color-surface-2)] rounded-[20px] pl-4 pr-1.5 py-1 border-[0.5px] border-[var(--color-border)] focus-within:border-[var(--ios-blue)] transition-colors">
                  <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows={1}
                    placeholder={sending ? "Working…" : "Message"}
                    autoFocus
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="sentences"
                    spellCheck={false}
                    data-testid="cc-message-input"
                    className="flex-1 bg-transparent resize-none outline-none text-[16px] leading-6 py-1.5 max-h-[140px] placeholder:text-[var(--color-text-muted)]"
                  />
                </div>
                {/* Mic when the composer is empty, send when there's something to send.
                    Dictation streams straight into `draft` for review before sending. */}
                {draft.trim() && !voiceActive ? (
                  <button
                    onClick={send}
                    disabled={sending}
                    data-testid="cc-send"
                    className="press-sm w-[34px] h-[34px] mb-0.5 rounded-full text-white flex items-center justify-center transition-all flex-shrink-0 disabled:opacity-40"
                    style={{ background: "var(--ios-blue)" }}
                    aria-label="Send"
                  >
                    <ArrowUp className="w-5 h-5" strokeWidth={2.6} />
                  </button>
                ) : (
                  <VoiceButton
                    disabled={sending}
                    onText={(t) => setDraft(t)}
                    onError={(m) => setToast(m)}
                    onActiveChange={setVoiceActive}
                  />
                )}
              </div>
            </div>
            )}
          </>
        )}
      </main>

      {showNew && (
        <NewSessionSheet
          onClose={() => setShowNew(false)}
          onCreate={createSession}
          onManageAccount={() => { setShowNew(false); setShowAccount(true); }}
        />
      )}
      {showConfig && <ConfigSheet onClose={() => setShowConfig(false)} onToast={flash} />}
      {showAccount && <AccountSheet onClose={() => setShowAccount(false)} onToast={flash} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-full text-white text-[13px] font-medium shadow-xl z-[300] msg-in" style={{ background: "var(--ios-red)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── Bottom sheet shell ───────────────────────────────────────────────── */
function Sheet({ onClose, children, labelledBy }: { onClose: () => void; children: React.ReactNode; labelledBy: string }) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-end md:items-center justify-center bg-black/40 sheet-backdrop"
      style={{ backdropFilter: "blur(2px)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="ios-sheet w-full md:max-w-md px-5 pt-3 pb-[max(env(safe-area-inset-bottom),20px)] md:pb-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby={labelledBy}
      >
        <div className="ios-grabber mx-auto mb-4 md:hidden" />
        {children}
      </div>
    </div>
  );
}

/** Small inline chip showing how a session authenticates (header). */
function AuthChip({ mode }: { mode?: EmberAuthMode }) {
  if (mode === "subscription") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] font-semibold" style={{ background: "rgba(52,199,89,0.16)", color: "var(--ios-green)" }}>
        <KeyRound className="w-2.5 h-2.5" /> My plan
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] font-semibold text-[var(--color-text-muted)]" style={{ background: "var(--ios-fill-tertiary)" }}>
      <Server className="w-2.5 h-2.5" /> Bedrock
    </span>
  );
}

function NewSessionSheet({
  onClose,
  onCreate,
  onManageAccount,
}: {
  onClose: () => void;
  onCreate: (cli: EmberCli, repo: string, authMode: EmberAuthMode) => void;
  onManageAccount: () => void;
}) {
  const [cli, setCli] = useState<EmberCli>("claude");
  const [authMode, setAuthMode] = useState<EmberAuthMode>("bedrock");
  const [repo, setRepo] = useState("");
  const [connected, setConnected] = useState<{ claude?: boolean; codex?: boolean }>({});

  useEffect(() => {
    fetch("/api/ember/auth")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.status) return;
        setConnected({ claude: Boolean(d.status.claude), codex: Boolean(d.status.codex) });
      })
      .catch(() => {});
  }, []);

  const planConnected = connected[cli];
  const planLabel = cli === "claude" ? "Claude Pro / Max" : "ChatGPT plan";

  return (
    <Sheet onClose={onClose} labelledBy="cc-new-title">
      <div className="flex items-center justify-between mb-5">
        <h2 id="cc-new-title" className="text-[20px] font-bold tracking-tight">New Session</h2>
        <button onClick={onClose} className="press-sm w-7 h-7 rounded-full flex items-center justify-center text-[var(--color-text-muted)]" style={{ background: "var(--ios-fill-tertiary)" }} aria-label="Close">
          <X className="w-4 h-4" strokeWidth={2.6} />
        </button>
      </div>

      <label className="block text-[13px] font-semibold text-[var(--color-text-secondary)] mb-2 ml-1">AGENT</label>
      <div className="ios-segment w-full mb-5 !rounded-[12px]">
        {(["claude", "codex"] as EmberCli[]).map((c) => (
          <button key={c} data-on={cli === c} onClick={() => setCli(c)} data-testid={`cc-cli-${c}`} className="flex-1 !py-2.5 !text-[14px]">
            <CliMark cli={c} className="w-4 h-4" />
            {c === "claude" ? "Claude Code" : "Codex"}
          </button>
        ))}
      </div>

      <label className="block text-[13px] font-semibold text-[var(--color-text-secondary)] mb-2 ml-1">RUN ON</label>
      <div className="flex flex-col gap-2 mb-5">
        <button
          data-testid="cc-auth-bedrock"
          onClick={() => setAuthMode("bedrock")}
          className="press w-full flex items-center gap-3 px-3.5 py-3 rounded-[12px] text-left border-[1.5px] transition-colors"
          style={{ background: "var(--color-surface-2)", borderColor: authMode === "bedrock" ? "var(--ios-blue)" : "transparent" }}
        >
          <Server className="w-[18px] h-[18px] text-[var(--ios-blue)] shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-[14px] font-semibold">AWS Bedrock</span>
            <span className="block text-[11.5px] text-[var(--color-text-muted)]">Always ready · no sign-in</span>
          </span>
          {authMode === "bedrock" && <Check className="w-[18px] h-[18px] text-[var(--ios-blue)]" strokeWidth={2.6} />}
        </button>
        <button
          data-testid="cc-auth-subscription"
          onClick={() => (planConnected ? setAuthMode("subscription") : onManageAccount())}
          className="press w-full flex items-center gap-3 px-3.5 py-3 rounded-[12px] text-left border-[1.5px] transition-colors"
          style={{ background: "var(--color-surface-2)", borderColor: authMode === "subscription" ? "var(--ios-green)" : "transparent" }}
        >
          <KeyRound className="w-[18px] h-[18px] text-[var(--ios-green)] shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-[14px] font-semibold">My {planLabel}</span>
            <span className="block text-[11.5px] text-[var(--color-text-muted)]">
              {planConnected ? "Connected · uses your subscription" : "Not connected — tap to sign in"}
            </span>
          </span>
          {authMode === "subscription" && planConnected && <Check className="w-[18px] h-[18px] text-[var(--ios-green)]" strokeWidth={2.6} />}
          {!planConnected && <ChevronDown className="w-[18px] h-[18px] -rotate-90 text-[var(--color-text-muted)]" />}
        </button>
      </div>

      <label className="block text-[13px] font-semibold text-[var(--color-text-secondary)] mb-2 ml-1">
        REPOSITORY <span className="font-normal opacity-70">— optional</span>
      </label>
      <input
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        placeholder="owner/name"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-testid="cc-repo-input"
        className="w-full px-4 py-3 rounded-[12px] text-[16px] outline-none border-[0.5px] border-[var(--color-border)] focus:border-[var(--ios-blue)] mb-2 font-mono transition-colors"
        style={{ background: "var(--color-surface-2)" }}
      />
      <p className="text-[12px] text-[var(--color-text-muted)] mb-6 ml-1 leading-relaxed">
        Needs the full <span className="font-mono">owner/name</span>. Leave empty and ask “list my repos” — the agent has <span className="font-mono">gh</span> access.
      </p>

      <button
        onClick={() => onCreate(cli, repo.trim(), authMode)}
        data-testid="cc-start"
        className="press w-full py-3.5 rounded-[14px] text-[16px] font-semibold text-white"
        style={{ background: "var(--ios-blue)", boxShadow: "0 6px 18px rgba(255,106,0,0.3)" }}
      >
        Start Session
      </button>
    </Sheet>
  );
}

interface ConfigVersion {
  version: string;
  label?: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
}

function ConfigSheet({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/ember/config");
    if (res.ok) {
      const d = await res.json();
      setVersions(d.versions || []);
      setCurrent(d.currentVersion);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("bundle", file);
      const res = await fetch("/api/ember/config", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "upload failed");
      onToast("Config uploaded — now active");
      await load();
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (version?: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/ember/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) throw new Error("failed");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} labelledBy="cc-config-title">
      <div className="flex items-center justify-between mb-3">
        <h2 id="cc-config-title" className="text-[20px] font-bold tracking-tight">My CLI Config</h2>
        <button onClick={onClose} className="press-sm w-7 h-7 rounded-full flex items-center justify-center text-[var(--color-text-muted)]" style={{ background: "var(--ios-fill-tertiary)" }} aria-label="Close">
          <X className="w-4 h-4" strokeWidth={2.6} />
        </button>
      </div>
      <p className="text-[13px] text-[var(--color-text-secondary)] mb-5 leading-relaxed">
        Upload a zip of your Claude Code / Codex setup so every session launches with it.
        Layout: <span className="font-mono">claude/</span> (settings, .mcp.json, skills/, agents/) and{" "}
        <span className="font-mono">codex/</span> (config.toml, AGENTS.md). Your Bedrock model access is always preserved.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="press w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-[14px] text-[15px] font-medium text-[var(--ios-blue)] mb-5 disabled:opacity-50"
        style={{ background: "var(--ios-fill-tertiary)" }}
      >
        {busy ? <span className="typing"><span /><span /><span /></span> : <Upload className="w-[18px] h-[18px]" />}
        Upload config bundle (.zip)
      </button>

      <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2 ml-1">
        Versions
      </div>
      <div className="max-h-56 overflow-y-auto ios-scroll rounded-[14px] overflow-hidden" style={{ background: versions.length ? "var(--color-surface-2)" : "transparent" }}>
        {versions.length === 0 && (
          <p className="text-[13px] text-[var(--color-text-muted)] py-3 px-1">No config uploaded — sessions use defaults.</p>
        )}
        {versions.map((v, i) => (
          <div key={v.version} className="relative flex items-center gap-2 px-4 py-3">
            {i > 0 && <span className="absolute left-4 right-0 top-0 h-px" style={{ background: "var(--ios-separator)" }} />}
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-mono truncate">{v.version}</div>
              <div className="text-[11.5px] text-[var(--color-text-muted)]">
                {v.fileCount} files · {(v.sizeBytes / 1024).toFixed(0)} KB · {new Date(v.createdAt).toLocaleDateString()}
              </div>
            </div>
            {current === v.version ? (
              <span className="flex items-center gap-1 text-[12px] text-[var(--ios-green)] font-semibold">
                <Check className="w-4 h-4" strokeWidth={2.6} /> Active
              </span>
            ) : (
              <button
                onClick={() => setActive(v.version)}
                disabled={busy}
                className="press-sm text-[13px] font-medium px-3.5 py-1.5 rounded-full text-[var(--ios-blue)] disabled:opacity-50"
                style={{ background: "var(--ios-fill-tertiary)" }}
              >
                Use
              </button>
            )}
          </div>
        ))}
      </div>

      {current && (
        <button
          onClick={() => setActive(undefined)}
          disabled={busy}
          className="press w-full text-center mt-4 py-3 rounded-[14px] text-[15px] font-medium text-[var(--ios-red)] disabled:opacity-50"
          style={{ background: "var(--ios-fill-tertiary)" }}
        >
          Disable (use defaults)
        </button>
      )}
    </Sheet>
  );
}

interface AuthStatus {
  claude?: { connectedAt: string; label?: string };
  codex?: { connectedAt: string; label?: string };
}

/* ── Account & sign-in: connect your own Claude/ChatGPT plan ─────────────── */
function AccountSheet({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [status, setStatus] = useState<AuthStatus>({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<EmberCli | null>(null);
  const [secret, setSecret] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/ember/auth");
    if (res.ok) setStatus((await res.json()).status || {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async (cli: EmberCli) => {
    const val = secret.trim();
    if (!val) return;
    setBusy(true);
    try {
      const body = cli === "claude" ? { cli, token: val } : { cli, authJson: val };
      const res = await fetch("/api/ember/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "failed");
      onToast(`${cli === "claude" ? "Claude" : "Codex"} plan connected`);
      setSecret("");
      setOpen(null);
      await load();
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (cli: EmberCli) => {
    setBusy(true);
    try {
      await fetch(`/api/ember/auth?cli=${cli}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const rows: { cli: EmberCli; name: string; how: string; cmd: string; placeholder: string }[] = [
    {
      cli: "claude",
      name: "Claude Pro / Max",
      how: "On your laptop run `claude setup-token`, then paste the token here (or use the login MCP).",
      cmd: "claude setup-token",
      placeholder: "Paste your Claude OAuth token (sk-ant-oat…)",
    },
    {
      cli: "codex",
      name: "ChatGPT plan (Codex)",
      how: "Run `codex login` on your laptop, then paste the contents of ~/.codex/auth.json (or use the login MCP).",
      cmd: "cat ~/.codex/auth.json",
      placeholder: "Paste the JSON from ~/.codex/auth.json",
    },
  ];

  return (
    <Sheet onClose={onClose} labelledBy="cc-account-title">
      <div className="flex items-center justify-between mb-3">
        <h2 id="cc-account-title" className="text-[20px] font-bold tracking-tight">Account &amp; sign-in</h2>
        <button onClick={onClose} className="press-sm w-7 h-7 rounded-full flex items-center justify-center text-[var(--color-text-muted)]" style={{ background: "var(--ios-fill-tertiary)" }} aria-label="Close">
          <X className="w-4 h-4" strokeWidth={2.6} />
        </button>
      </div>
      <p className="text-[13px] text-[var(--color-text-secondary)] mb-5 leading-relaxed">
        Sessions run on <span className="font-semibold text-[var(--color-text-primary)]">AWS Bedrock</span> by default — no sign-in needed.
        Connect your own plan to run on <span className="font-semibold text-[var(--color-text-primary)]">your subscription</span> instead;
        pick it per session.
      </p>

      <div className="flex flex-col gap-2.5">
        {rows.map((r) => {
          const conn = status[r.cli];
          return (
            <div key={r.cli} className="rounded-[14px] p-3.5" style={{ background: "var(--color-surface-2)" }}>
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0"
                  style={{ background: r.cli === "claude" ? "rgba(217,119,87,0.16)" : "var(--ios-fill-secondary)" }}>
                  <CliMark cli={r.cli} className="w-[18px] h-[18px]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold">{r.name}</div>
                  <div className="text-[11.5px] text-[var(--color-text-muted)]">
                    {conn ? (
                      <span className="text-[var(--ios-green)] font-medium">● Connected</span>
                    ) : "Not connected"}
                  </div>
                </div>
                {conn ? (
                  <button onClick={() => disconnect(r.cli)} disabled={busy}
                    className="press-sm text-[13px] font-medium px-3 py-1.5 rounded-full text-[var(--ios-red)] disabled:opacity-50"
                    style={{ background: "var(--ios-fill-tertiary)" }}>
                    Disconnect
                  </button>
                ) : (
                  <button onClick={() => { setOpen(open === r.cli ? null : r.cli); setSecret(""); }} disabled={busy}
                    className="press-sm text-[13px] font-semibold px-3.5 py-1.5 rounded-full text-white disabled:opacity-50"
                    style={{ background: "var(--ios-blue)" }}>
                    Connect
                  </button>
                )}
              </div>

              {open === r.cli && !conn && (
                <div className="mt-3 pt-3" style={{ borderTop: "0.5px solid var(--ios-separator)" }}>
                  <p className="text-[12px] text-[var(--color-text-secondary)] mb-2 leading-relaxed">{r.how}</p>
                  <code className="block text-[11.5px] font-mono px-2.5 py-1.5 rounded-lg mb-2.5 text-[var(--color-text-secondary)]" style={{ background: "var(--ios-fill-tertiary)" }}>
                    {r.cmd}
                  </code>
                  <textarea
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={r.placeholder}
                    rows={r.cli === "codex" ? 3 : 1}
                    autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                    className="w-full px-3 py-2.5 rounded-[10px] text-[13px] font-mono outline-none resize-none border-[0.5px] border-[var(--color-border)] focus:border-[var(--ios-blue)] mb-2.5"
                    style={{ background: "var(--color-surface-1)" }}
                  />
                  <button onClick={() => connect(r.cli)} disabled={busy || !secret.trim()}
                    className="press w-full py-2.5 rounded-[12px] text-[14px] font-semibold text-white disabled:opacity-40"
                    style={{ background: "var(--ios-blue)" }}>
                    Save &amp; connect
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-[var(--color-text-muted)] mt-4 px-1 leading-relaxed">
        Easiest path: the <span className="font-mono">port-session</span> MCP — run{" "}
        <span className="font-mono">/mcp__port-session__login claude</span> (or <span className="font-mono">codex</span>) from your laptop and it pushes the credential here automatically.
      </p>
    </Sheet>
  );
}
