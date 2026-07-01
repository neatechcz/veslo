const required = [
  "VESLO_GLITCHTIP_DSN",
  "VITE_VESLO_GLITCHTIP_DSN",
  "VESLO_GLITCHTIP_ENVIRONMENT",
  "VITE_VESLO_GLITCHTIP_ENVIRONMENT",
];

const read = (key) => (process.env[key] ?? "").trim();
const strict = /^(1|true|yes)$/i.test(read("VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV"));

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const missing = required.filter((key) => !read(key));
if (missing.length > 0) {
  const message = `Missing GlitchTip release monitoring env: ${missing.join(", ")}.`;
  if (strict) {
    fail(`${message} Set all required values or remove VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV.`);
  } else {
    console.warn(`${message} Continuing because VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV is not enabled.`);
  }
}

const nativeDsn = read("VESLO_GLITCHTIP_DSN");
const frontendDsn = read("VITE_VESLO_GLITCHTIP_DSN");

const validateDsn = (key, value) => {
  if (!value) return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      fail(`${key} must use https.`);
    }
  } catch {
    fail(`${key} must be a valid URL.`);
  }
};

validateDsn("VESLO_GLITCHTIP_DSN", nativeDsn);
validateDsn("VITE_VESLO_GLITCHTIP_DSN", frontendDsn);

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

if (missing.length > 0) {
  console.log("GlitchTip release monitoring environment is incomplete; non-strict build will continue.");
} else {
  console.log("GlitchTip release monitoring environment is configured.");
}
