"use client";

import Link from "next/link";
import { Cloud } from "lucide-react";
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
        <div
          className="w-7 h-7 rounded-[8px] flex items-center justify-center shrink-0"
          style={{ background: "linear-gradient(180deg,#3a98ff,#007aff)", boxShadow: "0 2px 6px rgba(0,122,255,0.35)" }}
        >
          <Cloud className="w-[18px] h-[18px] text-white" strokeWidth={2.4} />
        </div>
        <h1 className="text-[17px] font-semibold tracking-tight text-[var(--color-text-primary)] truncate">
          Cloud Code
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
