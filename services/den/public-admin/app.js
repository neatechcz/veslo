const STORAGE_KEY = "veslo.den.admin.token";
const BROWSER_AUTH_STORAGE_KEY = "veslo.den.admin.browser-auth";
const OPENAI_OAUTH_STORAGE_KEY = "veslo.den.admin.openai-oauth";
const CODEX_EXHAUSTED_REASON = "all_codex_credentials_exhausted";
const DEFAULT_PAGES = ["organization", "users", "billing", "credentials", "sessions", "usage", "alerts", "audit"];
const AUTH_STATE_BYTES = 32;
const AUTH_CODE_VERIFIER_BYTES = 32;
const initialRoute = normalizeRoute(location.pathname);

const state = {
  token: localStorage.getItem(STORAGE_KEY) || "",
  page: initialRoute.page,
  authBusy: false,
  session: null,
  user: null,
  credentials: [],
  sessions: [],
  alerts: [],
  audit: [],
  users: [],
  usage: null,
  usageFilters: {
    groupBy: "total",
    credentialId: "",
    userId: "",
    orgId: "",
  },
  selectedCredentialId: null,
  selectedSessionId: null,
  selectedAlertId: null,
  selectedAuditId: null,
  selectedUserId: null,
  codexAuthUploadByCredentialId: {},
  userMode: "edit",
  userAiAccessByUserId: {},
  userAiAccessAvailableCredentialsByUserId: {},
  billingView: initialRoute.billingView,
  selectedBillingOrgId: null,
  billingByOrgId: {},
  billingInterval: "monthly",
  billingTrialEndDateOrgId: null,
  billingBusy: false,
};

const els = {
  loginPanel: document.getElementById("login-panel"),
  adminLoginEmail: document.getElementById("admin-login-email"),
  adminLoginPassword: document.getElementById("admin-login-password"),
  adminLoginSubmit: document.getElementById("admin-login-submit"),
  browserSignInButton: document.getElementById("browser-sign-in-button"),
  loginError: document.getElementById("login-error"),
  appPanel: document.getElementById("app-panel"),
  authState: document.getElementById("auth-state"),
  authUser: document.getElementById("auth-user"),
  signOutButton: document.getElementById("sign-out-button"),
  refreshButton: document.getElementById("refresh-button"),
  createUserButton: document.getElementById("create-user-button"),
  createUserButtonInline: document.getElementById("create-user-button-inline"),
  pageTitle: document.getElementById("page-title"),
  pageDescription: document.getElementById("page-description"),
  pageEyebrow: document.getElementById("page-eyebrow"),
  navItems: Array.from(document.querySelectorAll("[data-route]")),
  pages: Array.from(document.querySelectorAll("[data-page]")),
  credentialOpenAiConnect: document.getElementById("credential-openai-connect"),
  credentialOpenAiStatus: document.getElementById("credential-openai-status"),
  credentialCodexName: document.getElementById("credential-codex-name"),
  credentialCodexSecret: document.getElementById("credential-codex-secret"),
  credentialCodexSubmit: document.getElementById("credential-codex-submit"),
  credentialCodexStatus: document.getElementById("credential-codex-status"),
  credentialOpenAiCompatibleName: document.getElementById("credential-openai-compatible-name"),
  credentialOpenAiCompatibleBaseUrl: document.getElementById("credential-openai-compatible-base-url"),
  credentialOpenAiCompatibleSecret: document.getElementById("credential-openai-compatible-secret"),
  credentialOpenAiCompatibleSubmit: document.getElementById("credential-openai-compatible-submit"),
  credentialOpenAiCompatibleStatus: document.getElementById("credential-openai-compatible-status"),
  credentialAnthropicName: document.getElementById("credential-anthropic-name"),
  credentialAnthropicSecret: document.getElementById("credential-anthropic-secret"),
  credentialAnthropicSubmit: document.getElementById("credential-anthropic-submit"),
  credentialAnthropicStatus: document.getElementById("credential-anthropic-status"),
  credentialsTableBody: document.getElementById("credentials-table-body"),
  credentialDetail: document.getElementById("credential-detail"),
  sessionList: document.getElementById("session-list"),
  sessionDetail: document.getElementById("session-detail"),
  usageGroupBy: document.getElementById("usage-group-by"),
  usageCredentialFilter: document.getElementById("usage-filter-credential"),
  usageUserFilter: document.getElementById("usage-filter-user"),
  usageOrgFilter: document.getElementById("usage-filter-org"),
  usageChartBars: document.getElementById("usage-chart-bars"),
  usageTotalTokens: document.getElementById("usage-total-tokens"),
  usageTotalRequests: document.getElementById("usage-total-requests"),
  usageTopCredential: document.getElementById("usage-top-credential"),
  usageSeries: document.getElementById("usage-series"),
  usageCredentialTableBody: document.getElementById("usage-credential-table-body"),
  alertList: document.getElementById("alert-list"),
  alertDetail: document.getElementById("alert-detail"),
  userSearch: document.getElementById("user-search"),
  userStatusFilter: document.getElementById("user-status-filter"),
  userRoleFilter: document.getElementById("user-role-filter"),
  userList: document.getElementById("user-list"),
  userEditorStatus: document.getElementById("user-editor-status"),
  userEditorTitle: document.getElementById("user-editor-title"),
  userName: document.getElementById("user-name"),
  userEmail: document.getElementById("user-email"),
  userOrg: document.getElementById("user-org"),
  userRole: document.getElementById("user-role"),
  userPlatformAdmin: document.getElementById("user-platform-admin"),
  userSendInvite: document.getElementById("user-send-invite"),
  userAiAccessEnabled: document.getElementById("user-ai-access-enabled"),
  userAiAccessProvider: document.getElementById("user-ai-access-provider"),
  userAiAccessCredential: document.getElementById("user-ai-access-credential"),
  userAiAccessDefaultModel: document.getElementById("user-ai-access-default-model"),
  userAiAccessAllowedModels: document.getElementById("user-ai-access-allowed-models"),
  userAiAccessStatus: document.getElementById("user-ai-access-status"),
  userDisableButton: document.getElementById("user-disable-button"),
  userDeleteButton: document.getElementById("user-delete-button"),
  userSaveButton: document.getElementById("user-save-button"),
  userSaveStatus: document.getElementById("user-save-status"),
  auditSearch: document.getElementById("audit-search"),
  auditDateRange: document.getElementById("audit-date-range"),
  auditActorFilter: document.getElementById("audit-actor-filter"),
  auditEntityFilter: document.getElementById("audit-entity-filter"),
  auditList: document.getElementById("audit-list"),
  auditDetail: document.getElementById("audit-detail"),
  platformNavItems: Array.from(document.querySelectorAll(".platform-nav")),
  billingViewButtons: Array.from(document.querySelectorAll("[data-billing-view]")),
  billingPlatformOnly: Array.from(document.querySelectorAll(".billing-platform-only")),
  billingPlatformScopeOnly: Array.from(document.querySelectorAll(".billing-platform-scope-only")),
  billingOrgOnly: Array.from(document.querySelectorAll(".billing-org-only")),
  billingOrgSearch: document.getElementById("billing-org-search"),
  billingStatusFilter: document.getElementById("billing-status-filter"),
  billingOrganizationList: document.getElementById("billing-organization-list"),
  billingTargetName: document.getElementById("billing-target-name"),
  billingSource: document.getElementById("billing-source"),
  billingLastSync: document.getElementById("billing-last-sync"),
  billingPaymentState: document.getElementById("billing-payment-state"),
  billingAuditTarget: document.getElementById("billing-audit-target"),
  billingLicenseTotal: document.getElementById("billing-license-total"),
  billingLicenseDetail: document.getElementById("billing-license-detail"),
  billingActiveUsers: document.getElementById("billing-active-users"),
  billingUserDetail: document.getElementById("billing-user-detail"),
  billingInterval: document.getElementById("billing-interval"),
  billingRenewal: document.getElementById("billing-renewal"),
  billingStatusChip: document.getElementById("billing-status-chip"),
  billingNoticeTitle: document.getElementById("billing-notice-title"),
  billingNoticeText: document.getElementById("billing-notice-text"),
  billingManagedAi: document.getElementById("billing-managed-ai"),
  billingLicenseLimit: document.getElementById("billing-license-limit"),
  billingExtendedInput: document.getElementById("billing-extended-input"),
  billingIntervalButtons: Array.from(document.querySelectorAll("[data-billing-interval]")),
  billingBasicQuantity: document.getElementById("billing-basic-quantity"),
  billingExtendedQuantity: document.getElementById("billing-extended-quantity"),
  billingTrialEndDate: document.getElementById("billing-trial-end-date"),
  billingUpdateButton: document.getElementById("billing-update-button"),
  billingPortalButton: document.getElementById("billing-portal-button"),
  billingRefreshButton: document.getElementById("billing-refresh-button"),
  billingCreateTrialButton: document.getElementById("billing-create-trial-button"),
  billingRevokeTrialButton: document.getElementById("billing-revoke-trial-button"),
  billingTrialHelper: document.getElementById("billing-trial-helper"),
  billingActionStatus: document.getElementById("billing-action-status"),
  heroMetrics: Array.from(document.querySelectorAll(".hero-metrics .metric-card strong")),
};

function normalizeRoute(pathname) {
  const path = pathname.replace(/\/+$/, "");
  if (!path || path === "/admin") {
    return { page: "overview", billingView: "organization" };
  }
  if (path === "/admin/billing" || path.startsWith("/admin/billing/")) {
    return {
      page: "billing",
      billingView: path.endsWith("/platform") ? "platform" : "organization",
    };
  }
  const page = path.split("/").pop();
  return {
    page: DEFAULT_PAGES.includes(page) ? page : "overview",
    billingView: "organization",
  };
}

function normalizePage(pathname) {
  return normalizeRoute(pathname).page;
}

function authStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readPendingBrowserAuth(expectedSessionId = "") {
  const store = authStorage();
  if (!store) return null;

  try {
    const raw = store.getItem(BROWSER_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.sessionId !== "string" ||
      typeof parsed?.state !== "string" ||
      typeof parsed?.codeVerifier !== "string"
    ) {
      return null;
    }
    if (expectedSessionId && parsed.sessionId !== expectedSessionId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePendingBrowserAuth(value) {
  const store = authStorage();
  if (!store) return;
  try {
    store.setItem(BROWSER_AUTH_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore browser storage failures
  }
}

function clearPendingBrowserAuth(expectedSessionId = "") {
  const store = authStorage();
  if (!store) return;
  try {
    const pending = readPendingBrowserAuth();
    if (!expectedSessionId || pending?.sessionId === expectedSessionId) {
      store.removeItem(BROWSER_AUTH_STORAGE_KEY);
    }
  } catch {
    // ignore browser storage failures
  }
}

function readPendingOpenAiOAuth(expectedState = "") {
  const store = authStorage();
  if (!store) return null;

  try {
    const raw = store.getItem(OPENAI_OAUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.state !== "string") {
      return null;
    }
    if (expectedState && parsed.state !== expectedState) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePendingOpenAiOAuth(value) {
  const store = authStorage();
  if (!store) return;
  try {
    store.setItem(OPENAI_OAUTH_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore browser storage failures
  }
}

function clearPendingOpenAiOAuth(expectedState = "") {
  const store = authStorage();
  if (!store) return;
  try {
    const pending = readPendingOpenAiOAuth();
    if (!expectedState || pending?.state === expectedState) {
      store.removeItem(OPENAI_OAUTH_STORAGE_KEY);
    }
  } catch {
    // ignore browser storage failures
  }
}

function toBase64Url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomBase64Url(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256Base64Url(value) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toBase64Url(digest);
}

function readDesktopAuthCallbackParams() {
  if (isOpenAiOAuthCallback()) {
    return null;
  }
  const params = new URLSearchParams(location.search);
  const code = params.get("code")?.trim() || "";
  const sessionId =
    params.get("transactionId")?.trim() ||
    params.get("sessionId")?.trim() ||
    "";
  return code && sessionId ? { code, sessionId } : null;
}

function isOpenAiOAuthCallback() {
  return location.pathname === "/admin/oauth/openai/callback";
}

function readOpenAiOAuthCallbackParams() {
  if (!isOpenAiOAuthCallback()) {
    return null;
  }
  const params = new URLSearchParams(location.search);
  const code = params.get("code")?.trim() || "";
  const state = params.get("state")?.trim() || "";
  return code && state ? { code, state } : null;
}

function clearAuthCallbackParams() {
  history.replaceState(null, "", location.pathname);
}

function normalizeBrowserAuthorizeUrl(rawUrl) {
  const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value, location.origin);
    const runningLocally = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (runningLocally && parsed.hostname === "host.docker.internal") {
      parsed.hostname = location.hostname === "127.0.0.1" ? "127.0.0.1" : "localhost";
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeAiAccess(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      enabled: false,
      credentialId: null,
      provider: "",
      defaultModel: "",
      allowedModels: [],
      updatedAt: null,
    };
  }

  const allowedModels = Array.isArray(payload.allowedModels)
    ? payload.allowedModels.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];

  return {
    id: typeof payload.id === "string" ? payload.id : "",
    userId: typeof payload.userId === "string" ? payload.userId : "",
    enabled: payload.enabled === true,
    credentialId: typeof payload.credentialId === "string" ? payload.credentialId : null,
    provider: typeof payload.provider === "string" ? payload.provider : "",
    defaultModel: typeof payload.defaultModel === "string" ? payload.defaultModel : "",
    allowedModels,
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
  };
}

function currentUserAiAccess(userId) {
  return normalizeAiAccess(state.userAiAccessByUserId[userId] || null);
}

function normalizeAvailableCredentials(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id.trim() : "",
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      provider: typeof entry.provider === "string" ? entry.provider.trim() : "",
    }))
    .filter((entry) => entry.id)
    .map((entry) => ({
      id: entry.id,
      name: entry.name || entry.id,
      provider: entry.provider,
    }));
}

function currentUserAiAccessAvailableCredentials(userId, provider = "") {
  return normalizeAvailableCredentials(state.userAiAccessAvailableCredentialsByUserId[userId] || [])
    .filter((entry) => !provider || entry.provider === provider);
}

function formatAllowedModels(models) {
  return (models || []).join("\n");
}

function parseAllowedModelsInput(value) {
  return value
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readAiAccessFormValue() {
  return {
    enabled: els.userAiAccessEnabled.checked,
    provider: els.userAiAccessProvider.value || null,
    defaultModel: els.userAiAccessDefaultModel.value.trim() || null,
    allowedModels: parseAllowedModelsInput(els.userAiAccessAllowedModels.value),
  };
}

function readAiAccessCredentialValue() {
  const selectedProvider = els.userAiAccessProvider.value || "";
  if (selectedProvider === "codex_oauth" || selectedProvider === "openai_compatible") {
    const selectedCredentialId = els.userAiAccessCredential.value.trim();
    return selectedCredentialId || null;
  }

  const user = currentUser();
  const currentAiAccess = user?.id ? currentUserAiAccess(user.id) : normalizeAiAccess(null);
  return currentAiAccess.provider === selectedProvider ? currentAiAccess.credentialId : null;
}

function summarizeUser(user) {
  const membership = user.memberships?.[0];
  const orgPart = membership ? `${membership.role} in ${membership.orgName}` : "no org membership";
  const rolePart = user.platformAdmin ? "Platform admin" : "Member";
  return `${rolePart} · ${orgPart}`;
}

function userStatus(user) {
  return user.disabled ? "Disabled" : user.emailVerified ? "Active" : "Invited";
}

function setStatus(text, userText = "") {
  els.authState.textContent = text;
  els.authUser.textContent = userText || "";
}

function setBrowserAuthBusy(busy, label = "Sign in with Browser") {
  state.authBusy = busy;
  if (!els.browserSignInButton) {
    return;
  }
  els.browserSignInButton.disabled = busy;
  els.browserSignInButton.textContent = busy ? "Opening browser login..." : label;
}

function setAdminLoginBusy(busy) {
  if (els.adminLoginSubmit) {
    els.adminLoginSubmit.disabled = busy;
    els.adminLoginSubmit.textContent = busy ? "Signing in..." : "Sign in";
  }
  if (els.adminLoginEmail) {
    els.adminLoginEmail.disabled = busy;
  }
  if (els.adminLoginPassword) {
    els.adminLoginPassword.disabled = busy;
  }
}

function showLogin(message = "") {
  els.loginPanel.classList.remove("hidden");
  els.appPanel.classList.add("hidden");
  els.createUserButton.classList.add("hidden");
  els.loginError.textContent = message;
  els.loginError.classList.toggle("hidden", !message);
  setAdminLoginBusy(false);
  setBrowserAuthBusy(false);
  setStatus("Signed out", "browser sign-in required");
}

function showApp() {
  els.loginPanel.classList.add("hidden");
  els.appPanel.classList.remove("hidden");
  els.createUserButton.classList.toggle("hidden", state.page !== "users");
  updateAdminChromeForSession();
}

function setActivePage(page) {
  state.page = page;
  const nextPath =
    page === "overview" ? "/admin" :
    page === "billing" ? `/admin/billing/${state.billingView}` :
    `/admin/${page}`;
  const nextUrl = `${nextPath}${location.search}${location.hash}`;
  if (location.pathname !== nextPath) {
    history.replaceState(null, "", nextUrl);
  }
  els.navItems.forEach((item) => item.classList.toggle("active", item.dataset.route === page));
  els.pages.forEach((panel) => {
    const active = panel.dataset.page === page || (page === "overview" && panel.dataset.page === "overview");
    panel.classList.toggle("hidden", !active);
  });
  els.createUserButton.classList.toggle("hidden", page !== "users");

  const titles = {
    overview: ["Veslo managed AI", "Overview", "Inspect credentials, sessions, usage, alerts, users, and audit events from one place."],
    organization: ["Organization", "Organization", "Manage organization profile, domains, invites, users, and billing context."],
    billing: ["Billing", "Billing", "Manage organization licenses, Stripe billing state, entitlement, and payment recovery."],
    credentials: ["Veslo managed AI", "Credentials", "Use the Codex/ChatGPT runtime profile first; OpenAI and Anthropic credentials are legacy fallbacks."],
    sessions: ["Veslo managed AI", "Sessions", "Review sticky leases, rebinding history, and worker ownership."],
    usage: ["Veslo managed AI", "Usage", "Analyze total token usage first, then break it down by credential, user, or org."],
    alerts: ["Veslo managed AI", "Alerts", "Triage credential failures, usage spikes, and session anomalies."],
    users: ["Veslo managed AI", "Users", "Create, edit, disable, or remove users from the directory."],
    audit: ["Veslo managed AI", "Audit", "Filter by actor, action, or entity and inspect detailed change history."],
  };

  const [eyebrow, title, description] = titles[page] || titles.overview;
  els.pageEyebrow.textContent = eyebrow;
  els.pageTitle.textContent = title;
  els.pageDescription.textContent = description;
  if (page === "billing") {
    renderBilling();
  }
}

function updateAdminChromeForSession() {
  const platformAdmin = state.session?.platformAdmin === true;
  els.platformNavItems.forEach((item) => item.classList.toggle("hidden", !platformAdmin));
  if (state.session && !platformAdmin && state.billingView === "platform") {
    state.billingView = "organization";
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`/admin/api${path}`, {
    credentials: "include",
    ...options,
    headers,
  });

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  }
  return { response, payload };
}

async function fetchJson(path, options = {}) {
  const { response, payload } = await api(path, options);
  if (!response.ok) {
    const error = new Error(payload?.error || "request_failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function isNotImplementedError(error) {
  return error instanceof Error && (error.status === 501 || error.message === "not_implemented");
}

function logLoadFailure(label, error) {
  if (isNotImplementedError(error)) {
    return;
  }
  console.error(label, error);
}

async function fetchDesktopAuthJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function signInWithPassword() {
  const email = els.adminLoginEmail?.value.trim() || "";
  const password = els.adminLoginPassword?.value || "";

  els.loginError.classList.add("hidden");
  if (!email || !password) {
    showLogin("Email and password are required.");
    return;
  }

  setAdminLoginBusy(true);
  try {
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      showLogin(payload?.message || payload?.error || "Sign in failed.");
      return;
    }

    const headerToken = response.headers.get("set-auth-token")?.split(".")[0]?.trim() || "";
    const token = typeof payload?.token === "string" && payload.token.trim()
      ? payload.token.trim()
      : headerToken;
    if (!token) {
      showLogin("Sign in succeeded, but no admin token was returned.");
      return;
    }

    state.token = token;
    localStorage.setItem(STORAGE_KEY, token);
    if (els.adminLoginPassword) {
      els.adminLoginPassword.value = "";
    }
    await bootstrapSession();
  } catch (error) {
    showLogin(error instanceof Error ? error.message : "Sign in failed.");
  } finally {
    setAdminLoginBusy(false);
  }
}

async function bootstrapSession() {
  if (!state.token) {
    showLogin();
    return;
  }

  setStatus("Checking session", "validating stored token");
  const { response, payload } = await api("/session", { method: "GET" });
  if (!response.ok) {
    state.session = null;
    state.user = null;
    const shouldClearToken = payload?.error === "unauthorized" || payload?.error === "forbidden"
    if (shouldClearToken) {
      state.token = ""
      localStorage.removeItem(STORAGE_KEY)
    }
    showLogin(
      shouldClearToken && payload?.error === "unauthorized"
        ? "Your session expired. Sign in again."
        : shouldClearToken && payload?.error === "forbidden"
          ? "You do not have admin access."
          : "Unable to verify session.",
    )
    if (!shouldClearToken) {
      setStatus("Session check failed", "stored token kept")
    }
    return;
  }

  state.session = payload;
  state.user = payload?.user || null;
  const adminRole = payload?.platformAdmin === true ? "platform admin" : "organization admin";
  setStatus("Signed in", state.user ? `${state.user.name || state.user.email} · ${adminRole}` : adminRole);
  showApp();
  populateOrganizationOptions();
  await loadAllData();
}

function populateOrganizationOptions() {
  const organizations = Array.isArray(state.session?.organizations) ? state.session.organizations : [];
  els.userOrg.innerHTML = organizations.length
    ? organizations.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.name)}</option>`).join("")
    : `<option value="">No organization</option>`;
}

async function startBrowserAuth() {
  els.loginError.classList.add("hidden");
  setBrowserAuthBusy(true);

  try {
    const stateValue = randomBase64Url(AUTH_STATE_BYTES);
    const codeVerifier = randomBase64Url(AUTH_CODE_VERIFIER_BYTES);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const redirectUri = `${location.origin}${location.pathname}`;

    const { response, payload } = await fetchDesktopAuthJson("/v2/desktop-auth/start", {
      intent: "signin",
      redirectUri,
      state: stateValue,
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    if (!response.ok) {
      showLogin(payload?.error || payload?.message || "Unable to start browser sign in.");
      return;
    }

    const authorizeUrl = normalizeBrowserAuthorizeUrl(typeof payload?.authorizeUrl === "string" ? payload.authorizeUrl : "");
    const sessionId =
      typeof payload?.transactionId === "string" ? payload.transactionId.trim() :
      typeof payload?.sessionId === "string" ? payload.sessionId.trim() :
      "";
    if (!authorizeUrl || !sessionId) {
      showLogin("Browser sign in started, but the response was incomplete.");
      return;
    }

    writePendingBrowserAuth({
      sessionId,
      state: stateValue,
      codeVerifier,
    });

    window.location.assign(authorizeUrl);
  } catch (error) {
    showLogin(error instanceof Error ? error.message : "Unable to start browser sign in.");
  }
}

async function completeBrowserAuth() {
  const callback = readDesktopAuthCallbackParams();
  if (!callback) {
    return false;
  }

  const pending = readPendingBrowserAuth(callback.sessionId);
  clearAuthCallbackParams();

  if (!pending) {
    showLogin("This browser sign-in session is missing local handoff proof. Start sign-in again.");
    return true;
  }

  setStatus("Completing sign in", "exchanging browser handoff");
  setBrowserAuthBusy(true, "Completing sign in...");

  try {
    const { response, payload } = await fetchDesktopAuthJson("/v2/desktop-auth/exchange", {
      code: callback.code,
      transactionId: callback.sessionId || pending.sessionId,
      state: pending.state,
      codeVerifier: pending.codeVerifier,
    });

    if (!response.ok) {
      showLogin(
        payload?.error === "forbidden"
          ? "You do not have admin access."
          : payload?.error || payload?.message || "Browser sign in failed.",
      );
      return true;
    }

    const token = typeof payload?.token === "string" ? payload.token : "";
    if (!token) {
      showLogin("Browser sign in succeeded but no token was returned.");
      return true;
    }

    state.token = token;
    localStorage.setItem(STORAGE_KEY, token);
    await bootstrapSession();
    return true;
  } catch (error) {
    showLogin(error instanceof Error ? error.message : "Browser sign in failed.");
    return true;
  } finally {
    clearPendingBrowserAuth(callback.sessionId || pending.sessionId);
  }
}

async function initializeAuth() {
  const completedCallback = await completeBrowserAuth();
  if (completedCallback) {
    return;
  }
  await bootstrapSession();
  if (state.token) {
    await completeOpenAiOAuth();
  }
}

function signOut() {
  state.token = "";
  state.session = null;
  state.user = null;
  state.credentials = [];
  state.sessions = [];
  state.alerts = [];
  state.audit = [];
  state.users = [];
  state.usage = null;
  state.selectedCredentialId = null;
  state.selectedSessionId = null;
  state.selectedAlertId = null;
  state.selectedAuditId = null;
  state.selectedUserId = null;
  state.userMode = "edit";
  localStorage.removeItem(STORAGE_KEY);
  showLogin("Signed out.");
}

async function loadAllData() {
  await Promise.all([
    loadCredentials(),
    loadSessions(),
    loadAlerts(),
    loadUsers(),
    loadAudit(),
    loadUsage(),
  ]);
  await loadBillingForVisibleOrganizations();
  renderOverview();
  renderBilling();
}

async function loadCredentials() {
  try {
    const payload = await fetchJson("/credentials");
    state.credentials = Array.isArray(payload?.credentials) ? payload.credentials : [];
    if (!state.selectedCredentialId || !state.credentials.some((entry) => entry.id === state.selectedCredentialId)) {
      state.selectedCredentialId = state.credentials[0]?.id || null;
    }
    renderCredentials();
  } catch (error) {
    if (isNotImplementedError(error)) {
      state.credentials = [];
      state.selectedCredentialId = null;
      renderCredentials();
      return;
    }
    logLoadFailure("loadCredentials failed", error);
  }
}

async function loadSessions() {
  try {
    const payload = await fetchJson("/sessions");
    state.sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    if (!state.selectedSessionId || !state.sessions.some((entry) => entry.id === state.selectedSessionId)) {
      state.selectedSessionId = state.sessions[0]?.id || null;
    }
    renderSessions();
  } catch (error) {
    if (isNotImplementedError(error)) {
      state.sessions = [];
      state.selectedSessionId = null;
      renderSessions();
      return;
    }
    logLoadFailure("loadSessions failed", error);
  }
}

async function loadAlerts() {
  try {
    const payload = await fetchJson("/alerts");
    state.alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
    if (!state.selectedAlertId || !state.alerts.some((entry) => entry.id === state.selectedAlertId)) {
      state.selectedAlertId = state.alerts[0]?.id || null;
    }
    renderAlerts();
  } catch (error) {
    if (isNotImplementedError(error)) {
      state.alerts = [];
      state.selectedAlertId = null;
      renderAlerts();
      return;
    }
    logLoadFailure("loadAlerts failed", error);
  }
}

async function loadAudit() {
  try {
    const payload = await fetchJson("/audit");
    state.audit = Array.isArray(payload?.events) ? payload.events : [];
    if (!state.selectedAuditId || !state.audit.some((entry) => entry.id === state.selectedAuditId)) {
      state.selectedAuditId = state.audit[0]?.id || null;
    }
    renderAudit();
  } catch (error) {
    if (isNotImplementedError(error)) {
      state.audit = [];
      state.selectedAuditId = null;
      renderAudit();
      return;
    }
    logLoadFailure("loadAudit failed", error);
  }
}

async function loadUserAiAccess(userId) {
  const resolvedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!resolvedUserId) {
    return null;
  }

  const payload = await fetchJson(`/users/${encodeURIComponent(resolvedUserId)}/ai-access`);
  const aiAccess = normalizeAiAccess(payload?.aiAccess || null);
  state.userAiAccessAvailableCredentialsByUserId[resolvedUserId] = normalizeAvailableCredentials(
    payload?.availableCredentials,
  );
  state.userAiAccessByUserId[resolvedUserId] = aiAccess;
  return aiAccess;
}

async function saveUserAiAccess(userId, input = null) {
  const resolvedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!resolvedUserId) {
    return;
  }

  const aiAccessInput = input && typeof input === "object"
    ? {
        enabled: input.enabled === true,
        provider: typeof input.provider === "string" ? input.provider : null,
        defaultModel: typeof input.defaultModel === "string" ? input.defaultModel : null,
        allowedModels: Array.isArray(input.allowedModels) ? input.allowedModels : [],
        credentialId: typeof input.credentialId === "string" ? input.credentialId : null,
      }
    : {
        ...readAiAccessFormValue(),
        credentialId: readAiAccessCredentialValue(),
      };

  const saved = await fetchJson(`/users/${encodeURIComponent(resolvedUserId)}/ai-access`, {
    method: "PUT",
    body: JSON.stringify(aiAccessInput),
  });
  state.userAiAccessAvailableCredentialsByUserId[resolvedUserId] = normalizeAvailableCredentials(
    saved?.availableCredentials,
  );
  state.userAiAccessByUserId[resolvedUserId] = normalizeAiAccess(saved?.aiAccess || null);
}

async function loadUsers() {
  try {
    const payload = await fetchJson("/users");
    state.users = Array.isArray(payload?.users) ? payload.users : [];
    if (!state.selectedUserId || !state.users.some((entry) => entry.id === state.selectedUserId)) {
      state.selectedUserId = state.users[0]?.id || null;
    }
    if (state.userMode !== "create" && !state.selectedUserId) {
      state.userMode = "create";
    }
    renderUsers();
    if (state.userMode !== "create" && state.selectedUserId) {
      try {
        await loadUserAiAccess(state.selectedUserId);
      } catch (error) {
        if (!isNotImplementedError(error)) {
          throw error;
        }
        state.userAiAccessAvailableCredentialsByUserId[state.selectedUserId] = [];
        state.userAiAccessByUserId[state.selectedUserId] = normalizeAiAccess(null);
      }
      const user = currentUser();
      if (user) {
        populateUserEditor(user);
      }
    }
    setUserSaveStatus(
      state.userMode === "create"
        ? "Fill in the profile and save to create the user."
        : "Directory changes and AI access assignments are applied separately.",
    );
  } catch (error) {
    logLoadFailure("loadUsers failed", error);
    setUserSaveStatus(
      `Unable to load users: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function loadUsage() {
  try {
    const params = new URLSearchParams();
    params.set("groupBy", state.usageFilters.groupBy);
    if (state.usageFilters.credentialId) {
      params.set("credentialId", state.usageFilters.credentialId);
    }
    if (state.usageFilters.userId) {
      params.set("userId", state.usageFilters.userId);
    }
    if (state.usageFilters.orgId) {
      params.set("orgId", state.usageFilters.orgId);
    }
    const payload = await fetchJson(`/usage?${params.toString()}`);
    state.usage = payload;
    renderUsage();
  } catch (error) {
    if (isNotImplementedError(error)) {
      state.usage = {
        credentialUsage: [],
        filters: { credentials: [], users: [], orgs: [] },
        series: [],
        summary: { totalTokens: 0, totalRequests: 0 },
        topCredentials: [],
      };
      renderUsage();
      return;
    }
    logLoadFailure("loadUsage failed", error);
  }
}

function renderOverview() {
  const metrics = [
    String(state.sessions.length),
    String(state.credentials.filter((entry) => entry.state !== "healthy").length),
    String(state.users.length),
  ];
  els.heroMetrics.forEach((node, index) => {
    if (metrics[index]) {
      node.textContent = metrics[index];
    }
  });
}

function setBillingActionStatus(message = "", tone = "") {
  if (!els.billingActionStatus) {
    return;
  }
  els.billingActionStatus.textContent = message;
  els.billingActionStatus.dataset.tone = tone;
}

function billingStatusTone(status) {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "incomplete") return "pending";
  if (status === "unpaid" || status === "canceled") return "error";
  return "info";
}

function billingForOrg(orgId) {
  return orgId ? state.billingByOrgId[orgId] || null : null;
}

function billingHasActiveTrial(account) {
  if (account?.mode !== "manual_access" || account?.source !== "manual_trial" || account?.manualAccess?.enabled !== true) {
    return false;
  }
  if (account.manualAccess.unlimited === true) {
    return true;
  }
  if (!account.manualAccess.expiresAt) {
    return false;
  }
  const expiresAt = new Date(account.manualAccess.expiresAt);
  return Number.isFinite(expiresAt.getTime()) && expiresAt > new Date();
}

async function loadBillingForOrg(orgId) {
  if (!orgId) {
    return null;
  }
  const payload = await fetchJson(`/organizations/${encodeURIComponent(orgId)}/billing`);
  const billing = payload?.billing || null;
  state.billingByOrgId[orgId] = billing;
  return billing;
}

async function loadBillingForVisibleOrganizations() {
  const organizations = collectBillingBaseOrganizations();
  await Promise.all(organizations.map(async (org) => {
    try {
      await loadBillingForOrg(org.id);
    } catch (error) {
      logLoadFailure(`loadBilling failed for ${org.id}`, error);
    }
  }));
}

function collectBillingBaseOrganizations() {
  const byId = new Map();
  const sessionOrganizations = Array.isArray(state.session?.organizations) ? state.session.organizations : [];
  for (const org of sessionOrganizations) {
    if (org?.id) {
      byId.set(org.id, {
        id: org.id,
        name: org.name || org.slug || org.id,
        slug: org.slug || org.id,
      });
    }
  }

  for (const user of state.users) {
    for (const membership of user.memberships || []) {
      if (!membership?.orgId) continue;
      if (!byId.has(membership.orgId)) {
        byId.set(membership.orgId, {
          id: membership.orgId,
          name: membership.orgName || membership.orgSlug || membership.orgId,
          slug: membership.orgSlug || membership.orgId,
        });
      }
    }
  }

  return Array.from(byId.values()).map((org) => {
    const activeUsers = state.users.filter((user) =>
      user.disabled !== true && (user.memberships || []).some((membership) => membership.orgId === org.id),
    ).length;
    return { ...org, activeUsers };
  });
}

function collectBillingOrganizations() {
  return collectBillingBaseOrganizations().map((org) => {
    const billing = billingForOrg(org.id);
    const account = billing?.account || null;
    const entitlement = billing?.entitlement || null;
    const quantities = account?.quantities || {};
    const activeUsers = Number(billing?.activeUserCount ?? entitlement?.activeUserCount ?? org.activeUsers ?? 0);
    const isUnlimited = account?.manualAccess?.unlimited === true || entitlement?.isUnlimited === true;
    const licenseLimit = isUnlimited ? null : Number(billing?.licenseLimit ?? entitlement?.licenseLimit ?? 0);
    const status = account?.status || entitlement?.status || "none";
    const mode = account?.mode || entitlement?.effectiveMode || "none";
    const paymentProblem = account?.paymentProblem?.code || entitlement?.managedAiBlockingReason || "";

    return {
      ...org,
      activeUsers,
      status,
      mode,
      source: account?.source || "Not configured",
      paymentProblem,
      licenseLimit,
      isUnlimited,
      basicQuantity: Number(quantities.managedAiBasic || 0),
      extendedQuantity: Number(quantities.managedAiExtended || 0),
      interval: account?.billingInterval || "None",
      renewal: account?.cancelAtPeriodEnd ? "Canceling" : status === "active" || status === "trialing" ? "Stripe managed" : "None",
      billing,
    };
  });
}

function selectedBillingOrganization() {
  const organizations = collectBillingOrganizations();
  if (organizations.length === 0) {
    return null;
  }
  const selected = organizations.find((org) => org.id === state.selectedBillingOrgId);
  const fallback = organizations.find((org) => org.id === state.session?.activeOrgId) || organizations[0];
  state.selectedBillingOrgId = selected?.id || fallback.id;
  return selected || fallback;
}

function renderBilling() {
  if (!els.billingOrganizationList) {
    return;
  }

  const platformAdmin = state.session?.platformAdmin === true;
  if (state.session && !platformAdmin && state.billingView === "platform") {
    state.billingView = "organization";
  }

  els.billingViewButtons.forEach((button) => {
    const view = button.dataset.billingView || "organization";
    button.classList.toggle("active", view === state.billingView);
    button.disabled = view === "platform" && !platformAdmin;
  });
  els.billingPlatformOnly.forEach((node) => node.classList.toggle("hidden", !platformAdmin));
  els.billingPlatformScopeOnly.forEach((node) => node.classList.toggle("hidden", state.billingView !== "platform" || !platformAdmin));
  els.billingOrgOnly.forEach((node) => node.classList.toggle("hidden", false));

  if (state.page === "billing") {
    els.pageEyebrow.textContent = platformAdmin ? "Platform Admin" : "Organization Admin";
    els.pageTitle.textContent = "Billing";
    els.pageDescription.textContent = platformAdmin
      ? "Manage the selected organization billing flow and use platform-only controls when operating across organizations."
      : "Manage licenses, billing interval, invoices, payment recovery, and Stripe portal access for your organization.";
  }

  const organizations = collectBillingOrganizations();
  const term = els.billingOrgSearch?.value?.trim().toLowerCase() || "";
  const statusFilter = els.billingStatusFilter?.value || "all";
  const visibleOrganizations = organizations.filter((org) =>
    (!term || `${org.name} ${org.slug}`.toLowerCase().includes(term)) &&
    (statusFilter === "all" || org.status === statusFilter),
  );
  els.billingOrganizationList.innerHTML = visibleOrganizations.map((org) => `
    <article class="billing-org-card ${org.id === state.selectedBillingOrgId ? "active" : ""}" data-billing-org-id="${escapeHtml(org.id)}">
      <div>
        <strong>${escapeHtml(org.name)}</strong>
        <p>${escapeHtml(`${org.activeUsers}/${org.isUnlimited ? "Unlimited" : org.licenseLimit} active users · ${org.isUnlimited ? "Unlimited trial" : org.source}`)}</p>
      </div>
      <span class="status-chip ${billingStatusTone(org.status)}">${escapeHtml(org.status === "none" ? "Not configured" : org.status)}</span>
    </article>
  `).join("") || `<article class="billing-org-card active"><div><strong>No organizations</strong><p>No organization is available to this admin session.</p></div></article>`;

  const org = selectedBillingOrganization();
  const activeUsers = org?.activeUsers ?? 0;
  const licenseLimit = org?.licenseLimit ?? 0;
  const targetName = org?.name || "No organization selected";
  const billing = org?.billing || null;
  const account = billing?.account || null;
  const entitlement = billing?.entitlement || null;
  const canUseManagedAi = entitlement?.canUseManagedAi === true;
  const isStripeConfigured = account?.stripe?.subscriptionConfigured === true;
  const hasActiveTrial = billingHasActiveTrial(account);
  const isUnlimitedTrial = hasActiveTrial && org?.isUnlimited === true;
  const statusTone = billingStatusTone(org?.status || "none");
  els.billingTargetName.textContent = targetName;
  els.billingSource.textContent = isUnlimitedTrial ? "Unlimited trial" : org?.source || "Not configured";
  els.billingLastSync.textContent = account?.updatedAt ? formatDate(account.updatedAt) : "Awaiting Stripe event";
  els.billingPaymentState.textContent = org?.paymentProblem ? "Payment issue" : canUseManagedAi ? "Active" : "No paid access";
  els.billingAuditTarget.textContent = org?.id || "No organization selected";
  els.billingLicenseTotal.textContent = isUnlimitedTrial ? "Unlimited" : String(licenseLimit);
  els.billingLicenseDetail.textContent = isUnlimitedTrial ? "No seat limit" : `${org?.basicQuantity ?? 0} Basic, ${org?.extendedQuantity ?? 0} Extended`;
  els.billingActiveUsers.textContent = String(activeUsers);
  els.billingUserDetail.textContent = isUnlimitedTrial ? "Unlimited capacity" : `${Math.max(licenseLimit - activeUsers, 0)} licenses available`;
  els.billingInterval.textContent = org?.interval || "None";
  els.billingRenewal.textContent = isUnlimitedTrial ? "No expiry" : org?.renewal || "None";
  els.billingStatusChip.textContent = isUnlimitedTrial ? "Unlimited trial" : org?.status && org.status !== "none" ? org.status : "Not configured";
  els.billingStatusChip.className = `status-chip ${statusTone}`;
  els.billingNoticeTitle.textContent = isUnlimitedTrial ? "Unlimited trial" : hasActiveTrial ? "Trial access is active" : canUseManagedAi ? "AI inference is enabled" : "Managed AI is blocked";
  els.billingNoticeText.textContent = isUnlimitedTrial
    ? "No Veslo expiration, seat limit, or token cap. Usage is recorded and upstream provider limits still apply."
    : hasActiveTrial
    ? `Manual trial access ends ${account?.manualAccess?.expiresAt ? formatDate(account.manualAccess.expiresAt) : "on the selected trial date"}.`
    : canUseManagedAi
    ? "The organization has Managed AI access and enough licenses for the current entitlement."
    : entitlement?.managedAiBlockingReason === "requested_license_limit_below_active_users"
      ? "Increase the license count before re-enabling Managed AI for all active users."
      : "History and settings remain readable. Managed AI inference requires paid or platform-granted access.";
  els.billingManagedAi.textContent = canUseManagedAi ? "Allowed" : "Blocked";
  els.billingLicenseLimit.textContent = isUnlimitedTrial ? "Unlimited" : `${licenseLimit} users`;
  els.billingExtendedInput.textContent = isUnlimitedTrial ? "Not limited" : `${org?.extendedQuantity ?? 0} seats`;
  const billingFormHasFocus = [
    els.billingBasicQuantity,
    els.billingExtendedQuantity,
    els.billingTrialEndDate,
  ].includes(document.activeElement);
  if (els.billingBasicQuantity && !billingFormHasFocus) {
    els.billingBasicQuantity.value = String(org?.basicQuantity ?? 0);
  }
  if (els.billingExtendedQuantity && !billingFormHasFocus) {
    els.billingExtendedQuantity.value = String(org?.extendedQuantity ?? 0);
  }
  if (els.billingTrialEndDate && document.activeElement !== els.billingTrialEndDate) {
    if (state.billingTrialEndDateOrgId !== org?.id) {
      els.billingTrialEndDate.value = account?.manualAccess?.expiresAt ? account.manualAccess.expiresAt.slice(0, 10) : "";
      state.billingTrialEndDateOrgId = org?.id || null;
    } else if (hasActiveTrial && account?.manualAccess?.expiresAt) {
      els.billingTrialEndDate.value = account.manualAccess.expiresAt.slice(0, 10);
    }
  }
  const currentInterval = org?.interval === "annual" || org?.interval === "monthly" ? org.interval : state.billingInterval;
  state.billingInterval = currentInterval;
  els.billingIntervalButtons.forEach((button) => {
    button.classList.toggle("active", (button.dataset.billingInterval || "monthly") === currentInterval);
  });
  if (els.billingUpdateButton) {
    els.billingUpdateButton.textContent = isStripeConfigured ? "Update licenses" : "Start checkout";
    els.billingUpdateButton.disabled = state.billingBusy || !org;
  }
  if (els.billingPortalButton) {
    els.billingPortalButton.disabled = state.billingBusy || !account?.stripe?.customerConfigured;
  }
  if (els.billingRefreshButton) {
    els.billingRefreshButton.disabled = state.billingBusy || !org;
  }
  if (els.billingCreateTrialButton) {
    els.billingCreateTrialButton.disabled = state.billingBusy || !org || isStripeConfigured;
    els.billingCreateTrialButton.title = isStripeConfigured
      ? "Trial creation is disabled because this organization already has a Stripe subscription."
      : "";
  }
  if (els.billingRevokeTrialButton) {
    els.billingRevokeTrialButton.disabled = state.billingBusy || !org || !hasActiveTrial;
  }
  if (els.billingTrialHelper) {
    els.billingTrialHelper.textContent = state.billingView === "platform" && platformAdmin && isStripeConfigured
      ? "Trial creation is disabled because this organization already has a Stripe subscription."
      : "";
  }
}

function readBillingFormQuantities() {
  const managedAiBasic = Number(els.billingBasicQuantity?.value ?? "0");
  const managedAiExtended = Number(els.billingExtendedQuantity?.value ?? "0");
  if (!Number.isInteger(managedAiBasic) || managedAiBasic < 0 || !Number.isInteger(managedAiExtended) || managedAiExtended < 0) {
    return null;
  }
  return { managedAiBasic, managedAiExtended };
}

async function refreshSelectedBilling() {
  const org = selectedBillingOrganization();
  if (!org) {
    return;
  }
  try {
    state.billingBusy = true;
    setBillingActionStatus("Refreshing billing state...");
    renderBilling();
    await loadBillingForOrg(org.id);
    setBillingActionStatus("Billing state refreshed.", "success");
  } catch (error) {
    setBillingActionStatus(`Unable to refresh billing: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  } finally {
    state.billingBusy = false;
    renderBilling();
  }
}

function readTrialEndDateIso() {
  const value = els.billingTrialEndDate?.value || "";
  if (!value) {
    return null;
  }
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

async function submitPlatformBillingUpdate(orgId, body, workingMessage, successMessage) {
  try {
    state.billingBusy = true;
    setBillingActionStatus(workingMessage);
    renderBilling();
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/billing/platform`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    await loadBillingForOrg(orgId);
    setBillingActionStatus(successMessage, "success");
  } catch (error) {
    setBillingActionStatus(`Unable to update platform billing: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  } finally {
    state.billingBusy = false;
    renderBilling();
  }
}

async function createBillingTrial() {
  const org = selectedBillingOrganization();
  if (!org) {
    setBillingActionStatus("Select an organization first.", "error");
    return;
  }
  const account = billingForOrg(org.id)?.account || null;
  if (account?.stripe?.subscriptionConfigured === true) {
    setBillingActionStatus("Trial creation is disabled because this organization already has a Stripe subscription.", "error");
    return;
  }
  await submitPlatformBillingUpdate(
    org.id,
    {
      mode: "manual_access",
      source: "manual_trial",
      status: "trialing",
      manualAccess: { enabled: true, unlimited: true, expiresAt: null },
    },
    "Enabling unlimited trial...",
    "Unlimited trial enabled.",
  );
}

async function revokeBillingTrial() {
  const org = selectedBillingOrganization();
  if (!org) {
    setBillingActionStatus("Select an organization first.", "error");
    return;
  }
  await submitPlatformBillingUpdate(
    org.id,
    {
      mode: "none",
      source: null,
      status: "none",
      quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
      manualAccess: { enabled: false, unlimited: false, expiresAt: null },
    },
    "Revoking trial access...",
    "Trial access revoked.",
  );
}

async function submitBillingUpdate() {
  const org = selectedBillingOrganization();
  if (!org) {
    setBillingActionStatus("Select an organization first.", "error");
    return;
  }
  const quantities = readBillingFormQuantities();
  if (!quantities) {
    setBillingActionStatus("License quantities must be whole numbers.", "error");
    return;
  }
  if (quantities.managedAiBasic <= 0 && quantities.managedAiExtended <= 0) {
    setBillingActionStatus("Choose at least one Basic or Extended license.", "error");
    return;
  }

  const orgId = org.id;
  const account = billingForOrg(orgId)?.account || null;
  const hasSubscription = account?.stripe?.subscriptionConfigured === true;

  try {
    state.billingBusy = true;
    setBillingActionStatus(hasSubscription ? "Updating subscription..." : "Opening Stripe checkout...");
    renderBilling();
    if (hasSubscription) {
      await fetchJson(`/organizations/${encodeURIComponent(orgId)}/billing/plan`, {
        method: "PATCH",
        body: JSON.stringify({ quantities }),
      });
      await loadBillingForOrg(orgId);
      setBillingActionStatus("Subscription quantities updated.", "success");
      return;
    }

    const payload = await fetchJson(`/organizations/${encodeURIComponent(orgId)}/billing/checkout`, {
      method: "POST",
      body: JSON.stringify({
        interval: state.billingInterval,
        quantities,
      }),
    });
    const checkout = payload?.checkout || null;
    if (!checkout?.url) {
      throw new Error("checkout_url_missing");
    }
    window.location.assign(checkout.url);
  } catch (error) {
    setBillingActionStatus(`Unable to update billing: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  } finally {
    state.billingBusy = false;
    renderBilling();
  }
}

async function openBillingPortal() {
  const org = selectedBillingOrganization();
  if (!org) {
    setBillingActionStatus("Select an organization first.", "error");
    return;
  }
  const orgId = org.id;
  try {
    state.billingBusy = true;
    setBillingActionStatus("Opening Stripe portal...");
    renderBilling();
    const payload = await fetchJson(`/organizations/${encodeURIComponent(orgId)}/billing/portal`, {
      method: "POST",
    });
    const portal = payload?.portal || null;
    if (!portal?.url) {
      throw new Error("portal_url_missing");
    }
    window.location.assign(portal.url);
  } catch (error) {
    setBillingActionStatus(`Unable to open portal: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  } finally {
    state.billingBusy = false;
    renderBilling();
  }
}

function renderCredentials() {
  const codexCredential = state.credentials.find((entry) => entry.provider === "codex_oauth");
  if (codexCredential) {
    const tone = codexCredential.state === "healthy" ? "success" : codexCredential.state === "revoked" ? "error" : "pending";
    setCodexCredentialStatus(
      `Primary routing credential connected as ${codexCredential.name} (${codexCredential.state}).`,
      tone,
    );
  } else {
    setCodexCredentialStatus("Primary routing credential for Codex OAuth inference proxying.");
  }

  const openAiCredential = state.credentials.find((entry) => entry.provider === "openai" && entry.type === "oauth");
  if (openAiCredential) {
    const tone = openAiCredential.state === "healthy" ? "success" : openAiCredential.state === "revoked" ? "error" : "pending";
    setOpenAiCredentialStatus(
      `Legacy OpenAI fallback connected as ${openAiCredential.name} (${openAiCredential.state}).`,
      tone,
    );
  } else {
    setOpenAiCredentialStatus("Fallback only: connect platform OpenAI OAuth if Codex OAuth inference proxying is disabled.");
  }

  const rows = state.credentials.map((credential) => {
    const activeClass = credential.id === state.selectedCredentialId ? "row-alert" : "";
    return `<tr class="${activeClass}" data-credential-id="${escapeHtml(credential.id)}">
      <td><strong>${escapeHtml(credential.name)}</strong><span>${escapeHtml(credential.scope)}</span></td>
      <td>${escapeHtml(credential.type)}</td>
      <td><span class="status-chip">${escapeHtml(credential.state)}</span></td>
      <td><a href="/admin/alerts" data-open-alerts="${escapeHtml(credential.id)}">${escapeHtml(String(credential.alertCount))} active alerts</a></td>
      <td>${escapeHtml(String(credential.activeLeases))}</td>
      <td>${escapeHtml(formatDate(credential.lastRefreshAt))}</td>
      <td>${escapeHtml(formatNumber(credential.cachedTokens))}</td>
      <td>${renderCredentialEligibility(credential)}</td>
      <td>${renderCredentialCodexStatus(credential)}</td>
    </tr>`;
  }).join("");

  els.credentialsTableBody.innerHTML = rows || `<tr><td colspan="9">No credentials found.</td></tr>`;

  const selected = currentCredential();
  if (selected) {
    const selectedUpstreamStatus = formatCredentialUpstreamStatus(selected);
    const codexAuthUpload = state.codexAuthUploadByCredentialId[selected.id] || null;
    els.credentialDetail.innerHTML = `
      <p class="eyebrow">Selected credential</p>
      <h3>${escapeHtml(selected.name)}</h3>
      <div class="stack">
        <label class="credential-detail-field">
          <span>Display name</span>
          <input class="input" data-credential-rename-input type="text" value="${escapeHtml(selected.name)}" />
        </label>
        <div class="button-row">
          <button class="button button-secondary" type="button" data-credential-rename>Save name</button>
          <p class="editor-note credential-detail-status" data-credential-rename-status></p>
        </div>
        <div class="detail-line"><span>Health</span><strong>${escapeHtml(selected.state)}</strong></div>
        <div class="detail-line"><span>Linked alerts</span><strong>${escapeHtml(String(selected.alertCount))}</strong></div>
        <div class="detail-line"><span>Last failure</span><strong>${escapeHtml(formatDate(selected.lastFailureAt))}</strong></div>
        <div class="detail-line"><span>Rotation</span><strong>${escapeHtml(formatDate(selected.nextRotationAt))}</strong></div>
        <div class="detail-line"><span>Cached tokens</span><strong>${escapeHtml(formatNumber(selected.cachedTokens))}</strong></div>
        <div class="detail-line"><span>Total tokens</span><strong>${escapeHtml(formatNumber(selected.totalTokens))}</strong></div>
        ${selected.provider === "codex_oauth" ? `
          <div class="detail-line"><span>Eligibility</span><strong>${escapeHtml(selected.eligibility?.state || "unknown")}</strong></div>
          <div class="detail-line"><span>Codex upstream</span><strong>${escapeHtml(selectedUpstreamStatus.label)}</strong></div>
          <div class="detail-line"><span>Codex limits</span><strong>${escapeHtml(selectedUpstreamStatus.limitSummary || "5h: unknown | Weekly: unknown")}</strong></div>
          <div class="credential-command-block">
            <div class="button-row">
              <button class="button button-primary" type="button" data-credential-codex-upload>Prepare local upload</button>
              ${codexAuthUpload?.command ? `<button class="button button-secondary" type="button" data-codex-auth-upload-copy>Copy command</button>` : ""}
            </div>
            ${codexAuthUpload?.command ? `
              <textarea class="input credential-command-output" readonly data-codex-auth-upload-command>${escapeHtml(codexAuthUpload.command)}</textarea>
              <p class="editor-note credential-detail-status" data-codex-auth-upload-status>Command expires ${escapeHtml(formatDate(codexAuthUpload.upload?.expiresAt))}</p>
            ` : `<p class="editor-note credential-detail-status" data-codex-auth-upload-status></p>`}
          </div>
        ` : ""}
      </div>
      <div class="button-row">
        <button class="button button-secondary" type="button" data-credential-action="drain">Drain</button>
        <button class="button button-secondary" type="button" data-credential-action="rotate">Rotate</button>
        <button class="button button-secondary" type="button" data-credential-action="revoke">Revoke</button>
        <button class="button button-primary" type="button" data-route-alerts>Open alerts</button>
      </div>
    `;
  }
}

function renderSessions() {
  els.sessionList.innerHTML = state.sessions.map((entry) => `
    <article class="list-card ${entry.id === state.selectedSessionId ? "active" : ""}" data-session-id="${escapeHtml(entry.id)}">
      <div>
        <strong>${escapeHtml(entry.id)}</strong>
        <p>${escapeHtml(entry.userLabel)}, ${escapeHtml(entry.projectLabel)}, worker ${escapeHtml(entry.workerLabel)}</p>
      </div>
      <span class="status-chip">${escapeHtml(entry.state)}</span>
    </article>
  `).join("") || `<article class="list-card active"><div><strong>No sessions</strong><p>There are no tracked session leases yet.</p></div></article>`;

  const selected = state.sessions.find((entry) => entry.id === state.selectedSessionId) || state.sessions[0];
  if (selected) {
    const credential = state.credentials.find((entry) => entry.id === selected.credentialId);
    els.sessionDetail.innerHTML = `
      <p class="eyebrow">Selected session</p>
      <h3>${escapeHtml(selected.id)}</h3>
      <div class="timeline">
        <div><span>Current state</span><strong>${escapeHtml(selected.state)}</strong></div>
        <div><span>Active binding</span><strong>${escapeHtml(credential?.name || selected.credentialId)}</strong></div>
        <div><span>Last failover</span><strong>${escapeHtml(formatDate(selected.lastFailoverAt))}</strong></div>
        <div><span>Last seen</span><strong>${escapeHtml(formatDate(selected.lastSeenAt))}</strong></div>
      </div>
      <div class="button-row">
        <button class="button button-secondary" type="button">Open trace</button>
        <button class="button button-primary" type="button">Watch session</button>
      </div>
    `;
  }
}

function renderUsage() {
  if (!state.usage) {
    return;
  }

  const { credentialUsage = [], filters, series, summary, topCredentials } = state.usage;
  els.usageGroupBy.value = state.usageFilters.groupBy;
  els.usageCredentialFilter.innerHTML = `<option value="">All credentials</option>${filters.credentials.map((entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === state.usageFilters.credentialId ? " selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}`;
  els.usageUserFilter.innerHTML = `<option value="">All users</option>${filters.users.map((entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === state.usageFilters.userId ? " selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}`;
  els.usageOrgFilter.innerHTML = `<option value="">All orgs</option>${filters.orgs.map((entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === state.usageFilters.orgId ? " selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}`;
  els.usageTotalTokens.textContent = formatNumber(summary.totalTokens);
  els.usageTotalRequests.textContent = formatNumber(summary.totalRequests);
  els.usageTopCredential.textContent = topCredentials[0]?.label || "No data";

  const maxTokens = Math.max(...series.map((entry) => entry.totalTokens), 1);
  els.usageChartBars.innerHTML = series.slice(0, 7).map((entry) => {
    const height = Math.max(12, Math.round((entry.totalTokens / maxTokens) * 100));
    return `<span title="${escapeHtml(entry.label)} · ${escapeHtml(formatNumber(entry.totalTokens))} tokens" style="height: ${height}%"></span>`;
  }).join("");

  els.usageSeries.innerHTML = series.map((entry) => `
    <article class="list-card active">
      <div>
        <strong>${escapeHtml(entry.label)}</strong>
        <p>${escapeHtml(formatNumber(entry.totalRequests))} requests</p>
      </div>
      <span class="status-chip">${escapeHtml(formatNumber(entry.totalTokens))} tokens</span>
    </article>
  `).join("") || `<article class="list-card active"><div><strong>No usage</strong><p>No usage matched the selected filters.</p></div></article>`;

  els.usageCredentialTableBody.innerHTML = credentialUsage.map((credential) => {
    const upstreamStatus = formatCredentialUpstreamStatus(credential);
    return `<tr>
      <td><strong>${escapeHtml(credential.name || credential.label || credential.id)}</strong><span>${escapeHtml(credential.id)}</span></td>
      <td>${escapeHtml(formatProviderName(credential.provider))}</td>
      <td><span class="status-chip">${escapeHtml(credential.state || "unknown")}</span></td>
      <td>${escapeHtml(formatNumber(credential.totalRequests))}</td>
      <td>${escapeHtml(formatNumber(credential.cachedTokens))}</td>
      <td>${escapeHtml(formatNumber(credential.totalTokens))}</td>
      <td>${escapeHtml(formatNumber(credential.activeLeases))}</td>
      <td>${escapeHtml(formatDate(credential.lastUsedAt))}</td>
      <td>${renderCredentialEligibility(credential)}</td>
      <td><span class="status-chip ${escapeHtml(upstreamStatus.tone)}">${escapeHtml(upstreamStatus.label)}</span><span>${escapeHtml(upstreamStatus.detail)}</span><span>${escapeHtml(upstreamStatus.limitSummary)}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="10">No credential usage matched the selected filters.</td></tr>`;
}

function formatProviderName(provider) {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "codex_oauth") return "Codex / ChatGPT";
  if (provider === "openai_compatible") return "OpenAI-compatible provider";
  return provider || "Unknown";
}

function formatCredentialUpstreamStatus(credential) {
  const status = credential?.upstreamStatus;
  if (!status) {
    return {
      label: "No upstream status",
      detail: "Historical usage only.",
      limitSummary: "",
      tone: "info",
    };
  }

  if (status.available) {
    const limitSummary = formatCredentialLimitSummary(status);
    const hasLimits = Boolean(status.limits?.fiveHour || status.limits?.weekly);
    return {
      label: status.label || (hasLimits ? "Codex limits available" : "Codex OK, limits unknown"),
      detail: [status.detail, status.checkedAt ? `Checked ${formatDate(status.checkedAt)}` : ""]
        .filter(Boolean)
        .join(" "),
      limitSummary,
      tone: hasLimits ? "success" : "info",
    };
  }

  return {
    label: status.label || "Codex limits unavailable",
    detail: status.detail || "Status probe did not return limits.",
    limitSummary: "",
    tone: "warning",
  };
}

function renderCredentialCodexStatus(credential) {
  if (credential.provider !== "codex_oauth") {
    return `<span class="muted">N/A</span>`;
  }

  const upstreamStatus = formatCredentialUpstreamStatus(credential);
  return `<span class="status-chip ${escapeHtml(upstreamStatus.tone)}">${escapeHtml(upstreamStatus.label)}</span><span>${escapeHtml(upstreamStatus.limitSummary)}</span><span>${escapeHtml(upstreamStatus.detail)}</span>`;
}

function renderCredentialEligibility(credential) {
  if (credential.provider !== "codex_oauth") {
    return `<span class="muted">N/A</span>`;
  }

  const eligibility = credential.eligibility || {
    state: "unavailable",
    reason: "Eligibility status unavailable",
    resetAt: null,
  };
  const tone = credentialEligibilityTone(eligibility.state);
  const reasonText = eligibility.reason === CODEX_EXHAUSTED_REASON
    ? "Codex credential pool exhausted."
    : eligibility.reason;
  const reason = reasonText ? ` ${reasonText}` : "";
  const reset = eligibility.resetAt ? ` Resets ${formatDate(eligibility.resetAt)}` : "";
  return `<span class="status-chip ${escapeHtml(tone)}">${escapeHtml(eligibility.state)}</span><span>${escapeHtml(`${reason}${reset}`.trim())}</span>`;
}

function credentialEligibilityTone(state) {
  if (state === "eligible") return "success";
  if (state === "exhausted" || state === "draining") return "warning";
  if (state === "revoked" || state === "unhealthy") return "danger";
  return "info";
}

function formatCredentialLimitSummary(status) {
  const limits = status?.limits;

  const lines = [
    formatLimitWindowSummary("5h", limits?.fiveHour),
    formatLimitWindowSummary("Weekly", limits?.weekly),
  ];

  if (typeof status.planType === "string" && status.planType.trim()) {
    lines.unshift(`Plan ${status.planType}`);
  }

  return lines.join(" | ");
}

function formatLimitWindowSummary(label, entry) {
  if (!entry) {
    return `${label}: unknown`;
  }
  const used = typeof entry.usedPercent === "number" ? `${Math.round(entry.usedPercent)}% used` : "usage unknown";
  const reset = entry.resetAt ? `resets ${formatDate(entry.resetAt)}` : "reset unknown";
  return `${entry.label || label}: ${used}, ${reset}`;
}

function renderAlerts() {
  els.alertList.innerHTML = state.alerts.map((alert) => `
    <article class="alert-card ${alert.severity === "critical" ? "critical" : ""} ${alert.id === state.selectedAlertId ? "active" : ""}" data-alert-id="${escapeHtml(alert.id)}">
      <div class="alert-head">
        <strong>${escapeHtml(alert.title)}</strong>
        <span class="status-chip">${escapeHtml(alert.severity)}</span>
      </div>
      <p>${escapeHtml(alert.runbook)}</p>
      <div class="alert-meta">
        <span>${escapeHtml(alert.source)}</span>
        <span>${escapeHtml(formatDate(alert.lastSeenAt))}</span>
      </div>
    </article>
  `).join("") || `<article class="alert-card active"><div class="alert-head"><strong>No alerts</strong></div><p>No active alert records.</p></article>`;

  const selected = currentAlert();
  if (selected) {
    const credential = state.credentials.find((entry) => entry.id === selected.credentialId);
    els.alertDetail.innerHTML = `
      <p class="eyebrow">Runbook</p>
      <h3>${escapeHtml(selected.title)}</h3>
      <div class="stack">
        <div class="detail-line"><span>Affected credential</span><strong>${escapeHtml(credential?.name || "Unassigned")}</strong></div>
        <div class="detail-line"><span>Affected sessions</span><strong>${escapeHtml(String(selected.affectedSessions))}</strong></div>
        <div class="detail-line"><span>Owner</span><strong>${escapeHtml(selected.owner || "Unassigned")}</strong></div>
        <div class="detail-line"><span>Status</span><strong>${escapeHtml(selected.status)}</strong></div>
      </div>
      <div class="button-row">
        <button class="button button-secondary" type="button" data-alert-action="acknowledge">Acknowledge</button>
        <button class="button button-primary" type="button" data-alert-action="resolve">Resolve</button>
        <button class="button button-secondary" type="button" data-route-audit>Open audit</button>
      </div>
    `;
  }
}

function filteredUsers() {
  const term = els.userSearch.value.trim().toLowerCase();
  const status = els.userStatusFilter.value;
  const role = els.userRoleFilter.value;

  return state.users.filter((user) => {
    if (term && !`${user.name} ${user.email}`.toLowerCase().includes(term)) {
      return false;
    }

    if (status === "Active" && userStatus(user) !== "Active") {
      return false;
    }
    if (status === "Invited" && userStatus(user) !== "Invited") {
      return false;
    }
    if (status === "Disabled" && userStatus(user) !== "Disabled") {
      return false;
    }

    if (role === "platform_admin" && user.platformAdmin !== true) {
      return false;
    }
    if (role === "member" && user.platformAdmin === true) {
      return false;
    }

    return true;
  });
}

function findUserByEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) {
    return null;
  }
  return state.users.find((user) => typeof user.email === "string" && user.email.trim().toLowerCase() === normalized) || null;
}

function currentUser() {
  if (state.userMode === "create") {
    return null;
  }
  return state.users.find((entry) => entry.id === state.selectedUserId) || null;
}

function currentCredential() {
  return state.credentials.find((entry) => entry.id === state.selectedCredentialId) || state.credentials[0] || null;
}

function currentAlert() {
  return state.alerts.find((entry) => entry.id === state.selectedAlertId) || state.alerts[0] || null;
}

function renderAiAccessCredentialOptions(user, aiAccess) {
  const selectedProvider = els.userAiAccessProvider.value || "";
  const availableCredentials = user?.id ? currentUserAiAccessAvailableCredentials(user.id, selectedProvider) : [];
  const options = [
    `<option value="">Select assigned credential</option>`,
    ...availableCredentials.map(
      (credential) =>
        `<option value="${escapeHtml(credential.id)}">${escapeHtml(credential.name)}</option>`,
    ),
  ];

  els.userAiAccessCredential.innerHTML = options.join("");
  const selectedCredentialId =
    (aiAccess.provider === "codex_oauth" || aiAccess.provider === "openai_compatible") &&
    aiAccess.provider === selectedProvider &&
    availableCredentials.some((entry) => entry.id === aiAccess.credentialId)
      ? aiAccess.credentialId
      : "";
  els.userAiAccessCredential.value = selectedCredentialId || "";
  els.userAiAccessCredential.disabled =
    state.userMode === "create" ||
    !user ||
    (selectedProvider !== "codex_oauth" && selectedProvider !== "openai_compatible") ||
    availableCredentials.length === 0;
}

function updateAiAccessStatusText(user, aiAccess) {
  if (state.userMode === "create") {
    els.userAiAccessStatus.textContent = "Create the user first, then assign provider and models.";
    return;
  }

  const selectedProvider = els.userAiAccessProvider.value || "";
  const availableCredentials = user?.id ? currentUserAiAccessAvailableCredentials(user.id, selectedProvider) : [];
  if (selectedProvider === "codex_oauth" && availableCredentials.length === 0) {
    els.userAiAccessStatus.textContent = "Create a shared Codex inference credential first, then assign it here.";
    return;
  }
  if (selectedProvider === "openai_compatible" && availableCredentials.length === 0) {
    els.userAiAccessStatus.textContent = "Create a healthy OpenAI-compatible credential first, then assign it here.";
    return;
  }

  els.userAiAccessStatus.textContent = aiAccess.updatedAt
    ? `Assignments updated ${formatDate(aiAccess.updatedAt)}.`
    : "Assignments are enforced by DEN and route codex_oauth model requests through the inference proxy.";
}

function populateUserEditor(user) {
  const isCreate = state.userMode === "create";
  const membership = user?.memberships?.[0];
  const aiAccess = user?.id ? currentUserAiAccess(user.id) : normalizeAiAccess(null);
  els.userEditorStatus.textContent = isCreate ? "Create user" : userStatus(user);
  els.userEditorTitle.textContent = isCreate ? "New user" : (user?.name || user?.email || "User");
  els.userName.value = user?.name || "";
  els.userEmail.value = user?.email || "";
  els.userEmail.disabled = !isCreate;
  els.userOrg.disabled = !isCreate;
  els.userRole.disabled = !isCreate;
  els.userPlatformAdmin.checked = user?.platformAdmin === true;
  els.userSendInvite.checked = true;
  els.userSendInvite.disabled = !isCreate;
  if (membership?.orgId) {
    els.userOrg.value = membership.orgId;
    els.userRole.value = membership.role;
  } else if (els.userOrg.options.length > 0) {
    els.userOrg.selectedIndex = 0;
    els.userRole.value = "member";
  }
  els.userDisableButton.textContent = user?.disabled ? "Enable user" : "Disable user";
  els.userDisableButton.disabled = isCreate || !user;
  els.userDeleteButton.disabled = isCreate || !user;
  els.userAiAccessEnabled.checked = aiAccess.enabled;
  els.userAiAccessEnabled.disabled = isCreate || !user;
  els.userAiAccessProvider.value = aiAccess.provider || "";
  els.userAiAccessProvider.disabled = isCreate || !user;
  renderAiAccessCredentialOptions(user, aiAccess);
  els.userAiAccessDefaultModel.value = aiAccess.defaultModel || "";
  els.userAiAccessDefaultModel.disabled = isCreate || !user;
  els.userAiAccessAllowedModels.value = formatAllowedModels(aiAccess.allowedModels);
  els.userAiAccessAllowedModels.disabled = isCreate || !user;
  updateAiAccessStatusText(user, aiAccess);
}

function renderUsers() {
  const users = filteredUsers();
  els.userList.innerHTML = users.map((user) => `
    <article class="list-card ${user.id === state.selectedUserId && state.userMode !== "create" ? "active" : ""}" data-user-id="${escapeHtml(user.id)}">
      <div>
        <strong>${escapeHtml(user.name)}</strong>
        <p>${escapeHtml(`${user.email} · ${summarizeUser(user)}`)}</p>
      </div>
      <span class="status-chip">${escapeHtml(userStatus(user))}</span>
    </article>
  `).join("") || `<article class="list-card active"><div><strong>No users</strong><p>No users matched the current filters.</p></div></article>`;

  populateUserEditor(currentUser());
}

function filteredAudit() {
  const term = els.auditSearch.value.trim().toLowerCase();
  const actor = els.auditActorFilter.value;
  const entity = els.auditEntityFilter.value;

  return state.audit.filter((entry) => {
    if (term && !`${entry.actor} ${entry.action} ${entry.entityType} ${entry.summary}`.toLowerCase().includes(term)) {
      return false;
    }
    if (actor === "Platform admin" && !entry.actor.toLowerCase().includes("vaclav")) {
      return false;
    }
    if (entity !== "All entities" && entity && entry.entityType.toLowerCase() !== entity.toLowerCase()) {
      return false;
    }
    return true;
  });
}

function renderAudit() {
  const events = filteredAudit();
  els.auditList.innerHTML = events.map((entry) => `
    <article class="audit-row ${entry.id === state.selectedAuditId ? "active" : ""}" data-audit-id="${escapeHtml(entry.id)}">
      <div>
        <strong>${escapeHtml(entry.action)}</strong>
        <p>${escapeHtml(entry.summary)}</p>
      </div>
      <span>${escapeHtml(formatDate(entry.timestamp))}</span>
    </article>
  `).join("") || `<article class="audit-row active"><div><strong>No events</strong><p>No audit events matched the current filters.</p></div><span></span></article>`;

  const selected = events.find((entry) => entry.id === state.selectedAuditId) || events[0];
  if (selected) {
    state.selectedAuditId = selected.id;
    els.auditDetail.innerHTML = `
      <p class="eyebrow">Event detail</p>
      <h3>${escapeHtml(selected.action)}</h3>
      <div class="stack">
        <div class="detail-line"><span>Actor</span><strong>${escapeHtml(selected.actor)}</strong></div>
        <div class="detail-line"><span>Changed fields</span><strong>${escapeHtml(selected.changedFields.join(", ") || "None")}</strong></div>
        <div class="detail-line"><span>Result</span><strong>${escapeHtml(selected.result)}</strong></div>
        <div class="detail-line"><span>Entity</span><strong>${escapeHtml(`${selected.entityType}:${selected.entityId}`)}</strong></div>
      </div>
      <div class="button-row">
        <button class="button button-secondary" type="button">Open entity</button>
        <button class="button button-secondary" type="button">Trace request</button>
      </div>
    `;
  }
}

function enterCreateMode() {
  state.userMode = "create";
  state.selectedUserId = null;
  setActivePage("users");
  showApp();
  renderUsers();
  setUserSaveStatus("Fill in the profile and save to create the user.");
}

async function refreshCredentialOperations() {
  await Promise.all([
    loadCredentials(),
    loadSessions(),
    loadAlerts(),
    loadAudit(),
  ]);
  renderOverview();
}

async function refreshSelectedUserAiAccessOptions() {
  if (state.userMode === "create" || !state.selectedUserId) {
    return;
  }

  await loadUserAiAccess(state.selectedUserId);
  const user = currentUser();
  if (user) {
    populateUserEditor(user);
  }
}

function setAnthropicCredentialStatus(message, tone = "neutral") {
  els.credentialAnthropicStatus.textContent = message;
  if (tone === "neutral") {
    delete els.credentialAnthropicStatus.dataset.tone;
    return;
  }
  els.credentialAnthropicStatus.dataset.tone = tone;
}

function setOpenAiCredentialStatus(message, tone = "neutral") {
  els.credentialOpenAiStatus.textContent = message;
  if (tone === "neutral") {
    delete els.credentialOpenAiStatus.dataset.tone;
    return;
  }
  els.credentialOpenAiStatus.dataset.tone = tone;
}

function setCodexCredentialStatus(message, tone = "neutral") {
  els.credentialCodexStatus.textContent = message;
  if (tone === "neutral") {
    delete els.credentialCodexStatus.dataset.tone;
    return;
  }
  els.credentialCodexStatus.dataset.tone = tone;
}

function setInlineStatus(node, message, tone = "neutral") {
  if (!node) {
    return;
  }
  node.textContent = message;
  if (tone === "neutral") {
    delete node.dataset.tone;
    return;
  }
  node.dataset.tone = tone;
}

function setOpenAiCompatibleCredentialStatus(message, tone = "neutral") {
  els.credentialOpenAiCompatibleStatus.textContent = message;
  if (tone === "neutral") {
    delete els.credentialOpenAiCompatibleStatus.dataset.tone;
    return;
  }
  els.credentialOpenAiCompatibleStatus.dataset.tone = tone;
}

function setUserSaveStatus(message, tone = "neutral") {
  els.userSaveStatus.textContent = message;
  if (tone === "neutral") {
    delete els.userSaveStatus.dataset.tone;
    return;
  }
  els.userSaveStatus.dataset.tone = tone;
}

function resetAnthropicCredentialForm() {
  els.credentialAnthropicName.value = "";
  els.credentialAnthropicSecret.value = "";
}

function resetCodexCredentialForm() {
  els.credentialCodexName.value = "";
  els.credentialCodexSecret.value = "";
}

function resetOpenAiCompatibleCredentialForm() {
  els.credentialOpenAiCompatibleName.value = "";
  els.credentialOpenAiCompatibleBaseUrl.value = "";
  els.credentialOpenAiCompatibleSecret.value = "";
}

async function createCodexCredential() {
  const name = els.credentialCodexName.value.trim();
  const secret = els.credentialCodexSecret.value.trim();

  if (!secret) {
    setCodexCredentialStatus("Codex runtime auth JSON is required.", "error");
    return;
  }

  els.credentialCodexSubmit.disabled = true;
  setCodexCredentialStatus("Saving Codex inference credential", "pending");

  try {
    const requestBody = { provider: "codex_oauth", secret };
    if (name) {
      requestBody.name = name;
    }

    const payload = await fetchJson("/credentials", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    state.selectedCredentialId = payload?.credential?.id || state.selectedCredentialId;
    resetCodexCredentialForm();
    setCodexCredentialStatus("Codex inference credential saved to the platform pool.", "success");
    await refreshCredentialOperations();
    await refreshSelectedUserAiAccessOptions();
  } catch (error) {
    setCodexCredentialStatus(
      `Unable to save Codex inference credential: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.credentialCodexSubmit.disabled = false;
  }
}

async function createOpenAiCompatibleCredential() {
  const name = els.credentialOpenAiCompatibleName.value.trim();
  const baseUrl = els.credentialOpenAiCompatibleBaseUrl.value.trim();
  const secret = els.credentialOpenAiCompatibleSecret.value.trim();

  if (!baseUrl || !secret) {
    setOpenAiCompatibleCredentialStatus("OpenAI-compatible base URL and API key are required.", "error");
    return;
  }

  els.credentialOpenAiCompatibleSubmit.disabled = true;
  setOpenAiCompatibleCredentialStatus("Saving OpenAI-compatible provider credential", "pending");

  try {
    const requestBody = { provider: "openai_compatible", baseUrl, secret };
    if (name) {
      requestBody.name = name;
    }

    const payload = await fetchJson("/credentials", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    state.selectedCredentialId = payload?.credential?.id || state.selectedCredentialId;
    resetOpenAiCompatibleCredentialForm();
    setOpenAiCompatibleCredentialStatus("OpenAI-compatible provider credential saved to the platform pool.", "success");
    await refreshCredentialOperations();
    await refreshSelectedUserAiAccessOptions();
  } catch (error) {
    setOpenAiCompatibleCredentialStatus(
      `Unable to save OpenAI-compatible provider credential: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.credentialOpenAiCompatibleSubmit.disabled = false;
  }
}

async function createAnthropicCredential() {
  const name = els.credentialAnthropicName.value.trim();
  const secret = els.credentialAnthropicSecret.value.trim();

  if (!secret) {
    setAnthropicCredentialStatus("Anthropic legacy fallback secret is required.", "error");
    return;
  }

  els.credentialAnthropicSubmit.disabled = true;
  setAnthropicCredentialStatus("Saving Anthropic legacy fallback", "pending");

  try {
    const requestBody = { provider: "anthropic", secret };
    if (name) {
      requestBody.name = name;
    }

    const payload = await fetchJson("/credentials", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    state.selectedCredentialId = payload?.credential?.id || state.selectedCredentialId;
    resetAnthropicCredentialForm();
    setAnthropicCredentialStatus("Anthropic legacy fallback saved to the platform pool.", "success");
    await refreshCredentialOperations();
    await refreshSelectedUserAiAccessOptions();
  } catch (error) {
    setAnthropicCredentialStatus(
      `Unable to save Anthropic legacy fallback: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.credentialAnthropicSubmit.disabled = false;
  }
}

async function connectOpenAiCredential() {
  els.credentialOpenAiConnect.disabled = true;
  setOpenAiCredentialStatus("Starting OpenAI OAuth", "pending");

  try {
    const payload = await fetchJson("/credentials/openai/oauth/start", {
      method: "POST",
    });
    const authorizeUrl = typeof payload?.authorizeUrl === "string" ? payload.authorizeUrl : "";
    const stateValue = typeof payload?.state === "string" ? payload.state : "";
    if (!authorizeUrl || !stateValue) {
      throw new Error("openai_oauth_start_invalid_response");
    }

    writePendingOpenAiOAuth({ state: stateValue });
    window.location.assign(authorizeUrl);
  } catch (error) {
    setOpenAiCredentialStatus(
      `Unable to start OpenAI OAuth: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
    els.credentialOpenAiConnect.disabled = false;
  }
}

async function completeOpenAiOAuth() {
  const callback = readOpenAiOAuthCallbackParams();
  if (!callback) {
    return;
  }

  const pending = readPendingOpenAiOAuth(callback.state);
  clearAuthCallbackParams();
  if (!pending) {
    setOpenAiCredentialStatus("Missing local OpenAI OAuth proof. Start the connection again.", "error");
    setActivePage("credentials");
    showApp();
    return;
  }

  setOpenAiCredentialStatus("Completing OpenAI OAuth", "pending");

  try {
    const payload = await fetchJson("/credentials/openai/oauth/exchange", {
      method: "POST",
      body: JSON.stringify({
        code: callback.code,
        state: callback.state,
      }),
    });
    state.selectedCredentialId = payload?.credential?.id || state.selectedCredentialId;
    setActivePage("credentials");
    showApp();
    setOpenAiCredentialStatus("OpenAI connected to the platform pool.", "success");
    await refreshCredentialOperations();
    await refreshSelectedUserAiAccessOptions();
  } catch (error) {
    setActivePage("credentials");
    showApp();
    setOpenAiCredentialStatus(
      `Unable to finish OpenAI OAuth: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    clearPendingOpenAiOAuth(callback.state);
    els.credentialOpenAiConnect.disabled = false;
  }
}

async function refreshAlertOperations() {
  await Promise.all([
    loadCredentials(),
    loadAlerts(),
    loadAudit(),
  ]);
  renderOverview();
}

function openAlertsForSelectedCredential() {
  const credential = currentCredential();
  if (credential) {
    const matchingAlert = state.alerts.find((entry) =>
      entry.credentialId === credential.id ||
      credential.linkedAlertIds.includes(entry.id),
    );
    if (matchingAlert) {
      state.selectedAlertId = matchingAlert.id;
    }
  }

  setActivePage("alerts");
  showApp();
  renderAlerts();
}

async function runCredentialAction(action) {
  const credential = currentCredential();
  if (!credential || !action) {
    return;
  }

  const confirmationMessages = {
    drain: `Drain ${credential.name}? New sessions will stop using this credential.`,
    rotate: `Rotate ${credential.name}? Active sessions will move to another healthy credential if one is available.`,
    revoke: `Revoke ${credential.name}? Existing sessions may lose access if no replacement is available.`,
  };

  const confirmed = window.confirm(confirmationMessages[action] || `Apply ${action} to ${credential.name}?`);
  if (!confirmed) {
    return;
  }

  try {
    await fetchJson(`/credentials/${encodeURIComponent(credential.id)}/${action}`, {
      method: "POST",
    });
    await refreshCredentialOperations();
  } catch (error) {
    window.alert(`Unable to ${action} credential: ${error instanceof Error ? error.message : "unknown_error"}`);
  }
}

async function renameSelectedCredential() {
  const credential = currentCredential();
  const input = els.credentialDetail.querySelector("[data-credential-rename-input]");
  const status = els.credentialDetail.querySelector("[data-credential-rename-status]");
  const name = input?.value?.trim() || "";
  if (!credential || !input) {
    return;
  }
  if (!name) {
    setInlineStatus(status, "Name is required.", "error");
    return;
  }

  input.disabled = true;
  setInlineStatus(status, "Saving name", "pending");
  try {
    const payload = await fetchJson(`/credentials/${encodeURIComponent(credential.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    state.selectedCredentialId = payload?.credential?.id || credential.id;
    setInlineStatus(status, "Name saved.", "success");
    await refreshCredentialOperations();
    await refreshSelectedUserAiAccessOptions();
  } catch (error) {
    setInlineStatus(status, `Unable to save name: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  } finally {
    input.disabled = false;
  }
}

async function prepareCodexAuthUpload() {
  const credential = currentCredential();
  const status = els.credentialDetail.querySelector("[data-codex-auth-upload-status]");
  if (!credential || credential.provider !== "codex_oauth") {
    return;
  }

  setInlineStatus(status, "Preparing command", "pending");
  try {
    const payload = await fetchJson(`/credentials/${encodeURIComponent(credential.id)}/codex-auth-upload-session`, {
      method: "POST",
    });
    state.codexAuthUploadByCredentialId[credential.id] = payload;
    renderCredentials();
  } catch (error) {
    setInlineStatus(status, `Unable to prepare command: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  }
}

async function copyCodexAuthUploadCommand() {
  const credential = currentCredential();
  if (!credential) {
    return;
  }
  const command = state.codexAuthUploadByCredentialId[credential.id]?.command || "";
  const status = els.credentialDetail.querySelector("[data-codex-auth-upload-status]");
  if (!command) {
    setInlineStatus(status, "Command is not ready.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(command);
    setInlineStatus(status, "Command copied.", "success");
  } catch (error) {
    const output = els.credentialDetail.querySelector("[data-codex-auth-upload-command]");
    output?.focus();
    output?.select();
    setInlineStatus(status, "Copy failed. Select the command manually.", "error");
  }
}

async function runAlertAction(action) {
  const alert = currentAlert();
  if (!alert || !action) {
    return;
  }

  try {
    await fetchJson(`/alerts/${encodeURIComponent(alert.id)}/${action}`, {
      method: "POST",
    });
    await refreshAlertOperations();
  } catch (error) {
    window.alert(`Unable to ${action} alert: ${error instanceof Error ? error.message : "unknown_error"}`);
  }
}

async function saveUser() {
  const payload = {
    email: els.userEmail.value.trim(),
    name: els.userName.value.trim(),
    platformAdmin: els.userPlatformAdmin.checked,
    orgId: els.userOrg.value || null,
    orgRole: els.userRole.value === "owner" ? "owner" : "member",
  };
  const aiAccessInput = {
    ...readAiAccessFormValue(),
    credentialId: readAiAccessCredentialValue(),
  };
  const wasCreating = state.userMode === "create";

  try {
    els.userSaveButton.disabled = true;
    setUserSaveStatus(wasCreating ? "Creating user..." : "Saving user...", "pending");
    if (wasCreating) {
      const existingUser = findUserByEmail(payload.email);
      if (existingUser) {
        state.userMode = "edit";
        state.selectedUserId = existingUser.id;
        renderUsers();
        await loadUserAiAccess(existingUser.id);
        populateUserEditor(existingUser);
        setUserSaveStatus("That email already exists. Showing the existing user record instead.", "error");
        return;
      }
    }
    if (wasCreating) {
      const created = await fetchJson("/users", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      state.userMode = "edit";
      state.selectedUserId = created?.user?.id || null;
    } else {
      const user = currentUser();
      if (!user) {
        return;
      }
      await fetchJson(`/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: payload.name,
          platformAdmin: payload.platformAdmin,
        }),
      });
    }

    await loadUsers();
    const selectedUser = currentUser();
    if (selectedUser?.id) {
      await saveUserAiAccess(selectedUser.id, aiAccessInput);
      await loadUserAiAccess(selectedUser.id);
      populateUserEditor(selectedUser);
    }
    await loadAudit();
    setUserSaveStatus(
      wasCreating
        ? "User created. Review AI access separately if needed."
        : "User changes saved.",
      "success",
    );
  } catch (error) {
    setUserSaveStatus(
      `Unable to save user: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.userSaveButton.disabled = false;
  }
}

async function toggleUserDisabled() {
  const user = currentUser();
  if (!user) {
    return;
  }

  try {
    const action = user.disabled ? "enable" : "disable";
    await fetchJson(`/users/${encodeURIComponent(user.id)}/${action}`, {
      method: "POST",
    });
    await loadUsers();
    await loadAudit();
  } catch (error) {
    window.alert(`Unable to update user: ${error instanceof Error ? error.message : "unknown_error"}`);
  }
}

async function deleteUser() {
  const user = currentUser();
  if (!user) {
    return;
  }

  const confirmed = window.confirm(`Delete ${user.email}? This cannot be undone.`);
  if (!confirmed) {
    return;
  }

  try {
    await fetchJson(`/users/${encodeURIComponent(user.id)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "request_failed") {
      window.alert(`Unable to delete user: ${error instanceof Error ? error.message : "unknown_error"}`);
      return;
    }
  }

  state.selectedUserId = null;
  state.userMode = "edit";
  await loadUsers();
  await loadAudit();
}

function bindNavigation() {
  els.navItems.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const page = item.dataset.route || "overview";
      setActivePage(page);
      if (state.token) {
        showApp();
      } else {
        showLogin();
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function bindActions() {
  els.adminLoginSubmit.addEventListener("click", () => {
    void signInWithPassword();
  });
  [els.adminLoginEmail, els.adminLoginPassword].forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void signInWithPassword();
      }
    });
  });
  els.browserSignInButton.addEventListener("click", () => {
    void startBrowserAuth();
  });
  els.signOutButton.addEventListener("click", signOut);
  els.refreshButton.addEventListener("click", () => void bootstrapSession());
  els.createUserButton.addEventListener("click", enterCreateMode);
  els.createUserButtonInline.addEventListener("click", enterCreateMode);
  els.credentialOpenAiConnect.addEventListener("click", () => void connectOpenAiCredential());
  els.credentialCodexSubmit.addEventListener("click", () => void createCodexCredential());
  els.credentialOpenAiCompatibleSubmit.addEventListener("click", () => void createOpenAiCompatibleCredential());
  els.credentialAnthropicSubmit.addEventListener("click", () => void createAnthropicCredential());
  els.userSaveButton.addEventListener("click", () => void saveUser());
  els.userDisableButton.addEventListener("click", () => void toggleUserDisabled());
  els.userDeleteButton.addEventListener("click", () => void deleteUser());

  els.credentialsTableBody.addEventListener("click", (event) => {
    const row = event.target.closest("[data-credential-id]");
    if (!row) return;
    state.selectedCredentialId = row.dataset.credentialId;
    renderCredentials();
  });

  els.credentialDetail.addEventListener("click", (event) => {
    const renameButton = event.target.closest("[data-credential-rename]");
    if (renameButton) {
      void renameSelectedCredential();
      return;
    }

    const codexUploadButton = event.target.closest("[data-credential-codex-upload]");
    if (codexUploadButton) {
      void prepareCodexAuthUpload();
      return;
    }

    const codexUploadCopyButton = event.target.closest("[data-codex-auth-upload-copy]");
    if (codexUploadCopyButton) {
      void copyCodexAuthUploadCommand();
      return;
    }

    const actionButton = event.target.closest("[data-credential-action]");
    if (actionButton) {
      void runCredentialAction(actionButton.dataset.credentialAction);
      return;
    }

    const routeAlerts = event.target.closest("[data-route-alerts]");
    if (routeAlerts) {
      openAlertsForSelectedCredential();
    }
  });

  els.sessionList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-session-id]");
    if (!row) return;
    state.selectedSessionId = row.dataset.sessionId;
    renderSessions();
  });

  els.alertList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-alert-id]");
    if (!card) return;
    state.selectedAlertId = card.dataset.alertId;
    renderAlerts();
  });

  els.alertDetail.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-alert-action]");
    if (actionButton) {
      void runAlertAction(actionButton.dataset.alertAction);
      return;
    }

    const routeAudit = event.target.closest("[data-route-audit]");
    if (routeAudit) {
      setActivePage("audit");
      showApp();
      renderAudit();
    }
  });

  els.userList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-user-id]");
    if (!card) return;
    state.userMode = "edit";
    state.selectedUserId = card.dataset.userId;
    renderUsers();
    if (state.selectedUserId) {
      void loadUserAiAccess(state.selectedUserId)
        .then(() => {
          const user = currentUser();
          if (user) {
            populateUserEditor(user);
          }
        })
        .catch(() => {
          els.userAiAccessStatus.textContent = "Unable to load AI access assignment.";
        });
    }
  });

  els.auditList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-audit-id]");
    if (!card) return;
    state.selectedAuditId = card.dataset.auditId;
    renderAudit();
  });

  els.userSearch.addEventListener("input", renderUsers);
  els.userStatusFilter.addEventListener("change", renderUsers);
  els.userRoleFilter.addEventListener("change", renderUsers);
  els.userAiAccessProvider.addEventListener("change", () => {
    const user = currentUser();
    const aiAccess = user?.id ? currentUserAiAccess(user.id) : normalizeAiAccess(null);
    renderAiAccessCredentialOptions(user, aiAccess);
    updateAiAccessStatusText(user, aiAccess);
  });
  els.auditSearch.addEventListener("input", renderAudit);
  els.auditActorFilter.addEventListener("change", renderAudit);
  els.auditEntityFilter.addEventListener("change", renderAudit);
  els.auditDateRange.addEventListener("change", renderAudit);
  els.billingViewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextView = button.dataset.billingView || "organization";
      if (nextView === "platform" && state.session?.platformAdmin !== true) {
        return;
      }
      state.billingView = nextView;
      setActivePage("billing");
      renderBilling();
    });
  });
  els.billingOrganizationList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-billing-org-id]");
    if (!card) return;
    state.selectedBillingOrgId = card.dataset.billingOrgId;
    renderBilling();
    void loadBillingForOrg(state.selectedBillingOrgId).then(renderBilling).catch((error) => {
      setBillingActionStatus(`Unable to load billing: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
    });
  });
  els.billingOrgSearch.addEventListener("input", renderBilling);
  els.billingStatusFilter.addEventListener("change", renderBilling);
  els.billingIntervalButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.billingInterval = button.dataset.billingInterval || "monthly";
      renderBilling();
    });
  });
  els.billingUpdateButton?.addEventListener("click", () => {
    void submitBillingUpdate();
  });
  els.billingPortalButton?.addEventListener("click", () => {
    void openBillingPortal();
  });
  els.billingRefreshButton?.addEventListener("click", () => {
    void refreshSelectedBilling();
  });
  els.billingTrialEndDate?.addEventListener("input", renderBilling);
  els.billingCreateTrialButton?.addEventListener("click", () => {
    void createBillingTrial();
  });
  els.billingRevokeTrialButton?.addEventListener("click", () => {
    void revokeBillingTrial();
  });
  els.usageGroupBy.addEventListener("change", () => {
    state.usageFilters.groupBy = els.usageGroupBy.value;
    void loadUsage();
  });
  els.usageCredentialFilter.addEventListener("change", () => {
    state.usageFilters.credentialId = els.usageCredentialFilter.value;
    void loadUsage();
  });
  els.usageUserFilter.addEventListener("change", () => {
    state.usageFilters.userId = els.usageUserFilter.value;
    void loadUsage();
  });
  els.usageOrgFilter.addEventListener("change", () => {
    state.usageFilters.orgId = els.usageOrgFilter.value;
    void loadUsage();
  });
}

function handleRoute() {
  const page = normalizePage(location.pathname);
  setActivePage(page);
  if (!state.token) {
    showLogin();
  }
}

bindNavigation();
bindActions();
handleRoute();
void initializeAuth();
