import os from "node:os";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import devtools from "solid-devtools/vite";
import solid from "vite-plugin-solid";

const portValue = Number.parseInt(process.env.PORT ?? "", 10);
const devPort = Number.isFinite(portValue) && portValue > 0 ? portValue : 5173;
const allowedHosts = new Set<string>();
const envAllowedHosts = process.env.VITE_ALLOWED_HOSTS ?? "";

const addHost = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) return;
  allowedHosts.add(trimmed);
};

envAllowedHosts.split(",").forEach(addHost);
addHost(process.env.VESLO_PUBLIC_HOST ?? null);
const hostname = os.hostname();
addHost(hostname);
const shortHostname = hostname.split(".")[0];
if (shortHostname && shortHostname !== hostname) {
  addHost(shortHostname);
}
const packagedSmokeBuild = process.env.VESLO_PACKAGED_SMOKE?.trim() === "1";
const releaseSourceMaps = /^(1|true|yes)$/i.test(process.env.VESLO_GLITCHTIP_SOURCE_MAPS ?? "");
const stagingRendererCanary = /^(1|true|yes)$/i.test(process.env.VESLO_STAGING_RENDERER_CANARY ?? "");

export default defineConfig(({ command }) => ({
  ...(packagedSmokeBuild ? { envDir: false } : {}),
  define: {
    __VESLO_STAGING_RENDERER_CANARY__: JSON.stringify(stagingRendererCanary),
  },
  plugins: [
    ...(command === "serve" ? [devtools({ autoname: true })] : []),
    tailwindcss(),
    solid(),
  ],
  server: {
    port: devPort,
    strictPort: true,
    watch: {
      ignored: ["**/src/app/tests/**", "**/*.test.ts", "**/*.test.tsx"],
    },
    ...(allowedHosts.size > 0 ? { allowedHosts: Array.from(allowedHosts) } : {}),
  },
  build: {
    target: "esnext",
    sourcemap: releaseSourceMaps ? "hidden" : false,
  },
}));
