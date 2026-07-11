import { radixColors, tailwindSafelist } from './src/styles/tailwind-colors';
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
darkMode: 'class',
safelist: [
    tailwindSafelist
  ],
  theme: {
    // OVERRIDE the base theme completely instead of extending it
    fontFamily: {
      sans: ["var(--veslo-font-product)", "DM Sans", "system-ui", "sans-serif"],
      mono: ["var(--veslo-font-mono)", "DM Mono", "ui-monospace", "monospace"],
    },
    borderRadius: {
      none: "0",
      sm: "3px",
      DEFAULT: "4px",
      md: "4px",
      lg: "5px",
      xl: "6px",
      "2xl": "8px",
      "3xl": "10px",
      full: "9999px",
    },
    colors: {
      ...radixColors,
      dls: {
        surface: "var(--dls-surface)",
        sidebar: "var(--dls-sidebar)",
        border: "var(--dls-border)",
        accent: "var(--dls-accent)",
        text: "var(--dls-text-primary)",
        secondary: "var(--dls-text-secondary)",
        hover: "var(--dls-hover)",
        active: "var(--dls-active)",
      },
      white: "#ffffff",
      black: "#000000",
    }
  }
};
