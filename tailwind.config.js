/** @type {import('tailwindcss').Config} */
/* Ember re-skin of tailwind.config.js.
   ONLY the color scales changed: `brand` (iOS blue) → ember scale, and
   ios.blue now resolves to the ember accent var. Structure / radii / plugins
   are identical to the original. */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand == ember accent scale (so any brand-* class reads as the glow).
        brand: {
          50: "#fff3e6",
          100: "#ffe1c2",
          200: "#ffc187",
          300: "#ff9d4d",
          400: "#ff7a1a",
          500: "#ff6a00", // ember (dark)
          600: "#f25c00", // ember (light)
          700: "#cc4a00",
          800: "#a23a00",
          900: "#7a2c00",
        },
        // The ember glow scale, available as ember-* too.
        ember: {
          50: "#fff3e6",
          100: "#ffe1c2",
          200: "#ffc187",
          300: "#ff9d4d",
          400: "#ff7a1a",
          500: "#ff6a00",
          600: "#f25c00",
          700: "#cc4a00",
          800: "#a23a00",
          900: "#7a2c00",
        },
        // Warm night neutrals (the dark we light).
        night: {
          0: "#000000",
          1: "#0e0d0c",
          2: "#1a1816",
          3: "#2a2724",
          4: "#3a3531",
        },
        ash: "#8a8079",
        smoke: "#c9c2bb",
        bone: "#f5efe8",
        ios: {
          blue: "var(--ios-blue)", // now resolves to ember accent
          green: "var(--ios-green)", // kept for connected/plan-active
          red: "var(--ios-red)",
        },
        surface: {
          0: "var(--color-surface-0)",
          1: "var(--color-surface-1)",
          2: "var(--color-surface-2)",
          3: "var(--color-surface-3)",
          4: "var(--color-surface-4)",
        },
      },
      textColor: {
        primary: "var(--color-text-primary)",
        secondary: "var(--color-text-secondary)",
        muted: "var(--color-text-muted)",
      },
      borderColor: {
        theme: "var(--color-border)",
      },
      placeholderColor: {
        muted: "var(--color-text-muted)",
      },
      borderRadius: {
        "ios": "13px",
        "ios-lg": "18px",
      },
      boxShadow: {
        // The "slight glow behind buttons" — on brand, literally.
        "ember": "0 2px 16px rgba(255,106,0,0.35)",
        "ember-lg": "0 4px 28px rgba(255,106,0,0.5)",
        "bloom": "0 0 24px rgba(255,106,0,0.4)",
      },
      backgroundImage: {
        "ember-glow": "linear-gradient(180deg,#ffb24d 0%,#ff7a1a 45%,#ff4d00 100%)",
        "coal": "radial-gradient(circle,#ffd089 0%,#ff7a1a 38%,#ff4d00 70%,#7a2c00 100%)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
