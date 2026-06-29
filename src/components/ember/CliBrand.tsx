import type { EmberCli } from "@/lib/ember/types";

// Brand palette for the coding agents. Centralized so the sidebar row,
// session header, new-session modal, and agent-turn label all stay in sync.
//   Claude  → Anthropic coral/clay (#D97757)
//   Codex   → OpenAI monochrome; on a dark theme that reads as near-white/neutral
//   Kiro    → Kiro purple (#7C5CFF)
// TODO(brand): the marks below are hand-built approximations. Swap in the
// official Anthropic / OpenAI / Kiro SVG assets before shipping externally.
export const CLI_BRAND: Record<
  EmberCli,
  { label: string; chip: string; dot: string }
> = {
  claude: {
    label: "Claude",
    // coral text on a faint coral wash
    chip: "bg-[#D97757]/15 text-[#E08B6E]",
    dot: "text-[#D97757]",
  },
  codex: {
    label: "Codex",
    chip: "bg-white/10 text-[var(--color-text-secondary)]",
    dot: "text-[var(--color-text-secondary)]",
  },
  kiro: {
    label: "Kiro",
    // purple text on a faint purple wash
    chip: "bg-[#7C5CFF]/15 text-[#A28BFF]",
    dot: "text-[#7C5CFF]",
  },
};

// Anthropic "sunburst" mark — radial spokes. Approximation; see TODO above.
function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M5.5 16.3 9.9 4.4h2.3l4.4 11.9h-2.4l-.9-2.6H8.8l-.9 2.6H5.5Zm3.9-4.5h3.3l-1.6-4.7-1.7 4.7Z" />
      <path d="M14.6 16.3 19 4.4h-2.3l-4.4 11.9h2.3Z" opacity="0.55" />
    </svg>
  );
}

// OpenAI knot mark — simplified single-stroke approximation. See TODO above.
function CodexMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 3.2a4 4 0 0 1 3.8 2.7 4 4 0 0 1 1.2 7 4 4 0 0 1-3.8 5.9 4 4 0 0 1-6.4-1.6 4 4 0 0 1-1.2-7A4 4 0 0 1 9.4 4 4 4 0 0 1 12 3.2Z" />
      <path d="M12 8.2v3.8l3.2 1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Kiro mark — simplified "k"/spark glyph. Approximation; see TODO above.
function KiroMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M7 3.5h2.3v7l5.2-7h2.7l-5.1 6.8 5.4 7.2h-2.8l-4.1-5.6-1.3 1.7v3.9H7V3.5Z" />
    </svg>
  );
}

export function CliMark({ cli, className = "w-3.5 h-3.5" }: { cli: EmberCli; className?: string }) {
  if (cli === "claude") return <ClaudeMark className={className} />;
  if (cli === "kiro") return <KiroMark className={className} />;
  return <CodexMark className={className} />;
}

// Small brand chip: logo mark + name, brand-tinted. `size` toggles padding.
export function CliBadge({ cli, className = "" }: { cli: EmberCli; className?: string }) {
  const b = CLI_BRAND[cli];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold ${b.chip} ${className}`}
    >
      <CliMark cli={cli} className="w-3 h-3" />
      {b.label}
    </span>
  );
}
