"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Copy, Check, Terminal } from "lucide-react";

interface PullCommandButtonProps {
  /** The session's `cc-...` id — already carries its own prefix. */
  sessionId: string;
  className?: string;
}

/**
 * Copies the exact CLI command to pull this session down to a local terminal.
 * A web-started session has no easy way to surface its id to the terminal, so
 * we hand the user the whole command — tap to copy, paste into Claude Code.
 */
export function PullCommandButton({ sessionId, className }: PullCommandButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const command = `/mcp__port-session__pull ${sessionId}`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [command]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Copy pull command — ${command}`}
      aria-label="Copy the command to pull this session into your terminal"
      className={`press-sm flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition-colors ${
        copied
          ? "text-[var(--ios-blue)] border-[var(--ios-blue)]/40 bg-[var(--ios-blue)]/10"
          : "text-[var(--color-text-secondary)] border-[var(--ios-separator)] hover:text-[var(--color-text-primary)]"
      } ${className ?? ""}`}
    >
      {copied ? (
        <>
          <Check className="w-3 h-3" strokeWidth={2.4} />
          Copied
        </>
      ) : (
        <>
          <Terminal className="w-3 h-3" strokeWidth={2.2} />
          Pull
          <Copy className="w-3 h-3 opacity-60" strokeWidth={2.2} />
        </>
      )}
    </button>
  );
}

export default PullCommandButton;
