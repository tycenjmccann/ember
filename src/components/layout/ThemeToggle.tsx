"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="press-sm flex items-center justify-center w-9 h-9 rounded-full"
      style={{ background: "var(--ios-fill-tertiary)" }}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      {theme === "dark" ? (
        <Sun className="w-[18px] h-[18px] text-[var(--ios-blue)]" strokeWidth={2.2} />
      ) : (
        <Moon className="w-[18px] h-[18px] text-[var(--ios-blue)]" strokeWidth={2.2} />
      )}
    </button>
  );
}
