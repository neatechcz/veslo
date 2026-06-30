const required = [
  "VESLO_GLITCHTIP_DSN",
  "VITE_VESLO_GLITCHTIP_DSN",
  "VESLO_GLITCHTIP_ENVIRONMENT",
  "VITE_VESLO_GLITCHTIP_ENVIRONMENT",
];

const read = (key) => (process.env[key] ?? "").trim();

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

for (const key of required) {
  if (!read(key)) {
    fail(`${key} is required for release error monitoring.`);
  }
}

const nativeDsn = read("VESLO_GLITCHTIP_DSN");
const frontendDsn = read("VITE_VESLO_GLITCHTIP_DSN");

try {
  const parsed = new URL(nativeDsn);
  if (parsed.protocol !== "https:") {
    fail("VESLO_GLITCHTIP_DSN must use https.");
  }
} catch {
  fail("VESLO_GLITCHTIP_DSN must be a valid URL.");
}

if (nativeDsn && frontendDsn && nativeDsn !== frontendDsn) {
  fail("VESLO_GLITCHTIP_DSN and VITE_VESLO_GLITCHTIP_DSN must match.");
}

const nativeEnvironment = read("VESLO_GLITCHTIP_ENVIRONMENT");
const frontendEnvironment = read("VITE_VESLO_GLITCHTIP_ENVIRONMENT");
if (nativeEnvironment && frontendEnvironment && nativeEnvironment !== frontendEnvironment) {
  fail("VESLO_GLITCHTIP_ENVIRONMENT and VITE_VESLO_GLITCHTIP_ENVIRONMENT must match.");
}

for (const key of ["VESLO_GLITCHTIP_TRACES_SAMPLE_RATE", "VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE"]) {
  const raw = read(key);
  if (!raw) continue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${key} must be a number between 0 and 1.`);
  }
}

if (process.exitCode) {
  process.exit();
}

console.log("GlitchTip release monitoring environment is configured.");
