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
      sans: ["var(--veslo-font-product)", "ui-sans-serif", "system-ui", "sans-serif"],
      mono: ["var(--veslo-font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
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
