"use client";

import Link from "next/link";
import ThemeToggle from "./ThemeToggle";

/**
 * iOS UINavigationBar — frosted, hairline separator, status-bar safe area.
 * The Cloud Code page sizes its panes to calc(100dvh - 52px), so this height is
 * part of the layout contract.
 */
export default function TopBar() {
  return (
    <header
      className="ios-blur hairline-b sticky top-0 z-50 flex-shrink-0 flex items-center justify-between px-4 md:px-5"
      style={{ height: 52, paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {/* ember mark */}
        <img src="/ember-icon.svg" alt="" className="w-7 h-7 shrink-0" />
        <h1 className="text-[17px] font-semibold tracking-tight text-[var(--color-text-primary)] truncate">
          ember
        </h1>
      </div>
      <div className="flex items-center gap-1">
        <Link
          href="/cost"
          className="press text-[15px] text-[var(--ios-blue)] px-2 py-1 rounded-[8px]"
        >
          Cost
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
