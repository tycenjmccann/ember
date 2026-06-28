"use client";

import Link from "next/link";
import ThemeToggle from "./ThemeToggle";

/**
 * iOS UINavigationBar — frosted, hairline separator, status-bar safe area.
 * The Ember page sizes its panes to calc(100dvh - 52px), so this height is
 * part of the layout contract.
 */
export default function TopBar({ authEnabled = false }: { authEnabled?: boolean }) {
  return (
    <header
      className="ios-blur hairline-b sticky top-0 z-50 flex-shrink-0 flex items-center justify-between px-4 md:px-5"
      style={{ height: 52, paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {/* ember mark */}
        <img src="/ember-icon.svg" alt="ember" className="h-7 w-auto shrink-0" />
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
        {/* Plain <a>, not <Link>: must hit the server route (clears cookie +
            Cognito session), not a client-side nav. Hidden in no-auth deploys. */}
        {authEnabled && (
          <a
            href="/api/auth/logout"
            className="press text-[15px] text-[var(--color-text-secondary)] px-2 py-1 rounded-[8px]"
          >
            Sign out
          </a>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
