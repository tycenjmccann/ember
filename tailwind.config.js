/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand == iOS system blue scale (so any brand-* class reads native).
        brand: {
          50: "#e8f2ff",
          100: "#cfe4ff",
          200: "#9ecbff",
          300: "#64adff",
          400: "#3a98ff",
          500: "#0a84ff", // iOS blue (dark)
          600: "#007aff", // iOS blue (light)
          700: "#0066d6",
          800: "#0052ad",
          900: "#003f87",
        },
        ios: {
          blue: "var(--ios-blue)",
          green: "var(--ios-green)",
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
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
