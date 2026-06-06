const STORAGE_KEY = "veslo.ai-gateway.admin.token";
const BROWSER_AUTH_STORAGE_KEY = "veslo.ai-gateway.admin.browser-auth";
const DEFAULT_PAGES = ["organization", "credentials", "sessions", "usage", "alerts", "users", "audit"];
const AUTH_STATE_BYTES = 32;
const AUTH_CODE_VERIFIER_BYTES = 32;
const CODEX_EXHAUSTED_REASON = "all_codex_credentials_exhausted";

const state = {
  token: localStorage.getItem(STORAGE_KEY) || "",
  page: normalizePage(location.pathname),
  authBusy: false,
  session: null,
  user: null,
  credentials: [],
  sessions: [],
  alerts: [],
  audit: [],
  users: [],
  organizations: [],
  organizationDomains: [],
  organizationInvites: [],
  usage: null,
  usageFilters: {
    groupBy: "total",
    credentialId: "",
    userId: "",
    orgId: "",
  },
  showDeletedCredentials: false,
  selectedCredentialId: null,
  selectedSessionId: null,
  selectedAlertId: null,
  selectedAuditId: null,
  selectedUserId: null,
  selectedOrganizationId: null,
  userMode: "edit",
  userAiAccessByUserId: {},
  userAiAccessAvailableCredentialsByUserId: {},
  userAiAccessModelsByCredentialId: {},
};

const els = {
  loginPanel: document.getElementById("login-panel"),
  browserSignInButton: document.getElementById("browser-sign-in-button"),
  loginError: document.getElementById("login-error"),
  appPanel: document.getElementById("app-panel"),
  authState: document.getElementById("auth-state"),
  authUser: document.getElementById("auth-user"),
  signOutButton: document.getElementById("sign-out-button"),
  refreshButton: document.getElementById("refresh-button"),
  createUserButton: document.getElementById("create-user-button"),
  createUserButtonInline: document.querySelector('[data-platform-only][id="create-user-button-inline"]'),
  pageTitle: document.getElementById("page-title"),
  pageDescription: document.getElementById("page-description"),
  pageEyebrow: document.getElementById("page-eyebrow"),
  navItems: Array.from(document.querySelectorAll("[data-route]")),
  pages: Array.from(document.querySelectorAll("[data-page]")),
  platformAdminControls: Array.from(document.querySelectorAll("[data-platform-admin-control]")),
  aiAccessControls: Array.from(document.querySelectorAll("[data-ai-access-control]")),
  seatLimitControls: Array.from(document.querySelectorAll("[data-seat-limit-control]")),
  organizationEditorTitle: document.getElementById("organization-editor-title"),
  organizationName: document.getElementById("organization-name"),
  organizationSlug: document.getElementById("organization-slug"),
  organizationSeatLimit: document.getElementById("organization-seat-limit"),
  organizationSaveButton: document.getElementById("organization-save-button"),
  organizationSaveStatus: document.getElementById("organization-save-status"),
  organizationDomainInput: document.getElementById("organization-domain-input"),
  organizationDomainEnabled: document.getElementById("organization-domain-enabled"),
  organizationDomainSelfSignup: document.getElementById("organization-domain-self-signup"),
  organizationDomainAddButton: document.getElementById("organization-domain-add-button"),
  organizationDomainList: document.getElementById("organization-domain-list"),
  organizationInviteEmail: document.getElementById("organization-invite-email"),
  organizationInviteRole: document.getElementById("organization-invite-role"),
  organizationInviteSendButton: document.getElementById("organization-invite-send-button"),
  organizationInviteList: document.getElementById("organization-invite-list"),
  credentialCreateProvider: document.getElementById("credential-create-provider"),
  credentialCreateName: document.getElementById("credential-create-name"),
  credentialCreateBaseUrl: document.getElementById("credential-create-base-url"),
  credentialCreateSecret: document.getElementById("credential-create-secret"),
  credentialCreateSubmit: document.getElementById("credential-create-submit"),
  credentialCreateStatus: document.getElementById("credential-create-status"),
  credentialsShowDeleted: document.getElementById("credentials-show-deleted"),
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
  userAiAccessModelOptions: document.getElementById("user-ai-access-model-options"),
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
  heroMetrics: Array.from(document.querySelectorAll(".hero-metrics .metric-card strong")),
};

function normalizePage(pathname) {
  const path = pathname.replace(/\/+$/, "");
  if (!path || path === "/admin") return "overview";
  const page = path.split("/").pop();
  return DEFAULT_PAGES.includes(page) ? page : "overview";
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

function readAuthCallbackParams() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code")?.trim() || "";
  const sessionId =
    params.get("transactionId")?.trim() ||
    params.get("sessionId")?.trim() ||
    "";
  return code ? { code, sessionId } : null;
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

function allowedPages() {
  if (Array.isArray(state.session?.allowedPages) && state.session.allowedPages.length > 0) {
    return state.session.allowedPages.filter((entry) => DEFAULT_PAGES.includes(entry));
  }
  return state.session?.platformAdmin ? DEFAULT_PAGES : ["organization", "users"];
}

function hasCapability(capability) {
  if (Array.isArray(state.session?.capabilities)) {
    return state.session.capabilities.includes(capability);
  }
  if (state.session?.platformAdmin) {
    return true;
  }
  return capability === "organization" || capability === "users";
}

function firstAllowedPage() {
  return allowedPages()[0] || "organization";
}

function canAccessPage(page) {
  if (page === "overview") {
    return state.session?.platformAdmin === true;
  }
  return allowedPages().includes(page);
}

async function runAllowedLoad(page, loader) {
  if (!canAccessPage(page)) {
    return;
  }
  await loader();
}

function applyAdminCapabilities() {
  const allowed = new Set(allowedPages());
  const canManagePlatform = state.session?.platformAdmin === true;
  const canManageAiAccess = hasCapability("managedAiUserAccess");

  els.navItems.forEach((item) => {
    const route = item.dataset.route || "";
    item.classList.toggle("hidden", !allowed.has(route));
  });
  els.pages.forEach((panel) => {
    const page = panel.dataset.page || "";
    if (page !== "overview" && !allowed.has(page)) {
      panel.classList.add("hidden");
    }
  });
  els.platformAdminControls.forEach((node) => node.classList.toggle("hidden", !canManagePlatform));
  els.aiAccessControls.forEach((node) => node.classList.toggle("hidden", !canManageAiAccess));
  els.seatLimitControls.forEach((node) => node.classList.toggle("hidden", !canManagePlatform));
  if (els.userPlatformAdmin) {
    els.userPlatformAdmin.disabled = !canManagePlatform;
    if (!canManagePlatform) {
      els.userPlatformAdmin.checked = false;
    }
  }
  if (els.organizationSeatLimit) {
    els.organizationSeatLimit.disabled = !canManagePlatform;
  }
  if (els.createUserButtonInline) {
    els.createUserButtonInline.classList.toggle("hidden", !canManagePlatform);
  }
}

function normalizeOrganizationRoleInput(value) {
  return value === "organization_admin" || value === "owner" ? "organization_admin" : "member";
}

function organizationRoleOptionsMarkup() {
  return `<option value="organization_admin">Organization admin</option><option value="member">Member</option>`;
}

function buildUserUpdatePayload(payload) {
  if (state.session?.platformAdmin !== true) {
    return {
      orgId: payload.orgId,
      orgRole: payload.orgRole,
    };
  }

  return {
    name: payload.name,
    platformAdmin: payload.platformAdmin,
    orgId: payload.orgId,
    orgRole: payload.orgRole,
  };
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

function selectedAiAccessCredentialId() {
  return els.userAiAccessCredential.value.trim();
}

function isAiAccessModelCatalogProvider(provider) {
  return provider === "codex_oauth" || provider === "openai_compatible";
}

function setAiAccessModelOptions(models) {
  const normalized = Array.isArray(models)
    ? Array.from(new Set(models.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean)))
    : [];
  els.userAiAccessModelOptions.innerHTML = normalized
    .map((model) => `<option value="${escapeHtml(model)}"></option>`)
    .join("");
}

async function loadAiAccessModelsForCredential(credentialId) {
  if (!credentialId) {
    setAiAccessModelOptions([]);
    return { models: [], defaultModel: "" };
  }

  const cached = state.userAiAccessModelsByCredentialId[credentialId];
  if (cached && Array.isArray(cached.models)) {
    setAiAccessModelOptions(cached.models);
    return cached;
  }

  const payload = await fetchJson(`/credentials/${encodeURIComponent(credentialId)}/models`);
  const models = Array.isArray(payload?.models)
    ? payload.models.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const result = {
    models,
    defaultModel: typeof payload?.defaultModel === "string" ? payload.defaultModel.trim() : "",
  };
  state.userAiAccessModelsByCredentialId[credentialId] = result;
  setAiAccessModelOptions(models);
  return result;
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

function showLogin(message = "") {
  els.loginPanel.classList.remove("hidden");
  els.appPanel.classList.add("hidden");
  els.createUserButton.classList.add("hidden");
  els.loginError.textContent = message;
  els.loginError.classList.toggle("hidden", !message);
  setBrowserAuthBusy(false);
  setStatus("Signed out", "browser sign-in required");
}

function showApp() {
  els.loginPanel.classList.add("hidden");
  els.appPanel.classList.remove("hidden");
  applyAdminCapabilities();
  els.createUserButton.classList.toggle("hidden", state.page !== "users" || state.session?.platformAdmin !== true);
}

function setActivePage(page) {
  if (state.session && !canAccessPage(page)) {
    page = firstAllowedPage();
  }
  state.page = page;
  const nextPath = page === "overview" ? "/admin" : `/admin/${page}`;
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
    overview: ["AI Gateway control plane", "Overview", "Inspect credentials, sessions, usage, alerts, users, and audit events from one place."],
    organization: ["AI Gateway control plane", "Organization", "Manage organization details, domains, and pending invites."],
    credentials: ["AI Gateway control plane", "Credentials", "Inspect provider keys, linked alerts, and rotation state."],
    sessions: ["AI Gateway control plane", "Sessions", "Review sticky leases, rebinding history, and worker ownership."],
    usage: ["AI Gateway control plane", "Usage", "Analyze total token usage first, then break it down by credential, user, or org."],
    alerts: ["AI Gateway control plane", "Alerts", "Triage credential failures, usage spikes, and session anomalies."],
    users: ["AI Gateway control plane", "Users", "Create, edit, disable, or remove users from the directory."],
    audit: ["AI Gateway control plane", "Audit", "Filter by actor, action, or entity and inspect detailed change history."],
  };

  const [eyebrow, title, description] = titles[page] || titles.overview;
  els.pageEyebrow.textContent = eyebrow;
  els.pageTitle.textContent = title;
  els.pageDescription.textContent = description;
  applyAdminCapabilities();
  els.createUserButton.classList.toggle("hidden", page !== "users" || state.session?.platformAdmin !== true);
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
    throw new Error(payload?.error || "request_failed");
  }
  return payload;
}

async function bootstrapSession() {
  setStatus("Checking session", state.token ? "validating stored token" : "validating admin cookie");
  const { response, payload } = await api("/session", { method: "GET" });
  if (!response.ok) {
    state.session = null;
    state.user = null;
    const shouldClearToken = payload?.error === "unauthorized" || payload?.error === "forbidden"
    if (shouldClearToken) {
      state.token = ""
      localStorage.removeItem(STORAGE_KEY)
    }
    if (shouldClearToken && payload?.error === "unauthorized") {
      window.location.assign(`${location.pathname}${location.search}`);
      return;
    }
    showLogin(
      shouldClearToken && payload?.error === "forbidden"
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
  populateOrganizationOptions();
  if (!canAccessPage(state.page)) {
    setActivePage(firstAllowedPage());
  }
  setStatus(
    "Signed in",
    state.user
      ? `${state.user.name || state.user.email} · ${state.session.platformAdmin ? "platform admin" : "organization admin"}`
      : state.session.platformAdmin ? "platform admin" : "organization admin",
  );
  showApp();
  await loadAllData();
}

function populateOrganizationOptions() {
  const organizations = Array.isArray(state.session?.organizations) ? state.session.organizations : [];
  state.organizations = organizations;
  if (!state.selectedOrganizationId || !organizations.some((entry) => entry.id === state.selectedOrganizationId)) {
    state.selectedOrganizationId = state.session?.activeOrgId || organizations[0]?.id || null;
  }
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

    const { response, payload } = await api("/auth/browser/start", {
      method: "POST",
      body: JSON.stringify({
        intent: "signin",
        redirectUri,
        state: stateValue,
        codeChallenge,
      }),
    });

    if (!response.ok) {
      showLogin(payload?.error || payload?.message || "Unable to start browser sign in.");
      return;
    }

    const authorizeUrl = normalizeBrowserAuthorizeUrl(typeof payload?.authorizeUrl === "string" ? payload.authorizeUrl : "");
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
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
  const callback = readAuthCallbackParams();
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
    const { response, payload } = await api("/auth/browser/exchange", {
      method: "POST",
      body: JSON.stringify({
        code: callback.code,
        sessionId: callback.sessionId || pending.sessionId,
        state: pending.state,
        codeVerifier: pending.codeVerifier,
      }),
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
}

async function clearServerAdminSession() {
  await api("/auth/sign-out", { method: "POST" }).catch(() => null);
}

async function signOut() {
  await clearServerAdminSession();
  state.token = "";
  state.session = null;
  state.user = null;
  state.credentials = [];
  state.sessions = [];
  state.alerts = [];
  state.audit = [];
  state.users = [];
  state.organizations = [];
  state.organizationDomains = [];
  state.organizationInvites = [];
  state.usage = null;
  state.selectedCredentialId = null;
  state.selectedSessionId = null;
  state.selectedAlertId = null;
  state.selectedAuditId = null;
  state.selectedUserId = null;
  state.selectedOrganizationId = null;
  state.userMode = "edit";
  localStorage.removeItem(STORAGE_KEY);
  window.location.assign("/admin");
}

async function loadAllData() {
  await Promise.all([
    runAllowedLoad("organization", loadOrganization),
    runAllowedLoad("credentials", loadCredentials),
    runAllowedLoad("sessions", loadSessions),
    runAllowedLoad("alerts", loadAlerts),
    runAllowedLoad("users", loadUsers),
    runAllowedLoad("audit", loadAudit),
    runAllowedLoad("usage", loadUsage),
  ]);
  renderOverview();
}

function currentOrganizationId() {
  return state.selectedOrganizationId || state.session?.activeOrgId || state.organizations[0]?.id || null;
}

function currentOrganization() {
  const orgId = currentOrganizationId();
  return state.organizations.find((entry) => entry.id === orgId) || state.session?.organizations?.find((entry) => entry.id === orgId) || null;
}

async function loadOrganization() {
  try {
    const payload = await fetchJson("/organizations");
    state.organizations = Array.isArray(payload?.organizations) ? payload.organizations : [];
    if (!state.selectedOrganizationId || !state.organizations.some((entry) => entry.id === state.selectedOrganizationId)) {
      state.selectedOrganizationId = state.session?.activeOrgId || state.organizations[0]?.id || null;
    }

    const orgId = currentOrganizationId();
    if (orgId) {
      const [domainsPayload, invitesPayload] = await Promise.all([
        fetchJson(`/organizations/${encodeURIComponent(orgId)}/domains`),
        fetchJson(`/organizations/${encodeURIComponent(orgId)}/invites`),
      ]);
      state.organizationDomains = Array.isArray(domainsPayload?.domains) ? domainsPayload.domains : [];
      state.organizationInvites = Array.isArray(invitesPayload?.invites) ? invitesPayload.invites : [];
    } else {
      state.organizationDomains = [];
      state.organizationInvites = [];
    }

    renderOrganization();
  } catch (error) {
    console.error("loadOrganization failed", error);
    setOrganizationSaveStatus(`Unable to load organization: ${error instanceof Error ? error.message : "unknown_error"}`, "error");
  }
}

async function loadCredentials() {
  try {
    const includeDeleted = state.showDeletedCredentials ? "?includeDeleted=true" : "";
    const payload = await fetchJson(`/credentials${includeDeleted}`);
    state.credentials = Array.isArray(payload?.credentials) ? payload.credentials : [];
    if (!state.selectedCredentialId || !state.credentials.some((entry) => entry.id === state.selectedCredentialId)) {
      state.selectedCredentialId = state.credentials[0]?.id || null;
    }
    renderCredentials();
  } catch (error) {
    console.error("loadCredentials failed", error);
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
    console.error("loadSessions failed", error);
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
    console.error("loadAlerts failed", error);
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
    console.error("loadAudit failed", error);
  }
}

async function loadUserAiAccess(userId) {
  if (!hasCapability("managedAiUserAccess")) {
    return null;
  }

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
  if (!hasCapability("managedAiUserAccess")) {
    return;
  }

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
    if (state.userMode !== "create" && state.selectedUserId && hasCapability("managedAiUserAccess")) {
      await loadUserAiAccess(state.selectedUserId);
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
    console.error("loadUsers failed", error);
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
    console.error("loadUsage failed", error);
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

function renderOrganization() {
  const organization = currentOrganization();
  if (!organization) {
    els.organizationEditorTitle.textContent = "No organization";
    els.organizationName.value = "";
    els.organizationSlug.value = "";
    els.organizationSeatLimit.value = "";
    els.organizationDomainList.innerHTML = `<article class="list-card active"><div><strong>No organization</strong><p>No organization is available for this session.</p></div></article>`;
    els.organizationInviteList.innerHTML = `<article class="list-card active"><div><strong>No pending invites</strong><p>Select an organization first.</p></div></article>`;
    return;
  }

  els.organizationEditorTitle.textContent = organization.name || organization.slug || organization.id;
  els.organizationName.value = organization.name || "";
  els.organizationSlug.value = organization.slug || "";
  els.organizationSeatLimit.value = organization.seatLimit === null || organization.seatLimit === undefined
    ? ""
    : String(organization.seatLimit);
  els.organizationSeatLimit.disabled = state.session?.platformAdmin !== true;

  els.organizationDomainList.innerHTML = state.organizationDomains.map((domain) => `
    <article class="list-card active" data-domain-id="${escapeHtml(domain.id)}">
      <div>
        <strong>${escapeHtml(domain.domain)}</strong>
        <p>${domain.enabled ? "Enabled" : "Disabled"} · ${domain.selfSignupEnabled ? "Self signup enabled" : "Self signup disabled"}</p>
        <label class="switch-row">
          <span>Enabled</span>
          <input type="checkbox" data-domain-enabled ${domain.enabled ? "checked" : ""} />
        </label>
        <label class="switch-row">
          <span>Self signup</span>
          <input type="checkbox" data-domain-self-signup ${domain.selfSignupEnabled ? "checked" : ""} />
        </label>
      </div>
      <span class="button-row">
        <button class="button button-secondary" type="button" data-domain-save>Save</button>
        <button class="button button-secondary" type="button" data-domain-delete>Remove</button>
      </span>
    </article>
  `).join("") || `<article class="list-card active"><div><strong>No domains</strong><p>Add a domain to enable organization matching.</p></div></article>`;

  const pendingInvites = state.organizationInvites.filter((invite) => invite.status === "pending");
  els.organizationInviteList.innerHTML = pendingInvites.map((invite) => `
    <article class="list-card active" data-invite-id="${escapeHtml(invite.id)}">
      <div>
        <strong>${escapeHtml(invite.email)}</strong>
        <p>${escapeHtml(normalizeOrganizationRoleInput(invite.role))} · expires ${escapeHtml(formatDate(invite.expiresAt))}</p>
      </div>
      <span class="button-row">
        <button class="button button-secondary" type="button" data-invite-resend>Resend</button>
        <button class="button button-secondary" type="button" data-invite-revoke>Revoke</button>
      </span>
    </article>
  `).join("") || `<article class="list-card active"><div><strong>No pending invites</strong><p>Pending invites will appear here.</p></div></article>`;

  applyAdminCapabilities();
}

function renderCredentials() {
  const rows = state.credentials.map((credential) => {
    const displayState = credential.deletedAt ? "deleted" : credential.state;
    const rowClasses = [
      credential.id === state.selectedCredentialId ? "row-alert" : "",
      credential.deletedAt ? "row-muted" : "",
    ].filter(Boolean).join(" ");
    return `<tr class="${escapeHtml(rowClasses)}" data-credential-id="${escapeHtml(credential.id)}">
      <td><strong>${escapeHtml(credential.name)}</strong><span>${escapeHtml(credential.scope)}</span></td>
      <td>${escapeHtml(credential.type)}</td>
      <td><span class="status-chip ${escapeHtml(credentialStateTone(displayState))}">${escapeHtml(displayState)}</span></td>
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
    const displayState = selected.deletedAt ? "deleted" : selected.state;
    els.credentialDetail.innerHTML = `
      <p class="eyebrow">Selected credential</p>
      <h3>${escapeHtml(selected.name)}</h3>
      <div class="stack">
        <div class="detail-line"><span>Health</span><strong>${escapeHtml(displayState)}</strong></div>
        ${selected.deletedAt ? `<div class="detail-line"><span>Deleted</span><strong>${escapeHtml(formatDate(selected.deletedAt))}</strong></div>` : ""}
        <div class="detail-line"><span>Linked alerts</span><strong>${escapeHtml(String(selected.alertCount))}</strong></div>
        <div class="detail-line"><span>Last failure</span><strong>${escapeHtml(formatDate(selected.lastFailureAt))}</strong></div>
        <div class="detail-line"><span>Rotation</span><strong>${escapeHtml(formatDate(selected.nextRotationAt))}</strong></div>
        <div class="detail-line"><span>Cached tokens</span><strong>${escapeHtml(formatNumber(selected.cachedTokens))}</strong></div>
        <div class="detail-line"><span>Total tokens</span><strong>${escapeHtml(formatNumber(selected.totalTokens))}</strong></div>
        ${selected.provider === "codex_oauth" ? `
          <div class="detail-line"><span>Eligibility</span><strong>${escapeHtml(selected.eligibility?.state || "unknown")}</strong></div>
          <div class="detail-line"><span>Codex upstream</span><strong>${escapeHtml(selectedUpstreamStatus.label)}</strong></div>
          <div class="detail-line"><span>Codex limits</span><strong>${escapeHtml(selectedUpstreamStatus.limitSummary || "5h: unknown | Weekly: unknown")}</strong></div>
        ` : ""}
      </div>
      <div class="button-row">
        ${renderCredentialActionButtons(selected)}
      </div>
    `;
  }
}

function renderCredentialActionButtons(credential) {
  if (credential.deletedAt) {
    return `<button class="button button-primary" type="button" data-route-alerts>Open alerts</button>`;
  }

  return `
    <button class="button button-secondary" type="button" data-credential-action="drain">Drain</button>
    <button class="button button-secondary" type="button" data-credential-action="rotate">Rotate</button>
    <button class="button button-secondary" type="button" data-credential-action="revoke">Revoke</button>
    <button class="button button-secondary button-danger" type="button" data-credential-action="delete">Delete</button>
    <button class="button button-primary" type="button" data-route-alerts>Open alerts</button>
  `;
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

function credentialStateTone(state) {
  if (state === "healthy") return "success";
  if (state === "degraded" || state === "draining") return "warning";
  if (state === "unhealthy" || state === "revoked") return "danger";
  if (state === "deleted") return "info";
  return "";
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
  const selectedProvider = els.userAiAccessProvider.value || aiAccess.provider || "";
  const availableCredentials = user?.id ? currentUserAiAccessAvailableCredentials(user.id, selectedProvider) : [];
  const emptyLabel =
    selectedProvider === "codex_oauth" && availableCredentials.length === 0
      ? "No eligible Codex credential"
      : selectedProvider === "openai_compatible" && availableCredentials.length === 0
        ? "No OpenAI-compatible credential"
      : "Select assigned credential";
  const options = [
    `<option value="">${escapeHtml(emptyLabel)}</option>`,
    ...availableCredentials.map(
      (credential) =>
        `<option value="${escapeHtml(credential.id)}">${escapeHtml(credential.name)}</option>`,
    ),
  ];

  els.userAiAccessCredential.innerHTML = options.join("");
  const selectedCredentialId =
    (aiAccess.provider === "codex_oauth" || aiAccess.provider === "openai_compatible") &&
    availableCredentials.some((entry) => entry.id === aiAccess.credentialId)
      ? aiAccess.credentialId
      : "";
  els.userAiAccessCredential.value = selectedCredentialId || "";
  els.userAiAccessCredential.disabled =
    state.userMode === "create" ||
    !user ||
    (els.userAiAccessProvider.value !== "codex_oauth" && els.userAiAccessProvider.value !== "openai_compatible") ||
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
    els.userAiAccessStatus.textContent = "No healthy Codex credentials with OK upstream status are available for assignment.";
    return;
  }
  if (selectedProvider === "openai_compatible" && availableCredentials.length === 0) {
    els.userAiAccessStatus.textContent = "Create a healthy OpenAI-compatible credential first, then assign it here.";
    return;
  }

  els.userAiAccessStatus.textContent = aiAccess.updatedAt
    ? `Assignments updated ${formatDate(aiAccess.updatedAt)}.`
    : "Assignments are enforced by the gateway for this signed-in user.";
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
  els.userOrg.disabled = false;
  els.userRole.disabled = false;
  els.userPlatformAdmin.checked = user?.platformAdmin === true;
  if (state.session?.platformAdmin !== true) {
    els.userPlatformAdmin.checked = false;
    els.userPlatformAdmin.disabled = true;
  }
  els.userSendInvite.checked = true;
  els.userSendInvite.disabled = !isCreate;
  if (membership?.orgId) {
    els.userOrg.value = membership.orgId;
    els.userRole.value = normalizeOrganizationRoleInput(membership.role);
  } else if (els.userOrg.options.length > 0) {
    els.userOrg.selectedIndex = 0;
    els.userRole.value = "member";
  }
  els.userDisableButton.textContent = user?.disabled ? "Enable user" : "Disable user";
  els.userDisableButton.disabled = isCreate || !user || state.session?.platformAdmin !== true;
  els.userDeleteButton.disabled = isCreate || !user || state.session?.platformAdmin !== true;
  if (hasCapability("managedAiUserAccess")) {
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
  if (hasCapability("managedAiUserAccess") && !isCreate && isAiAccessModelCatalogProvider(aiAccess.provider) && aiAccess.credentialId) {
    void refreshSelectedAiAccessModels();
  } else {
    setAiAccessModelOptions([]);
  }
  applyAdminCapabilities();
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
  if (state.session?.platformAdmin !== true) {
    return;
  }

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
  if (!hasCapability("managedAiUserAccess") || state.userMode === "create" || !state.selectedUserId) {
    return;
  }

  await loadUserAiAccess(state.selectedUserId);
  const user = currentUser();
  if (user) {
    populateUserEditor(user);
  }
}

async function refreshSelectedAiAccessModels() {
  if (!hasCapability("managedAiUserAccess")) {
    return;
  }

  const selectedProvider = els.userAiAccessProvider.value || "";
  const credentialId = selectedAiAccessCredentialId();
  if ((selectedProvider !== "codex_oauth" && selectedProvider !== "openai_compatible") || !credentialId) {
    setAiAccessModelOptions([]);
    return;
  }

  els.userAiAccessStatus.textContent = "Loading models from the assigned credential...";
  try {
    const payload = await loadAiAccessModelsForCredential(credentialId);
    if (!els.userAiAccessDefaultModel.value.trim() && payload.defaultModel) {
      els.userAiAccessDefaultModel.value = payload.defaultModel;
      if (!els.userAiAccessAllowedModels.value.trim()) {
        els.userAiAccessAllowedModels.value = payload.defaultModel;
      }
    }
    els.userAiAccessStatus.textContent = payload.models.length > 0
      ? `Loaded ${payload.models.length} models from the assigned credential.`
      : "No models were returned by this credential. Enter a model manually.";
  } catch (error) {
    setAiAccessModelOptions([]);
    els.userAiAccessStatus.textContent =
      `Unable to load models: ${error instanceof Error ? error.message : "unknown_error"}. Enter a model manually.`;
  }
}

function setCredentialCreateStatus(message, tone = "neutral") {
  els.credentialCreateStatus.textContent = message;
  if (tone === "neutral") {
    delete els.credentialCreateStatus.dataset.tone;
    return;
  }
  els.credentialCreateStatus.dataset.tone = tone;
}

function setUserSaveStatus(message, tone = "neutral") {
  els.userSaveStatus.textContent = message;
  if (tone === "neutral") {
    delete els.userSaveStatus.dataset.tone;
    return;
  }
  els.userSaveStatus.dataset.tone = tone;
}

function setOrganizationSaveStatus(message, tone = "neutral") {
  els.organizationSaveStatus.textContent = message;
  if (tone === "neutral") {
    delete els.organizationSaveStatus.dataset.tone;
    return;
  }
  els.organizationSaveStatus.dataset.tone = tone;
}

function resetCredentialCreateForm() {
  els.credentialCreateName.value = "";
  els.credentialCreateBaseUrl.value = "";
  els.credentialCreateSecret.value = "";
  updateCredentialCreateFields();
}

function updateCredentialCreateFields() {
  const provider = els.credentialCreateProvider.value.trim();
  const isOpenAiCompatible = provider === "openai_compatible";
  els.credentialCreateBaseUrl.disabled = !isOpenAiCompatible;
  els.credentialCreateSecret.placeholder = isOpenAiCompatible
    ? "Paste the provider API key."
    : "Paste the provider API key or the full Codex auth.json.";
}

async function createCredential() {
  const provider = els.credentialCreateProvider.value.trim();
  const name = els.credentialCreateName.value.trim();
  const baseUrl = els.credentialCreateBaseUrl.value.trim();
  const secret = els.credentialCreateSecret.value.trim();

  if (!provider || !secret) {
    setCredentialCreateStatus("Provider and secret are required.", "error");
    return;
  }
  if (provider === "openai_compatible" && !baseUrl) {
    setCredentialCreateStatus("OpenAI-compatible base URL and API key are required.", "error");
    return;
  }

  els.credentialCreateSubmit.disabled = true;
  setCredentialCreateStatus("Creating credential", "pending");

  try {
    const requestBody = { provider, secret };
    if (name) {
      requestBody.name = name;
    }
    if (provider === "openai_compatible") {
      requestBody.baseUrl = baseUrl;
    }

    const payload = await fetchJson("/credentials", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    state.selectedCredentialId = payload?.credential?.id || state.selectedCredentialId;
    resetCredentialCreateForm();
    setCredentialCreateStatus("Credential created and attached to the platform pool.", "success");
    await refreshCredentialOperations();
    await refreshSelectedUserAiAccessOptions();
  } catch (error) {
    setCredentialCreateStatus(
      `Unable to create credential: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.credentialCreateSubmit.disabled = false;
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

function credentialActionRequest(credentialId, action) {
  const encodedCredentialId = encodeURIComponent(credentialId);
  return {
    path: action === "delete"
      ? `/credentials/${encodedCredentialId}`
      : `/credentials/${encodedCredentialId}/${action}`,
    method: action === "delete" ? "DELETE" : "POST",
  };
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
    delete: `Delete ${credential.name}? This moves it to Show Deleted and prevents future assignment or use.`,
  };

  const confirmed = window.confirm(confirmationMessages[action] || `Apply ${action} to ${credential.name}?`);
  if (!confirmed) {
    return;
  }

  try {
    const request = credentialActionRequest(credential.id, action);
    await fetchJson(request.path, {
      method: request.method,
    });
    if (action === "delete") {
      state.showDeletedCredentials = true;
      els.credentialsShowDeleted.checked = true;
    }
    await refreshCredentialOperations();
    if (action === "delete") {
      await refreshSelectedUserAiAccessOptions();
    }
  } catch (error) {
    window.alert(`Unable to ${action} credential: ${error instanceof Error ? error.message : "unknown_error"}`);
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

async function saveOrganization() {
  const orgId = currentOrganizationId();
  if (!orgId) {
    return;
  }

  const payload = {
    name: els.organizationName.value.trim(),
    slug: els.organizationSlug.value.trim(),
  };
  if (state.session?.platformAdmin === true) {
    payload.seatLimit = els.organizationSeatLimit.value.trim() ? Number(els.organizationSeatLimit.value) : null;
  }

  try {
    els.organizationSaveButton.disabled = true;
    setOrganizationSaveStatus("Saving organization...", "pending");
    const saved = await fetchJson(`/organizations/${encodeURIComponent(orgId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    const organization = saved?.organization;
    if (organization?.id) {
      const index = state.organizations.findIndex((entry) => entry.id === organization.id);
      if (index >= 0) {
        state.organizations[index] = organization;
      } else {
        state.organizations.push(organization);
      }
    }
    renderOrganization();
    setOrganizationSaveStatus("Organization saved.", "success");
  } catch (error) {
    setOrganizationSaveStatus(
      `Unable to save organization: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.organizationSaveButton.disabled = false;
  }
}

async function createOrganizationDomain() {
  const orgId = currentOrganizationId();
  if (!orgId) {
    return;
  }

  try {
    els.organizationDomainAddButton.disabled = true;
    setOrganizationSaveStatus("Adding domain...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/domains`, {
      method: "POST",
      body: JSON.stringify({
        domain: els.organizationDomainInput.value.trim(),
        enabled: els.organizationDomainEnabled.checked,
        selfSignupEnabled: els.organizationDomainSelfSignup.checked,
      }),
    });
    els.organizationDomainInput.value = "";
    await loadOrganization();
    setOrganizationSaveStatus("Domain added.", "success");
  } catch (error) {
    setOrganizationSaveStatus(
      `Unable to add domain: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.organizationDomainAddButton.disabled = false;
  }
}

async function saveOrganizationDomain(card) {
  const orgId = currentOrganizationId();
  const domainId = card?.dataset?.domainId;
  if (!orgId || !domainId) {
    return;
  }

  try {
    setOrganizationSaveStatus("Saving domain...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        enabled: card.querySelector("[data-domain-enabled]")?.checked === true,
        selfSignupEnabled: card.querySelector("[data-domain-self-signup]")?.checked === true,
      }),
    });
    await loadOrganization();
    setOrganizationSaveStatus("Domain saved.", "success");
  } catch (error) {
    setOrganizationSaveStatus(
      `Unable to save domain: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function deleteOrganizationDomain(card) {
  const orgId = currentOrganizationId();
  const domainId = card?.dataset?.domainId;
  if (!orgId || !domainId) {
    return;
  }

  try {
    setOrganizationSaveStatus("Removing domain...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`, {
      method: "DELETE",
    });
    await loadOrganization();
    setOrganizationSaveStatus("Domain removed.", "success");
  } catch (error) {
    setOrganizationSaveStatus(
      `Unable to remove domain: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function createOrganizationInvite() {
  const orgId = currentOrganizationId();
  if (!orgId) {
    return;
  }

  try {
    els.organizationInviteSendButton.disabled = true;
    setOrganizationSaveStatus("Sending invite...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/invites`, {
      method: "POST",
      body: JSON.stringify({
        email: els.organizationInviteEmail.value.trim(),
        role: normalizeOrganizationRoleInput(els.organizationInviteRole.value),
      }),
    });
    els.organizationInviteEmail.value = "";
    await loadOrganization();
    setOrganizationSaveStatus("Invite sent.", "success");
  } catch (error) {
    setOrganizationSaveStatus(
      `Unable to send invite: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.organizationInviteSendButton.disabled = false;
  }
}

async function resendOrganizationInvite(card) {
  const orgId = currentOrganizationId();
  const inviteId = card?.dataset?.inviteId;
  if (!orgId || !inviteId) {
    return;
  }

  try {
    setOrganizationSaveStatus("Resending invite...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/resend`, {
      method: "POST",
    });
    await loadOrganization();
    setOrganizationSaveStatus("Invite resent.", "success");
  } catch (error) {
    setOrganizationSaveStatus(
      `Unable to resend invite: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function revokeOrganizationInvite(card) {
  const orgId = currentOrganizationId();
  const inviteId = card?.dataset?.inviteId;
  if (!orgId || !inviteId) {
    return;
  }

  try {
    setOrganizationSaveStatus("Revoking invite...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/revoke`, {
      method: "POST",
    });
    await loadOrganization();
    setOrganizationSaveStatus("Invite revoked.", "success");
  } catch (error) {
    setOrganizationSaveStatus(
      `Unable to revoke invite: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function saveUser() {
  const payload = {
    email: els.userEmail.value.trim(),
    name: els.userName.value.trim(),
    platformAdmin: els.userPlatformAdmin.checked,
    orgId: els.userOrg.value || null,
    orgRole: normalizeOrganizationRoleInput(els.userRole.value),
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
        if (hasCapability("managedAiUserAccess")) {
          await loadUserAiAccess(existingUser.id);
        }
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
        body: JSON.stringify(buildUserUpdatePayload(payload)),
      });
    }

    await loadUsers();
    const selectedUser = currentUser();
    if (!wasCreating && selectedUser?.id) {
      if (hasCapability("managedAiUserAccess")) {
        await saveUserAiAccess(selectedUser.id, aiAccessInput);
      }
    }
    if (selectedUser?.id) {
      if (hasCapability("managedAiUserAccess")) {
        await loadUserAiAccess(selectedUser.id);
      }
      populateUserEditor(selectedUser);
    }
    if (hasCapability("audit")) {
      await loadAudit();
    }
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
  if (state.session?.platformAdmin !== true) {
    return;
  }

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
  if (state.session?.platformAdmin !== true) {
    return;
  }

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
      if (state.session) {
        showApp();
      } else {
        showLogin();
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function bindActions() {
  els.browserSignInButton.addEventListener("click", () => {
    void startBrowserAuth();
  });
  els.signOutButton.addEventListener("click", () => void signOut());
  els.refreshButton.addEventListener("click", () => void bootstrapSession());
  els.createUserButton.addEventListener("click", enterCreateMode);
  els.createUserButtonInline.addEventListener("click", enterCreateMode);
  els.organizationSaveButton.addEventListener("click", () => void saveOrganization());
  els.organizationDomainAddButton.addEventListener("click", () => void createOrganizationDomain());
  els.organizationInviteSendButton.addEventListener("click", () => void createOrganizationInvite());
  els.credentialCreateProvider.addEventListener("change", updateCredentialCreateFields);
  els.credentialCreateSubmit.addEventListener("click", () => void createCredential());
  els.credentialsShowDeleted.addEventListener("change", () => {
    state.showDeletedCredentials = els.credentialsShowDeleted.checked;
    void loadCredentials();
  });
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
    if (state.selectedUserId && hasCapability("managedAiUserAccess")) {
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

  els.organizationDomainList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-domain-id]");
    if (!card) return;
    if (event.target.closest("[data-domain-save]")) {
      void saveOrganizationDomain(card);
      return;
    }
    if (event.target.closest("[data-domain-delete]")) {
      void deleteOrganizationDomain(card);
    }
  });

  els.organizationInviteList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-invite-id]");
    if (!card) return;
    if (event.target.closest("[data-invite-resend]")) {
      void resendOrganizationInvite(card);
      return;
    }
    if (event.target.closest("[data-invite-revoke]")) {
      void revokeOrganizationInvite(card);
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
    if (!hasCapability("managedAiUserAccess")) {
      return;
    }
    const user = currentUser();
    const aiAccess = user?.id ? currentUserAiAccess(user.id) : normalizeAiAccess(null);
    renderAiAccessCredentialOptions(user, aiAccess);
    updateAiAccessStatusText(user, aiAccess);
    void refreshSelectedAiAccessModels();
  });
  els.userAiAccessCredential.addEventListener("change", () => {
    if (!hasCapability("managedAiUserAccess")) {
      return;
    }
    void refreshSelectedAiAccessModels();
  });
  els.auditSearch.addEventListener("input", renderAudit);
  els.auditActorFilter.addEventListener("change", renderAudit);
  els.auditEntityFilter.addEventListener("change", renderAudit);
  els.auditDateRange.addEventListener("change", renderAudit);
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
}

bindNavigation();
bindActions();
updateCredentialCreateFields();
handleRoute();
void initializeAuth();
