import os from "node:os";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const defaultDevServerIdentity = Buffer.from(repoRoot).toString("base64url");
const devServerIdentity = process.env.VESLO_DEV_SERVER_ID?.trim() || defaultDevServerIdentity;

const devServerIdentityPlugin = () => ({
  name: "veslo-dev-server-identity",
  configureServer(server: { middlewares: { use: (path: string, handler: (request: unknown, response: { setHeader: (name: string, value: string) => void; end: (body: string) => void }) => void) => void } }) {
    server.middlewares.use("/__veslo-dev-server", (_request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ identity: devServerIdentity }));
    });
  },
});

export default defineConfig(({ command }) => ({
  ...(packagedSmokeBuild ? { envDir: false } : {}),
  define: {
    __VESLO_STAGING_RENDERER_CANARY__: JSON.stringify(stagingRendererCanary),
  },
  plugins: [
    ...(command === "serve" ? [devServerIdentityPlugin()] : []),
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
