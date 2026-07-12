import {
  beginModelDiscovery,
  beginModelPolicySave,
  completeModelDiscovery,
  completeModelPolicySave,
  createModelDiscoveryState,
  createModelPolicyState,
  failModelDiscovery,
  failModelPolicySave,
  loadModelPolicyState,
  modelRefsEqual,
  normalizeModelRef,
  normalizeModelRefs,
  replaceModelPolicyDraft,
  selectModelDiscoveryCredential,
} from "./model-policy-editor-state.js";
import {
  adminUserRoutePermissions,
  applyAdminPopState,
  beginAdminRouteMutation,
  beginOrganizationLoad,
  buildAdminUserUpdatePayload,
  canAccessAdminRoute,
  canPerformAdminRouteAction,
  completeOrganizationLoad,
  createAdminNavigationState,
  createAdminMutationState,
  createOrganizationLoadState,
  failOrganizationLoad,
  fromAdminDateTimeLocalValue,
  formatAdminRoute,
  navigateAdminRoute,
  organizationIdForRoute,
  parseAdminRoute,
  planAdminHistoryUpdate,
  isAdminRouteMutationCurrent,
  switchOrganizationRoute,
  toAdminDateTimeLocalValue,
  toPlatformRoute,
} from "./admin-route-state.js";

const STORAGE_KEY = "veslo.ai-gateway.admin.token";
const BROWSER_AUTH_STORAGE_KEY = "veslo.ai-gateway.admin.browser-auth";
const AUTH_STATE_BYTES = 32;
const AUTH_CODE_VERIFIER_BYTES = 32;
const CODEX_EXHAUSTED_REASON = "all_codex_credentials_exhausted";

const state = {
  token: localStorage.getItem(STORAGE_KEY) || "",
  route: parseAdminRoute(location.pathname),
  navigation: createAdminNavigationState(parseAdminRoute(location.pathname)),
  page: "overview",
  authBusy: false,
  session: null,
  user: null,
  credentials: [],
  alerts: [],
  audit: [],
  users: [],
  organizations: [],
  mutations: createAdminMutationState(),
  organizationLoad: createOrganizationLoadState(),
  organizationDomains: [],
  organizationInvites: [],
  organizationBilling: null,
  organizationAudit: [],
  usage: null,
  readiness: null,
  usageFilters: {
    groupBy: "total",
    credentialId: "",
    userId: "",
    orgId: "",
  },
  credentialFilters: {
    search: "",
    provider: "",
    state: "",
  },
  alertStatusFilter: "active",
  showDeletedCredentials: false,
  selectedCredentialId: null,
  selectedAlertId: null,
  selectedAuditId: null,
  selectedUserId: null,
  codexAuthCredentialUpload: null,
  codexAuthUploadByCredentialId: {},
  userMode: "edit",
  userAiAccessByUserId: {},
  userAiAccessAvailableCredentialsByUserId: {},
  modelPolicy: createModelPolicyState(),
  modelDiscovery: createModelDiscoveryState(),
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
  readinessDot: document.getElementById("readiness-dot"),
  readinessLabel: document.getElementById("readiness-label"),
  createUserButton: document.getElementById("create-user-button"),
  createUserButtonInline: document.querySelector('[data-platform-only][id="create-user-button-inline"]'),
  pageTitle: document.getElementById("page-title"),
  pageDescription: document.getElementById("page-description"),
  pageEyebrow: document.getElementById("page-eyebrow"),
  platformNavigation: document.querySelector("[data-nav-group=\"platform\"]"),
  platformNavItems: Array.from(document.querySelectorAll("[data-platform-route]")),
  organizationNavItems: Array.from(document.querySelectorAll("[data-organization-route]")),
  pages: Array.from(document.querySelectorAll("[data-page]")),
  organizationContextHeader: document.getElementById("organization-context-header"),
  operatingOrganizationLabel: document.getElementById("operating-organization-label"),
  organizationContextStatus: document.getElementById("organization-context-status"),
  organizationDirectoryList: document.getElementById("organization-directory-list"),
  organizationSections: Array.from(document.querySelectorAll("[data-organization-section]")),
  organizationPlaceholders: Array.from(document.querySelectorAll("[data-organization-placeholder]")),
  platformAdminControls: Array.from(document.querySelectorAll("[data-platform-admin-control]")),
  organizationBillingControls: Array.from(document.querySelectorAll("[data-organization-billing-control]")),
  aiAccessControls: Array.from(document.querySelectorAll("[data-ai-access-control]")),
  userGlobalControls: Array.from(document.querySelectorAll("[data-user-global-control]")),
  userMembershipControls: Array.from(document.querySelectorAll("[data-user-membership-control]")),
  seatLimitControls: Array.from(document.querySelectorAll("[data-seat-limit-control]")),
  organizationEditorTitle: document.getElementById("organization-editor-title"),
  organizationName: document.getElementById("organization-name"),
  organizationSlug: document.getElementById("organization-slug"),
  organizationSeatLimit: document.getElementById("organization-seat-limit"),
  organizationSaveButton: document.getElementById("organization-save-button"),
  organizationSaveStatus: document.getElementById("organization-save-status"),
  organizationSelectorControl: document.getElementById("organization-selector-control"),
  organizationSelectorInput: document.getElementById("organization-selector-input"),
  organizationSelectorOptions: document.getElementById("organization-selector-options"),
  organizationDomainAddButton: document.getElementById("organization-domain-add-button"),
  organizationDomainList: document.getElementById("organization-domain-list"),
  organizationInviteSendButton: document.getElementById("organization-invite-send-button"),
  organizationInviteList: document.getElementById("organization-invite-list"),
  organizationBillingStatus: document.getElementById("organization-billing-status"),
  organizationBillingSummary: document.getElementById("organization-billing-summary"),
  organizationBillingInterval: document.getElementById("organization-billing-interval"),
  organizationBillingBasic: document.getElementById("organization-billing-basic"),
  organizationBillingExtended: document.getElementById("organization-billing-extended"),
  organizationBillingCheckout: document.getElementById("organization-billing-checkout"),
  organizationBillingPortal: document.getElementById("organization-billing-portal"),
  organizationBillingPlanSave: document.getElementById("organization-billing-plan-save"),
  organizationBillingCancel: document.getElementById("organization-billing-cancel"),
  organizationBillingPlatformMode: document.getElementById("organization-billing-platform-mode"),
  organizationBillingPlatformStatus: document.getElementById("organization-billing-platform-status"),
  organizationBillingManualEnabled: document.getElementById("organization-billing-manual-enabled"),
  organizationBillingManualExpires: document.getElementById("organization-billing-manual-expires"),
  organizationBillingPlatformSave: document.getElementById("organization-billing-platform-save"),
  organizationAuditStatus: document.getElementById("organization-audit-status"),
  organizationAuditList: document.getElementById("organization-audit-list"),
  organizationDomainModal: document.getElementById("organization-domain-modal"),
  organizationDomainModalTitle: document.getElementById("organization-domain-modal-title"),
  organizationDomainModalClose: document.getElementById("organization-domain-modal-close"),
  organizationDomainModalDomain: document.getElementById("organization-domain-modal-domain"),
  organizationDomainModalEnabled: document.getElementById("organization-domain-modal-enabled"),
  organizationDomainModalSelfSignup: document.getElementById("organization-domain-modal-self-signup"),
  organizationDomainModalSave: document.getElementById("organization-domain-modal-save"),
  organizationDomainModalStatus: document.getElementById("organization-domain-modal-status"),
  organizationInviteModal: document.getElementById("organization-invite-modal"),
  organizationInviteModalClose: document.getElementById("organization-invite-modal-close"),
  organizationInviteModalEmail: document.getElementById("organization-invite-modal-email"),
  organizationInviteModalRole: document.getElementById("organization-invite-modal-role"),
  organizationInviteModalSend: document.getElementById("organization-invite-modal-send"),
  organizationInviteModalStatus: document.getElementById("organization-invite-modal-status"),
  credentialCreateProvider: document.getElementById("credential-create-provider"),
  credentialCreateName: document.getElementById("credential-create-name"),
  credentialCreateBaseUrl: document.getElementById("credential-create-base-url"),
  credentialCreateSecret: document.getElementById("credential-create-secret"),
  credentialCreateSubmit: document.getElementById("credential-create-submit"),
  credentialCreateCodexUpload: document.getElementById("credential-create-codex-upload"),
  credentialCreateCodexCopy: document.getElementById("credential-create-codex-copy"),
  credentialCreateCodexCommand: document.getElementById("credential-create-codex-command"),
  credentialCreateStatus: document.getElementById("credential-create-status"),
  credentialSearch: document.getElementById("credential-search"),
  credentialProviderFilter: document.getElementById("credential-provider-filter"),
  credentialStateFilter: document.getElementById("credential-state-filter"),
  credentialsShowDeleted: document.getElementById("credentials-show-deleted"),
  credentialsTableBody: document.getElementById("credentials-table-body"),
  modelPolicyPanel: document.getElementById("model-policy-panel"),
  modelPolicyList: document.getElementById("model-policy-list"),
  modelPolicyCredential: document.getElementById("model-policy-credential"),
  modelPolicyDiscoveredModel: document.getElementById("model-policy-discovered-model"),
  modelPolicyDiscoverButton: document.getElementById("model-policy-discover-button"),
  modelPolicyAddButton: document.getElementById("model-policy-add-button"),
  modelPolicySaveButton: document.getElementById("model-policy-save-button"),
  modelPolicyStatus: document.getElementById("model-policy-status"),
  credentialDetailModal: document.getElementById("credential-detail-modal"),
  credentialDetailModalClose: document.getElementById("credential-detail-modal-close"),
  credentialDetail: document.getElementById("credential-detail"),
  usageGroupBy: document.getElementById("usage-group-by"),
  usageCredentialFilter: document.getElementById("usage-filter-credential"),
  usageUserFilter: document.getElementById("usage-filter-user"),
  usageOrgFilter: document.getElementById("usage-filter-org"),
  usageChartBars: document.getElementById("usage-chart-bars"),
  usageTotalTokens: document.getElementById("usage-total-tokens"),
  usageTotalRequests: document.getElementById("usage-total-requests"),
  usageTopCredential: document.getElementById("usage-top-credential"),
  usageSeries: document.getElementById("usage-series"),
  usageCapacityFiveHour: document.getElementById("usage-capacity-five-hour"),
  usageCapacityFiveHourNote: document.getElementById("usage-capacity-five-hour-note"),
  usageCapacityWeekly: document.getElementById("usage-capacity-weekly"),
  usageCapacityWeeklyNote: document.getElementById("usage-capacity-weekly-note"),
  usageCapacityMeasured: document.getElementById("usage-capacity-measured"),
  usageCapacityMeasuredNote: document.getElementById("usage-capacity-measured-note"),
  usageCapacityCredentials: document.getElementById("usage-capacity-credentials"),
  usageCredentialTableBody: document.getElementById("usage-credential-table-body"),
  alertList: document.getElementById("alert-list"),
  alertStatusFilterButtons: Array.from(document.querySelectorAll("[data-alert-status-filter]")),
  alertDetailModal: document.getElementById("alert-detail-modal"),
  alertDetailModalClose: document.getElementById("alert-detail-modal-close"),
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
  userAiAccessStatus: document.getElementById("user-ai-access-status"),
  userEditorModal: document.getElementById("user-editor-modal"),
  userModalClose: document.getElementById("user-modal-close"),
  userDisableButton: document.getElementById("user-disable-button"),
  userDeleteButton: document.getElementById("user-delete-button"),
  userSaveButton: document.getElementById("user-save-button"),
  userSaveStatus: document.getElementById("user-save-status"),
  auditSearch: document.getElementById("audit-search"),
  auditDateRange: document.getElementById("audit-date-range"),
  auditActorFilter: document.getElementById("audit-actor-filter"),
  auditEntityFilter: document.getElementById("audit-entity-filter"),
  auditList: document.getElementById("audit-list"),
  auditDetailModal: document.getElementById("audit-detail-modal"),
  auditDetailModalClose: document.getElementById("audit-detail-modal-close"),
  auditDetail: document.getElementById("audit-detail"),
  backendConnectionStatus: document.getElementById("backend-connection-status"),
  backendConnectionLabel: document.getElementById("backend-connection-label"),
  backendConnectionDetail: document.getElementById("backend-connection-detail"),
  heroMetrics: Array.from(document.querySelectorAll(".hero-metrics .metric-card strong")),
};

let pendingAdminRequests = 0;
let backendConnectionHideTimer = 0;
let modelDiscoveryAbortController = null;
let organizationLoadAbortController = null;

function openModal(modal) {
  if (!modal) {
    return;
  }

  if (typeof modal.showModal === "function" && !modal.open) {
    modal.showModal();
    return;
  }

  modal.setAttribute("open", "");
}

function closeModal(modal) {
  if (!modal) {
    return;
  }

  if (typeof modal.close === "function") {
    modal.close();
    return;
  }

  modal.removeAttribute("open");
}

function closeAllModals() {
  [
    els.organizationDomainModal,
    els.organizationInviteModal,
    els.credentialDetailModal,
    els.alertDetailModal,
    els.userEditorModal,
    els.auditDetailModal,
  ].forEach((modal) => closeModal(modal));
}

function setDomainModalStatus(message, tone = "neutral") {
  els.organizationDomainModalStatus.textContent = message;
  els.organizationDomainModalStatus.dataset.tone = tone;
}

function setInviteModalStatus(message, tone = "neutral") {
  els.organizationInviteModalStatus.textContent = message;
  els.organizationInviteModalStatus.dataset.tone = tone;
}

function openOrganizationDomainModal(domainId = null) {
  const domain = state.organizationDomains.find((entry) => entry.id === domainId) || null;
  state.organizationDomainMode = domain ? "edit" : "create";
  state.selectedOrganizationDomainId = domain?.id || null;
  els.organizationDomainModalTitle.textContent = domain ? "Edit domain" : "Add domain";
  els.organizationDomainModalDomain.value = domain?.domain || "";
  els.organizationDomainModalDomain.disabled = Boolean(domain);
  els.organizationDomainModalEnabled.checked = domain?.enabled ?? true;
  els.organizationDomainModalSelfSignup.checked = domain?.selfSignupEnabled ?? false;
  els.organizationDomainModalSave.textContent = domain ? "Save domain" : "Add domain";
  els.organizationDomainModalSave.disabled = false;
  setDomainModalStatus("Domain changes are applied through Save.");
  if (typeof els.organizationDomainModal.showModal === "function" && !els.organizationDomainModal.open) {
    els.organizationDomainModal.showModal();
  } else {
    openModal(els.organizationDomainModal);
  }
}

function openOrganizationInviteModal() {
  els.organizationInviteModalEmail.value = "";
  els.organizationInviteModalRole.value = "member";
  els.organizationInviteModalSend.disabled = false;
  setInviteModalStatus("Invite is sent only when confirmed.");
  if (typeof els.organizationInviteModal.showModal === "function" && !els.organizationInviteModal.open) {
    els.organizationInviteModal.showModal();
  } else {
    openModal(els.organizationInviteModal);
  }
}

function openCredentialDetail(credentialId) {
  if (credentialId) {
    state.selectedCredentialId = credentialId;
  }
  renderCredentials();
  if (typeof els.credentialDetailModal.showModal === "function" && !els.credentialDetailModal.open) {
    els.credentialDetailModal.showModal();
  } else {
    openModal(els.credentialDetailModal);
  }
}

function openAlertDetail(alertId) {
  if (alertId) {
    state.selectedAlertId = alertId;
  }
  renderAlerts();
  if (typeof els.alertDetailModal.showModal === "function" && !els.alertDetailModal.open) {
    els.alertDetailModal.showModal();
  } else {
    openModal(els.alertDetailModal);
  }
}

function openUserEditor(userId) {
  state.userMode = userId ? "edit" : "create";
  state.selectedUserId = userId || null;
  els.userSaveButton.disabled = false;
  renderUsers();
  if (typeof els.userEditorModal.showModal === "function" && !els.userEditorModal.open) {
    els.userEditorModal.showModal();
  } else {
    openModal(els.userEditorModal);
  }
}

function openAuditDetail(auditId) {
  if (auditId) {
    state.selectedAuditId = auditId;
  }
  renderAudit();
  if (typeof els.auditDetailModal.showModal === "function" && !els.auditDetailModal.open) {
    els.auditDetailModal.showModal();
  } else {
    openModal(els.auditDetailModal);
  }
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

function hasCapability(capability) {
  if (Array.isArray(state.session?.capabilities)) {
    return state.session.capabilities.includes(capability);
  }
  if (state.session?.platformAdmin) {
    return true;
  }
  return capability === "organization" || capability === "users";
}

function routeAccessSnapshot() {
  return {
    platformAdmin: state.session?.platformAdmin === true,
    organizationIds: Array.isArray(state.session?.organizations)
      ? state.session.organizations.map((entry) => entry.id).filter(Boolean)
      : [],
    organizationAdminIds: Array.isArray(state.session?.organizations)
      ? state.session.organizations
        .filter((entry) => entry.role === "organization_admin")
        .map((entry) => entry.id)
        .filter(Boolean)
      : [],
    capabilities: Array.isArray(state.session?.capabilities)
      ? [...state.session.capabilities]
      : state.session?.platformAdmin === true
        ? ["managedAiUserAccess"]
        : [],
  };
}

function firstAuthorizedRoute() {
  if (state.session?.platformAdmin === true) {
    return toPlatformRoute("overview");
  }
  const organizationId = routeAccessSnapshot().organizationIds[0];
  return organizationId
    ? { area: "organization", page: "overview", organizationId }
    : null;
}

function applyAdminCapabilities() {
  const canManagePlatform = state.session?.platformAdmin === true;
  const inOrganizationWorkspace = state.route?.area === "organization";
  const canManageOrganizationBilling = canPerformAdminRouteAction(
    state.route,
    routeAccessSnapshot(),
    "manage-organization-billing",
  );
  const userPermissions = adminUserRoutePermissions(state.route, routeAccessSnapshot());

  els.platformNavigation.classList.toggle("hidden", !canManagePlatform);
  els.organizationContextHeader.classList.toggle("hidden", !inOrganizationWorkspace);
  els.platformAdminControls.forEach((node) => node.classList.toggle("hidden", !canManagePlatform));
  els.organizationBillingControls.forEach((node) => node.classList.toggle("hidden", !canManageOrganizationBilling));
  els.aiAccessControls.forEach((node) => node.classList.toggle("hidden", !userPermissions.editAiAccess));
  els.userGlobalControls.forEach((node) => node.classList.toggle("hidden", !userPermissions.editProfile));
  els.userMembershipControls.forEach((node) => node.classList.toggle("hidden", !userPermissions.editMembership));
  els.seatLimitControls.forEach((node) => node.classList.toggle("hidden", !canManagePlatform));
  if (els.userPlatformAdmin) {
    els.userPlatformAdmin.disabled = !userPermissions.setPlatformAdmin;
    if (!userPermissions.setPlatformAdmin) {
      els.userPlatformAdmin.checked = false;
    }
  }
  if (els.organizationSeatLimit) {
    els.organizationSeatLimit.disabled = !canManagePlatform;
  }
  if (els.createUserButtonInline) {
    els.createUserButtonInline.classList.toggle("hidden", !userPermissions.createUser);
  }
  els.createUserButton.classList.toggle("hidden", !userPermissions.createUser);
  els.userSaveButton.classList.toggle(
    "hidden",
    !userPermissions.createUser
      && !userPermissions.editProfile
      && !userPermissions.editMembership
      && !userPermissions.editAiAccess,
  );
  if (els.userRoleFilter) {
    const selectedRoleFilter = els.userRoleFilter.value;
    els.userRoleFilter.innerHTML = buildUserRoleFilterOptions();
    const hasSelectedRoleFilter = Array.from(els.userRoleFilter.options)
      .some((option) => option.value === selectedRoleFilter);
    if (hasSelectedRoleFilter) {
      els.userRoleFilter.value = selectedRoleFilter;
    }
  }
}

function normalizeOrganizationRoleInput(value) {
  return value === "organization_admin" || value === "owner" ? "organization_admin" : "member";
}

function organizationRoleOptionsMarkup() {
  return `<option value="organization_admin">Organization admin</option><option value="member">Member</option>`;
}

function buildUserRoleFilterOptions() {
  const platformAdminOption = canPerformAdminRouteAction(
    state.route,
    routeAccessSnapshot(),
    "set-platform-admin",
  )
    ? `<option value="platform_admin">Platform admin</option>`
    : "";
  return `<option value="">Role</option>${platformAdminOption}<option value="member">Member</option>`;
}

function buildUserUpdatePayload(payload) {
  return buildAdminUserUpdatePayload(state.route, routeAccessSnapshot(), payload);
}

function normalizeAiAccess(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      enabled: false,
      credentialId: null,
      provider: "",
      updatedAt: null,
    };
  }

  return {
    id: typeof payload.id === "string" ? payload.id : "",
    userId: typeof payload.userId === "string" ? payload.userId : "",
    enabled: payload.enabled === true,
    credentialId: typeof payload.credentialId === "string" ? payload.credentialId : null,
    provider: typeof payload.provider === "string" ? payload.provider : "",
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

function readAiAccessFormValue() {
  return {
    enabled: els.userAiAccessEnabled.checked,
    provider: els.userAiAccessProvider.value || null,
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

function healthyModelDiscoveryCredentials() {
  return state.credentials.filter((credential) =>
    credential.state === "healthy" &&
    !credential.deletedAt &&
    (credential.provider === "codex_oauth" || credential.provider === "openai_compatible")
  );
}

function setModelPolicyStatus(message, tone = "neutral") {
  els.modelPolicyStatus.textContent = message;
  els.modelPolicyStatus.setAttribute("role", tone === "error" ? "alert" : "status");
  els.modelPolicyStatus.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  if (tone === "neutral") {
    delete els.modelPolicyStatus.dataset.tone;
    return;
  }
  els.modelPolicyStatus.dataset.tone = tone;
}

function renderModelDiscoveryControls() {
  const credentials = healthyModelDiscoveryCredentials();
  const selectedId = credentials.some((entry) => entry.id === state.modelDiscovery.credentialId)
    ? state.modelDiscovery.credentialId
    : "";
  if (selectedId !== state.modelDiscovery.credentialId) {
    modelDiscoveryAbortController?.abort();
    modelDiscoveryAbortController = null;
    selectModelDiscoveryCredential(state.modelDiscovery, selectedId);
  }
  const busy = state.modelPolicy.loading || state.modelPolicy.saving || state.modelDiscovery.loading;
  els.modelPolicyCredential.innerHTML = [
    `<option value="">Select credential</option>`,
    ...credentials.map((credential) =>
      `<option value="${escapeHtml(credential.id)}">${escapeHtml(`${credential.name || credential.id} · ${credential.provider}`)}</option>`
    ),
  ].join("");
  els.modelPolicyCredential.value = selectedId;
  els.modelPolicyCredential.disabled = busy;

  els.modelPolicyDiscoveredModel.innerHTML = state.modelDiscovery.models.length > 0
    ? `<option value="">Select discovered model</option>${state.modelDiscovery.models
        .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
        .join("")}`
    : `<option value="">Discover models first</option>`;
  els.modelPolicyDiscoveredModel.disabled = busy || state.modelDiscovery.models.length === 0;
  els.modelPolicyDiscoverButton.disabled = busy || !selectedId;
  els.modelPolicyDiscoverButton.textContent = state.modelDiscovery.loading ? "Discovering..." : "Discover models";
  els.modelPolicyAddButton.disabled = busy || !els.modelPolicyDiscoveredModel.value;
}

function renderModelPolicy(statusMessage = "", statusTone = "neutral") {
  if (state.session?.platformAdmin !== true) {
    return;
  }

  const rows = state.modelPolicy.draftEnabledModels.map((entry) => {
    const active = modelRefsEqual(entry, state.modelPolicy.draftActiveModel);
    const removeDisabled = active || state.modelPolicy.saving;
    return `
      <article class="model-policy-row${active ? " active" : ""}">
        <label class="model-policy-active-control">
          <input type="radio" name="model-policy-active" data-model-policy-active-provider="${escapeHtml(entry.provider)}" data-model-policy-active-model="${escapeHtml(entry.model)}"${active ? " checked" : ""}${state.modelPolicy.saving ? " disabled" : ""} />
          <span>${active ? "Active" : "Set active"}</span>
        </label>
        <div class="model-policy-ref">
          <strong>${escapeHtml(entry.model)}</strong>
          <span>${escapeHtml(entry.provider)}</span>
        </div>
        <button class="button button-secondary" type="button" data-model-policy-remove-provider="${escapeHtml(entry.provider)}" data-model-policy-remove-model="${escapeHtml(entry.model)}"${removeDisabled ? " disabled" : ""}${active ? " title=\"Select a replacement active model before removing this model.\"" : ""}>Remove</button>
      </article>`;
  }).join("");

  els.modelPolicyList.innerHTML = state.modelPolicy.loading
    ? `<article class="model-policy-empty">Loading platform model policy...</article>`
    : rows || `<article class="model-policy-empty">No platform model policy configured. Discover and add a model to create one.</article>`;
  els.modelPolicySaveButton.disabled =
    state.modelPolicy.loading ||
    state.modelPolicy.saving ||
    !state.modelPolicy.dirty ||
    !state.modelPolicy.draftActiveModel;
  els.modelPolicySaveButton.textContent = state.modelPolicy.saving ? "Saving..." : "Save model policy";
  const busy = state.modelPolicy.loading || state.modelPolicy.saving || state.modelDiscovery.loading;
  els.modelPolicyPanel.setAttribute("aria-busy", String(busy));
  els.modelPolicyList.setAttribute("aria-disabled", String(state.modelPolicy.saving));
  renderModelDiscoveryControls();

  if (statusMessage) {
    setModelPolicyStatus(statusMessage, statusTone);
  } else if (state.modelPolicy.error) {
    setModelPolicyStatus(`Unable to update model policy: ${state.modelPolicy.error}`, "error");
  } else if (state.modelPolicy.loading) {
    setModelPolicyStatus("Loading platform model policy...", "pending");
  } else if (state.modelPolicy.saving) {
    setModelPolicyStatus("Saving platform model policy...", "pending");
  } else if (state.modelDiscovery.loading) {
    setModelPolicyStatus("Discovering models from the selected credential...", "pending");
  } else if (state.modelPolicy.dirty) {
    setModelPolicyStatus("Unsaved model policy changes.", "pending");
  } else if (state.modelPolicy.saved) {
    setModelPolicyStatus(`Policy saved${state.modelPolicy.saved.updatedAt ? ` ${formatDate(state.modelPolicy.saved.updatedAt)}` : ""}.`);
  } else {
    setModelPolicyStatus("No platform model policy configured. Add a discovered model, select it as active, then save.");
  }
}

async function loadModelPolicy() {
  if (state.session?.platformAdmin !== true) {
    return;
  }
  state.modelPolicy.loading = true;
  state.modelPolicy.error = "";
  renderModelPolicy();
  try {
    const payload = await fetchJson("/ai-infrastructure/model-policy");
    loadModelPolicyState(state.modelPolicy, payload?.policy);
  } catch (error) {
    state.modelPolicy.error = error instanceof Error ? error.message : "unknown_error";
  } finally {
    state.modelPolicy.loading = false;
    renderModelPolicy();
  }
}

async function saveModelPolicy() {
  if (state.session?.platformAdmin !== true) {
    return;
  }
  const submission = beginModelPolicySave(state.modelPolicy);
  if (!submission) {
    state.modelPolicy.error = "Select one enabled model as active before saving.";
    renderModelPolicy();
    return;
  }

  renderModelPolicy();
  let savedSuccessfully = false;
  try {
    const saved = await fetchJson("/ai-infrastructure/model-policy", {
      method: "PUT",
      body: JSON.stringify({
        enabledModels: submission.enabledModels,
        activeModel: submission.activeModel,
      }),
    });
    savedSuccessfully = completeModelPolicySave(state.modelPolicy, submission, saved?.policy);
  } catch (error) {
    failModelPolicySave(
      state.modelPolicy,
      submission,
      error instanceof Error ? error.message : "unknown_error",
    );
  } finally {
    const message = savedSuccessfully
      ? state.modelPolicy.dirty
        ? "Submitted policy saved. Newer draft changes remain unsaved."
        : "Model policy saved."
      : "";
    renderModelPolicy(message, savedSuccessfully ? "success" : "neutral");
  }
}

async function discoverModelsForPolicy() {
  if (state.session?.platformAdmin !== true) {
    return;
  }
  const credential = healthyModelDiscoveryCredentials()
    .find((entry) => entry.id === els.modelPolicyCredential.value);
  if (!credential) {
    state.modelDiscovery.error = "Select a healthy compatible credential.";
    renderModelPolicy(state.modelDiscovery.error, "error");
    return;
  }

  if (state.modelDiscovery.credentialId !== credential.id) {
    selectModelDiscoveryCredential(state.modelDiscovery, credential.id);
  }
  const request = beginModelDiscovery(state.modelDiscovery);
  if (!request) {
    return;
  }
  modelDiscoveryAbortController?.abort();
  const controller = new AbortController();
  modelDiscoveryAbortController = controller;
  renderModelPolicy();
  let shouldAnnounce = false;
  try {
    const payload = await fetchJson(`/credentials/${encodeURIComponent(credential.id)}/models`, {
      signal: modelDiscoveryAbortController.signal,
    });
    shouldAnnounce = completeModelDiscovery(state.modelDiscovery, request, payload?.models);
    if (shouldAnnounce && state.modelDiscovery.models.length === 0) {
      state.modelDiscovery.error = "This credential did not report any models.";
    }
  } catch (error) {
    shouldAnnounce = failModelDiscovery(
      state.modelDiscovery,
      request,
      error instanceof Error ? error.message : "unknown_error",
    );
  } finally {
    if (modelDiscoveryAbortController === controller) {
      modelDiscoveryAbortController = null;
    }
    if (shouldAnnounce) {
      renderModelPolicy(
        state.modelDiscovery.error || `Discovered ${state.modelDiscovery.models.length} models from ${credential.name || credential.id}.`,
        state.modelDiscovery.error ? "error" : "success",
      );
    } else {
      renderModelPolicy();
    }
  }
}

function addDiscoveredModel() {
  if (state.session?.platformAdmin !== true) {
    return;
  }
  if (state.modelPolicy.saving) {
    return;
  }
  const credential = healthyModelDiscoveryCredentials()
    .find((entry) => entry.id === state.modelDiscovery.credentialId);
  const model = els.modelPolicyDiscoveredModel.value.trim();
  if (!credential || !state.modelDiscovery.models.includes(model)) {
    return;
  }
  const target = { provider: credential.provider, model };
  replaceModelPolicyDraft(
    state.modelPolicy,
    [...state.modelPolicy.draftEnabledModels, target],
    state.modelPolicy.draftActiveModel || target,
  );
  state.modelPolicy.error = "";
  renderModelPolicy();
}

function selectDraftActiveModel(provider, model) {
  if (state.session?.platformAdmin !== true) {
    return;
  }
  if (state.modelPolicy.saving) {
    return;
  }
  const target = normalizeModelRef({ provider, model });
  if (!target || !state.modelPolicy.draftEnabledModels.some((entry) => modelRefsEqual(entry, target))) {
    return;
  }
  replaceModelPolicyDraft(state.modelPolicy, state.modelPolicy.draftEnabledModels, target);
  state.modelPolicy.error = "";
  renderModelPolicy();
}

function removeDraftModel(provider, model) {
  if (state.session?.platformAdmin !== true) {
    return;
  }
  if (state.modelPolicy.saving) {
    return;
  }
  const target = normalizeModelRef({ provider, model });
  if (!target) {
    return;
  }
  if (modelRefsEqual(state.modelPolicy.draftActiveModel, target)) {
    state.modelPolicy.error = "Select a replacement active model before removing this model.";
    renderModelPolicy();
    return;
  }
  replaceModelPolicyDraft(
    state.modelPolicy,
    state.modelPolicy.draftEnabledModels.filter((entry) => !modelRefsEqual(entry, target)),
    state.modelPolicy.draftActiveModel,
  );
  state.modelPolicy.error = "";
  renderModelPolicy();
}

function summarizeUser(user) {
  const organizationId = organizationIdForRoute(state.route);
  const membership = organizationId
    ? user.memberships?.find((entry) => entry.orgId === organizationId)
    : user.memberships?.[0];
  const orgPart = membership ? `${membership.role} in ${membership.orgName}` : "no org membership";
  if (!canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "set-platform-admin")) {
    return orgPart;
  }
  const rolePart = user.platformAdmin ? "Platform admin" : "Member";
  return `${rolePart} · ${orgPart}`;
}

function defaultUserSaveStatusMessage() {
  if (state.userMode === "create") {
    return "Fill in the profile and save to create the user.";
  }
  const permissions = adminUserRoutePermissions(state.route, routeAccessSnapshot());
  if (permissions.editAiAccess && !permissions.editMembership) {
    return "AI access changes are applied through Save AI access.";
  }
  return permissions.editAiAccess
    ? "Directory changes and AI access assignments are applied separately."
    : "Organization membership changes are applied through Save.";
}

function userStatus(user) {
  return user.disabled ? "Disabled" : user.emailVerified ? "Active" : "Invited";
}

function setStatus(text, userText = "") {
  els.authState.textContent = text;
  els.authUser.textContent = userText || "";
}

function setBackendConnectionStatus(status, label = "", detail = "") {
  if (!els.backendConnectionStatus) {
    return;
  }

  if (backendConnectionHideTimer) {
    window.clearTimeout(backendConnectionHideTimer);
    backendConnectionHideTimer = 0;
  }

  if (status === "idle") {
    els.backendConnectionStatus.classList.add("hidden");
    return;
  }

  els.backendConnectionStatus.dataset.state = status;
  els.backendConnectionStatus.classList.remove("hidden");
  if (els.backendConnectionLabel && label) {
    els.backendConnectionLabel.textContent = label;
  }
  if (els.backendConnectionDetail) {
    els.backendConnectionDetail.textContent = detail;
  }
}

function finishBackendConnectionRequest() {
  pendingAdminRequests = Math.max(0, pendingAdminRequests - 1);
  if (pendingAdminRequests > 0 || els.backendConnectionStatus?.dataset.state === "offline") {
    return;
  }

  setBackendConnectionStatus("connected", "Connected to AI Gateway.", "Latest backend response received.");
  backendConnectionHideTimer = window.setTimeout(() => {
    if (pendingAdminRequests === 0 && els.backendConnectionStatus?.dataset.state === "connected") {
      setBackendConnectionStatus("idle");
    }
  }, 900);
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
}

function panelForRoute(route) {
  if (route?.area === "platform") {
    return {
      overview: "overview",
      organizations: "organizations",
      "ai-infrastructure": "credentials",
      "ai-usage": "usage",
      "ai-alerts": "alerts",
      "platform-users": "users",
      audit: "audit",
    }[route.page] || "overview";
  }
  if (route?.page === "overview" || route?.page === "domains-invites") return "organization-workspace";
  if (route?.page === "members" || route?.page === "ai-access") return "users";
  return "organization-placeholder";
}

function routeTitle(route) {
  if (route?.area === "organization") {
    const titles = {
      overview: ["Organization workspace", "Overview", "Review this organization's identity and status."],
      members: ["Organization workspace", "Members", "Manage members within the routed organization."],
      "domains-invites": ["Organization workspace", "Domains & invites", "Manage authorized domains and pending invitations."],
      billing: ["Organization workspace", "Billing", "Manage this organization's canonical Den billing state."],
      "ai-access": ["Organization workspace", "AI access", "Manage member AI access for this organization."],
      audit: ["Organization workspace", "Audit", "Inspect administrative events scoped to this organization."],
    };
    return titles[route.page] || titles.overview;
  }
  const titles = {
    overview: ["Platform administration", "Overview", "Inspect global AI Gateway health without organization context."],
    organizations: ["Platform administration", "Organizations", "Choose an organization to enter its explicit workspace."],
    "ai-infrastructure": ["Platform administration", "AI Infrastructure", "Manage the global model policy and provider credentials."],
    "ai-usage": ["AI Infrastructure", "Platform usage", "Review global provider usage and Codex capacity."],
    "ai-alerts": ["AI Infrastructure", "Platform alerts", "Triage global credential and routing incidents."],
    "platform-users": ["Platform administration", "Platform Users", "Manage the global user directory without organization filtering."],
    audit: ["Platform administration", "Global Audit", "Inspect platform-wide administrative events."],
  };
  return titles[route?.page] || titles.overview;
}

function renderRoute() {
  const route = state.route;
  state.page = panelForRoute(route);
  els.platformNavItems.forEach((item) => {
    const active = route?.area === "platform" && item.dataset.platformRoute === route.page;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  els.organizationNavItems.forEach((item) => {
    const active = route?.area === "organization" && item.dataset.organizationRoute === route.page;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  els.organizationNavItems.forEach((item) => {
    if (route?.area !== "organization") return;
    item.href = formatAdminRoute({
      area: "organization",
      page: item.dataset.organizationRoute,
      organizationId: route.organizationId,
    });
  });
  els.pages.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.page !== state.page);
  });
  els.organizationSections.forEach((section) => section.classList.toggle("hidden", section.dataset.organizationSection !== route?.page));
  els.organizationPlaceholders.forEach((section) => section.classList.toggle("hidden", section.dataset.organizationPlaceholder !== route?.page));
  const [eyebrow, title, description] = routeTitle(route);
  els.pageEyebrow.textContent = eyebrow;
  els.pageTitle.textContent = title;
  els.pageDescription.textContent = description;
  const organization = currentOrganization();
  els.operatingOrganizationLabel.textContent = `Operating organization: ${organization?.name || organization?.slug || route?.organizationId || "unavailable"}`;
  if (route?.area === "organization" && route.page === "overview") {
    els.organizationSaveButton.disabled = false;
  }
  applyAdminCapabilities();
}

async function setAdminRoute(route, { historyMode = "push", load = true } = {}) {
  if (!route || (state.session && !canAccessAdminRoute(route, routeAccessSnapshot()))) {
    return false;
  }
  const pathname = navigateAdminRoute(state.navigation, route);
  if (!pathname) return false;
  state.route = state.navigation.route;
  if (
    (state.route.area !== "platform" || state.route.page !== "platform-users")
    && state.userMode === "create"
  ) {
    state.userMode = "edit";
  }
  if (state.route.area === "platform") {
    organizationLoadAbortController?.abort();
    organizationLoadAbortController = null;
    state.organizationLoad = createOrganizationLoadState();
    state.organizationDomains = [];
    state.organizationInvites = [];
    state.organizationBilling = null;
    state.organizationAudit = [];
  }
  const historyUpdate = planAdminHistoryUpdate(state.route, location, historyMode);
  if (historyUpdate?.method === "push") {
    history.pushState(null, "", pathname);
  } else if (historyUpdate?.method === "replace") {
    history.replaceState(null, "", pathname);
  }
  renderRoute();
  if (load) await loadRouteData(state.route);
  return true;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  pendingAdminRequests += 1;
  setBackendConnectionStatus("connecting", "Connecting to AI Gateway...", "Waiting for backend response.");

  try {
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
  } catch (error) {
    setBackendConnectionStatus(
      "offline",
      "Still trying to connect to AI Gateway.",
      "The admin page cannot reach the backend yet. Check your internet connection or wait for the server.",
    );
    throw error;
  } finally {
    finishBackendConnectionRequest();
  }
}

async function fetchJson(path, options = {}) {
  const { response, payload } = await api(path, options);
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || "request_failed");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function formatAdminError(error) {
  if (error?.payload && typeof error.payload === "object") {
    return Object.entries(error.payload)
      .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
      .join(" · ");
  }
  return error instanceof Error ? error.message : "unknown_error";
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
  const requestedRoute = parseAdminRoute(location.pathname);
  const authorizedRoute = requestedRoute && canAccessAdminRoute(requestedRoute, routeAccessSnapshot())
    ? requestedRoute
    : firstAuthorizedRoute();
  if (!authorizedRoute) {
    showLogin("No authorized organization workspace is available for this account.");
    return;
  }
  await setAdminRoute(authorizedRoute, { historyMode: "replace", load: false });
  setStatus(
    "Signed in",
    state.user
      ? `${state.user.name || state.user.email} · ${state.session.platformAdmin ? "platform admin" : "organization admin"}`
      : state.session.platformAdmin ? "platform admin" : "organization admin",
  );
  showApp();
  await loadRouteData(state.route);
}

function populateOrganizationOptions() {
  const organizations = Array.isArray(state.session?.organizations) ? state.session.organizations : [];
  state.organizations = organizations;
  els.userOrg.innerHTML = organizations.length
    ? organizations.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.name)}</option>`).join("")
    : `<option value="">No organization</option>`;
  if (state.route?.area === "organization") renderOrganizationSelector();
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

  if (!pending) {
    clearAuthCallbackParams();
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
    clearAuthCallbackParams();
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
  state.alerts = [];
  state.audit = [];
  state.users = [];
  state.organizations = [];
  state.organizationDomains = [];
  state.organizationInvites = [];
  state.organizationBilling = null;
  state.organizationAudit = [];
  state.usage = null;
  state.selectedCredentialId = null;
  state.selectedAlertId = null;
  state.selectedAuditId = null;
  state.selectedUserId = null;
  organizationLoadAbortController?.abort();
  organizationLoadAbortController = null;
  state.organizationLoad = createOrganizationLoadState();
  state.mutations = createAdminMutationState();
  state.route = null;
  state.navigation = createAdminNavigationState(null);
  state.userMode = "edit";
  modelDiscoveryAbortController?.abort();
  modelDiscoveryAbortController = null;
  state.modelPolicy = createModelPolicyState();
  state.modelDiscovery = createModelDiscoveryState();
  localStorage.removeItem(STORAGE_KEY);
  window.location.assign("/admin");
}

function currentOrganization() {
  const organizationId = organizationIdForRoute(state.route);
  if (!organizationId) return null;
  if (state.organizationLoad.organization?.id === organizationId) return state.organizationLoad.organization;
  return state.organizations.find((entry) => entry.id === organizationId)
    || state.session?.organizations?.find((entry) => entry.id === organizationId)
    || null;
}

function organizationSelectorLabel(organization) {
  const name = String(organization?.name || "").trim();
  const slug = String(organization?.slug || "").trim();
  const id = String(organization?.id || "").trim();
  return [name || slug || id, slug, id]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" - ");
}

function normalizeSelectorText(value) {
  return String(value || "").trim().toLowerCase();
}

function findOrganizationFromSelectorValue(value) {
  const normalized = normalizeSelectorText(value);
  if (!normalized) {
    return null;
  }
  return state.organizations.find((organization) => {
    const candidates = [
      organizationSelectorLabel(organization),
      organization?.name,
      organization?.slug,
      organization?.id,
    ].map(normalizeSelectorText);
    return candidates.includes(normalized);
  }) || null;
}

function renderOrganizationSelector() {
  const inOrganizationWorkspace = state.route?.area === "organization";
  els.organizationSelectorControl.classList.toggle("hidden", !inOrganizationWorkspace);
  if (!inOrganizationWorkspace) {
    return;
  }

  const organizations = Array.isArray(state.organizations) ? state.organizations : [];
  const selected = currentOrganization();
  els.organizationSelectorOptions.innerHTML = organizations.map((organization) => `
    <option value="${escapeHtml(organizationSelectorLabel(organization))}" label="${escapeHtml(organization.slug || organization.id)}"></option>
  `).join("");
  els.organizationSelectorInput.value = selected ? organizationSelectorLabel(selected) : "";
  els.organizationSelectorInput.disabled = organizations.length <= 1;
  els.organizationSelectorInput.title = organizations.length <= 1
    ? "Only one organization is available."
    : "Search by organization name, slug, or id.";
}

function hasOrganizationPendingChanges() {
  const organization = currentOrganization();
  if (!organization) {
    return false;
  }

  const savedSeatLimit = organization.seatLimit === null || organization.seatLimit === undefined
    ? ""
    : String(organization.seatLimit);
  const currentSeatLimit = els.organizationSeatLimit.value.trim();
  return (
    els.organizationName.value.trim() !== String(organization.name || "").trim() ||
    els.organizationSlug.value.trim() !== String(organization.slug || "").trim() ||
    (state.session?.platformAdmin === true && currentSeatLimit !== savedSeatLimit)
  );
}

async function selectOrganizationFromSelector() {
  if (state.route?.area !== "organization") {
    renderOrganizationSelector();
    return;
  }

  const selected = findOrganizationFromSelectorValue(els.organizationSelectorInput.value);
  const currentId = organizationIdForRoute(state.route);
  if (!selected) {
    renderOrganizationSelector();
    return;
  }
  if (selected.id === currentId) {
    renderOrganizationSelector();
    return;
  }
  if (
    hasOrganizationPendingChanges() &&
    !window.confirm("Discard unsaved organization changes before switching organization?")
  ) {
    renderOrganizationSelector();
    return;
  }

  closeAllModals();
  state.organizationDomains = [];
  state.organizationInvites = [];
  state.selectedOrganizationDomainId = null;
  setOrganizationSaveStatus("Loading organization...", "pending");
  await setAdminRoute(switchOrganizationRoute(state.route, selected.id));
  setOrganizationSaveStatus("No pending changes.");
}

async function loadOrganization() {
  if (state.route?.area !== "organization") return;
  await loadOrganizationWorkspace(state.route);
}

async function loadOrganizationsDirectory() {
  try {
    const payload = await fetchJson("/organizations");
    state.organizations = Array.isArray(payload?.organizations) ? payload.organizations : [];
    renderOrganizationsDirectory();
    renderOrganizationSelector();
  } catch (error) {
    els.organizationDirectoryList.innerHTML = `<article class="list-card active"><div><strong>Unable to load organizations</strong><p>${escapeHtml(error instanceof Error ? error.message : "unknown_error")}</p></div></article>`;
  }
}

function renderOrganizationsDirectory() {
  const organizations = Array.isArray(state.organizations) ? state.organizations : [];
  els.organizationDirectoryList.innerHTML = organizations.map((organization) => `
    <article class="list-card organization-directory-card">
      <div>
        <strong>${escapeHtml(organization.name || organization.slug || organization.id)}</strong>
        <p>${escapeHtml(organization.slug || "No slug")} · ${escapeHtml(organization.id)}</p>
      </div>
      <button
        class="button button-secondary"
        type="button"
        data-enter-organization-id="${escapeHtml(organization.id)}"
        aria-label="Open ${escapeHtml(organization.name || organization.slug || organization.id)} organization workspace"
      >Open workspace</button>
    </article>
  `).join("") || `<article class="list-card active"><div><strong>No organizations</strong><p>No organization workspaces are available.</p></div></article>`;
}

async function loadOrganizationWorkspace(route) {
  const organizationId = organizationIdForRoute(route);
  const request = beginOrganizationLoad(state.organizationLoad, route);
  if (!organizationId || !request) return;
  organizationLoadAbortController?.abort();
  const controller = new AbortController();
  organizationLoadAbortController = controller;
  els.organizationContextStatus.textContent = "Loading organization workspace...";
  try {
    const directoryPayload = await fetchJson("/organizations", { signal: controller.signal });
    const organizations = Array.isArray(directoryPayload?.organizations) ? directoryPayload.organizations : [];
    state.organizations = organizations;
    if (!organizations.some((entry) => entry.id === organizationId)) {
      throw new Error("organization_not_authorized_or_not_found");
    }
    const organizationPayload = await fetchJson(`/organizations/${encodeURIComponent(organizationId)}`, { signal: controller.signal });
    if (!completeOrganizationLoad(state.organizationLoad, request, organizationPayload?.organization)) return;
    if (route.page === "domains-invites") {
      const [domainsPayload, invitesPayload] = await Promise.all([
        fetchJson(`/organizations/${encodeURIComponent(organizationId)}/domains`, { signal: controller.signal }),
        fetchJson(`/organizations/${encodeURIComponent(organizationId)}/invites`, { signal: controller.signal }),
      ]);
      if (state.route?.area !== "organization" || organizationIdForRoute(state.route) !== organizationId) return;
      state.organizationDomains = Array.isArray(domainsPayload?.domains) ? domainsPayload.domains : [];
      state.organizationInvites = Array.isArray(invitesPayload?.invites) ? invitesPayload.invites : [];
    } else {
      state.organizationDomains = [];
      state.organizationInvites = [];
    }
    els.organizationContextStatus.textContent = "";
    renderOrganization();
    renderOrganizationSelector();
    renderRoute();
  } catch (error) {
    if (controller.signal.aborted) return;
    failOrganizationLoad(state.organizationLoad, request, error instanceof Error ? error.message : "unknown_error");
    els.organizationContextStatus.textContent = "Organization unavailable or not authorized. Return to an authorized organization workspace.";
    renderOrganization();
  } finally {
    if (organizationLoadAbortController === controller) organizationLoadAbortController = null;
  }
}

function renderOrganizationBilling() {
  const billing = state.organizationBilling;
  if (!billing) {
    els.organizationBillingSummary.innerHTML = `<article class="metric-card"><span class="metric-label">Billing</span><strong>Unavailable</strong><span class="metric-note">No billing summary was returned.</span></article>`;
    return;
  }
  const account = billing.account || {};
  const entitlement = billing.entitlement || {};
  els.organizationBillingSummary.innerHTML = [
    ["Status", account.status || entitlement.status || "none", account.mode || entitlement.effectiveMode || "none"],
    ["Licenses", billing.licenseLimit ?? entitlement.licenseLimit ?? 0, `${billing.activeUserCount ?? entitlement.activeUserCount ?? 0} active users`],
    ["Managed AI", entitlement.canUseManagedAi ? "Enabled" : "Blocked", entitlement.managedAiBlockingReason || "Access available"],
  ].map(([label, value, note]) => `<article class="metric-card"><span class="metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><span class="metric-note">${escapeHtml(note)}</span></article>`).join("");
  els.organizationBillingBasic.value = String(account.quantities?.managedAiBasic ?? 0);
  els.organizationBillingExtended.value = String(account.quantities?.managedAiExtended ?? 0);
  els.organizationBillingInterval.value = account.billingInterval === "annual" ? "annual" : "monthly";
  els.organizationBillingPlatformMode.value = account.mode || "none";
  els.organizationBillingPlatformStatus.value = account.status || "none";
  els.organizationBillingManualEnabled.checked = account.manualAccess?.enabled === true;
  els.organizationBillingManualExpires.value = toAdminDateTimeLocalValue(account.manualAccess?.expiresAt);
}

function renderOrganizationAudit() {
  els.organizationAuditList.innerHTML = state.organizationAudit.map((entry) => `
    <article class="list-card">
      <div><strong>${escapeHtml(entry.action)}</strong><p>${escapeHtml(entry.summary || `${entry.entityType}:${entry.entityId}`)}</p></div>
      <span>${escapeHtml(formatDate(entry.timestamp))}</span>
    </article>
  `).join("") || `<article class="list-card active"><div><strong>No organization events</strong><p>Legacy global events without organization scope are intentionally absent.</p></div></article>`;
}

async function loadOrganizationBilling(route) {
  const organizationId = organizationIdForRoute(route);
  const mutation = beginAdminRouteMutation(state.mutations, "organization-billing-load", route);
  if (!organizationId || !mutation) return;
  els.organizationBillingStatus.textContent = "Loading billing...";
  try {
    const payload = await fetchJson(`/organizations/${encodeURIComponent(organizationId)}/billing`);
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    state.organizationBilling = payload?.billing || null;
    renderOrganizationBilling();
    els.organizationBillingStatus.textContent = "Billing loaded.";
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    state.organizationBilling = null;
    renderOrganizationBilling();
    els.organizationBillingStatus.textContent = `Unable to load billing · ${formatAdminError(error)}`;
  }
}

async function loadOrganizationAudit(route) {
  const organizationId = organizationIdForRoute(route);
  const mutation = beginAdminRouteMutation(state.mutations, "organization-audit-load", route);
  if (!organizationId || !mutation) return;
  els.organizationAuditStatus.textContent = "Loading organization audit...";
  try {
    const payload = await fetchJson(`/organizations/${encodeURIComponent(organizationId)}/audit`);
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    state.organizationAudit = Array.isArray(payload?.events) ? payload.events : [];
    renderOrganizationAudit();
    els.organizationAuditStatus.textContent = state.organizationAudit.length ? "Organization audit loaded." : "No scoped events found.";
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    state.organizationAudit = [];
    renderOrganizationAudit();
    els.organizationAuditStatus.textContent = `Unable to load organization audit · ${formatAdminError(error)}`;
  }
}

async function loadRouteData(route) {
  await loadReadiness();
  if (route.area === "platform") {
    if (route.page === "overview") await Promise.all([loadCredentials(), loadAlerts(), loadUsers(), loadUsage()]);
    if (route.page === "organizations") await loadOrganizationsDirectory();
    if (route.page === "ai-infrastructure") await loadAiInfrastructure();
    if (route.page === "ai-usage") await Promise.all([loadCredentials(), loadUsage()]);
    if (route.page === "ai-alerts") await loadAlerts();
    if (route.page === "platform-users") await loadUsers();
    if (route.page === "audit") await loadAudit();
    renderOverview();
    return;
  }
  if (route.area === "organization") {
    await loadOrganizationWorkspace(route);
    if (route.page === "members" || route.page === "ai-access") await loadUsers();
    if (route.page === "billing") await loadOrganizationBilling(route);
    if (route.page === "audit") await loadOrganizationAudit(route);
  }
}

async function loadReadiness() {
  try {
    const response = await fetch("/readiness");
    state.readiness = await response.json().catch(() => null);
  } catch (error) {
    console.error("loadReadiness failed", error);
    state.readiness = { ok: false, status: "not_ready" };
  }
  renderReadiness();
}

function renderReadiness() {
  const readiness = state.readiness;
  if (!readiness) {
    setReadinessSignal("info", "Checking inference readiness");
    return;
  }

  if (readiness.ok === true) {
    setReadinessSignal("good", "Inference ready");
    return;
  }

  setReadinessSignal("warn", "Inference unavailable");
}

function setReadinessSignal(tone, label) {
  if (!els.readinessDot || !els.readinessLabel) {
    return;
  }
  els.readinessDot.classList.remove("good", "warn", "info");
  els.readinessDot.classList.add(tone);
  els.readinessLabel.textContent = label;
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
    if (state.session?.platformAdmin === true) {
      renderModelPolicy();
    }
  } catch (error) {
    console.error("loadCredentials failed", error);
  }
}

async function loadAiInfrastructure() {
  await loadCredentials();
  if (state.session?.platformAdmin !== true) {
    return;
  }
  await loadModelPolicy();
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
  if (!canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "edit-ai-access")) {
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
  if (!canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "edit-ai-access")) {
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
        credentialId: typeof input.credentialId === "string" ? input.credentialId : null,
      }
    : {
        ...readAiAccessFormValue(),
        credentialId: readAiAccessCredentialValue(),
      };

  const saved = await fetchJson(`/users/${encodeURIComponent(resolvedUserId)}/ai-access`, {
    method: "PUT",
    body: JSON.stringify({
      ...aiAccessInput,
      organizationId: organizationIdForRoute(state.route),
    }),
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
    if (
      state.userMode !== "create"
      && !state.selectedUserId
      && canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "create-user")
    ) {
      state.userMode = "create";
    }
    renderUsers();
    if (
      state.userMode !== "create"
      && state.selectedUserId
      && canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "edit-ai-access")
    ) {
      await loadUserAiAccess(state.selectedUserId);
      const user = currentUser();
      if (user) {
        populateUserEditor(user);
      }
    }
    setUserSaveStatus(defaultUserSaveStatusMessage());
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
    String(state.credentials.filter((entry) => !entry.deletedAt).length),
    String(state.credentials.filter((entry) => !entry.deletedAt && entry.state !== "healthy").length),
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
    renderOrganizationSelector();
    els.organizationEditorTitle.textContent = "No organization";
    els.organizationName.value = "";
    els.organizationSlug.value = "";
    els.organizationSeatLimit.value = "";
    els.organizationDomainList.innerHTML = `<article class="list-card active"><div><strong>No organization</strong><p>No organization is available for this session.</p></div></article>`;
    els.organizationInviteList.innerHTML = `<article class="list-card active"><div><strong>No pending invites</strong><p>Select an organization first.</p></div></article>`;
    return;
  }

  renderOrganizationSelector();
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
      </div>
      <span class="button-row">
        <button class="button button-secondary" type="button" data-domain-edit>Edit</button>
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

function filteredCredentials() {
  const term = state.credentialFilters.search.trim().toLowerCase();
  const provider = state.credentialFilters.provider;
  const filterState = state.credentialFilters.state;

  return state.credentials.filter((credential) => {
    const displayState = credential.deletedAt ? "deleted" : credential.state;
    if (provider && credential.provider !== provider) {
      return false;
    }
    if (filterState && displayState !== filterState) {
      return false;
    }
    if (term) {
      const searchable = [
        credential.id,
        credential.name,
        credential.scope,
        credential.type,
        credential.provider,
        displayState,
      ].filter(Boolean).join(" ").toLowerCase();
      return searchable.includes(term);
    }
    return true;
  });
}

function renderCredentials() {
  const credentials = filteredCredentials();
  const rows = credentials.map((credential) => {
    const displayState = credential.deletedAt ? "deleted" : credential.state;
    const rowClasses = [
      credential.id === state.selectedCredentialId ? "row-alert" : "",
      credential.deletedAt ? "row-muted" : "",
    ].filter(Boolean).join(" ");
    return `<tr class="${escapeHtml(rowClasses)}" data-credential-id="${escapeHtml(credential.id)}">
      <td><strong>${escapeHtml(credential.name)}</strong><span>${escapeHtml(credential.scope)}</span></td>
      <td>${escapeHtml(credential.type)}</td>
      <td><span class="status-chip ${escapeHtml(credentialStateTone(displayState))}">${escapeHtml(displayState)}</span></td>
      <td><a href="/admin/ai-infrastructure/alerts" data-open-alerts="${escapeHtml(credential.id)}">${escapeHtml(String(credential.alertCount))} active alerts</a></td>
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
    const codexAuthUpload = state.codexAuthUploadByCredentialId[selected.id] || null;
    els.credentialDetail.innerHTML = `
      <p class="eyebrow">Selected credential</p>
      <h3>${escapeHtml(selected.name)}</h3>
      <div class="stack">
        ${selected.deletedAt ? "" : `
          <label class="credential-detail-field">
            <span>Display name</span>
            <input class="input" data-credential-rename-input type="text" value="${escapeHtml(selected.name)}" />
          </label>
          <div class="button-row">
            <button class="button button-secondary" type="button" data-credential-rename>Save name</button>
            <p class="editor-note credential-detail-status" data-credential-rename-status></p>
          </div>
        `}
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
          ${selected.deletedAt ? "" : `
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
          `}
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

function renderUsage() {
  if (!state.usage) {
    return;
  }

  const { capacity, credentialUsage = [], filters, series, summary, topCredentials } = state.usage;
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

  renderUsageCapacity(capacity);

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

function renderUsageCapacity(capacity) {
  const codex = capacity?.codexCredentials ?? { total: 0, measurable: 0, unavailable: 0 };
  const fiveHour = capacity?.fiveHour ?? null;
  const weekly = capacity?.weekly ?? null;

  els.usageCapacityFiveHour.textContent = formatCapacityRemaining(fiveHour?.remainingPercent);
  els.usageCapacityFiveHourNote.textContent = formatCapacityWindowNote(fiveHour);
  els.usageCapacityWeekly.textContent = formatCapacityRemaining(weekly?.remainingPercent);
  els.usageCapacityWeeklyNote.textContent = formatCapacityWindowNote(weekly);
  els.usageCapacityMeasured.textContent = `${formatNumber(codex.measurable)}/${formatNumber(codex.total)}`;
  els.usageCapacityMeasuredNote.textContent = formatCapacityMeasuredNote(codex);

  const credentials = Array.isArray(capacity?.credentials) ? capacity.credentials : [];
  els.usageCapacityCredentials.innerHTML = credentials.map((credential) => {
    const tone = credential.limitsAvailable ? "success" : credential.statusAvailable ? "warning" : "danger";
    const label = credential.limitsAvailable ? "Limits visible" : credential.statusAvailable ? "Limits unknown" : "Status unavailable";
    return `
      <article class="list-card active">
        <div>
          <strong>${escapeHtml(credential.name || credential.id)}</strong>
          <p>5h ${escapeHtml(formatCapacityRemaining(credential.fiveHourRemainingPercent))} · Weekly ${escapeHtml(formatCapacityRemaining(credential.weeklyRemainingPercent))}</p>
        </div>
        <span class="status-chip ${escapeHtml(tone)}">${escapeHtml(label)}</span>
      </article>
    `;
  }).join("") || `<article class="list-card active"><div><strong>No Codex capacity data</strong><p>No functional Codex credentials reported visible limits.</p></div></article>`;
}

function formatCapacityMeasuredNote(codex) {
  if (!codex || codex.total === 0) {
    return "No functional Codex credentials";
  }

  const notes = [];
  if (codex.unknown > 0) {
    notes.push(`${formatNumber(codex.unknown)} credential limit status unknown`);
  }
  if (codex.unavailable > 0) {
    notes.push(`${formatNumber(codex.unavailable)} credential status unavailable`);
  }
  return notes.length > 0 ? notes.join(" · ") : "All Codex credential limits visible";
}

function formatCapacityRemaining(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value)}% remaining`
    : "Unknown";
}

function formatCapacityWindowNote(window) {
  if (!window || typeof window.measurableCredentials !== "number" || window.measurableCredentials === 0) {
    return "No visible Codex limit data";
  }
  const used = typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent)}% used` : "usage unknown";
  return `${used} across ${formatNumber(window.measurableCredentials)} measured credential${window.measurableCredentials === 1 ? "" : "s"}`;
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

function filteredAlerts() {
  return state.alerts.filter((alert) => {
    if (state.alertStatusFilter === "active") {
      return alert.status !== "acknowledged" && alert.status !== "resolved";
    }
    return alert.status === state.alertStatusFilter;
  });
}

function renderAlerts() {
  const alerts = filteredAlerts();
  els.alertStatusFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.alertStatusFilter === state.alertStatusFilter);
  });
  els.alertList.innerHTML = alerts.map((alert) => `
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

  const selected = alerts.find((entry) => entry.id === state.selectedAlertId) || alerts[0];
  if (selected) {
    state.selectedAlertId = selected.id;
    const credential = state.credentials.find((entry) => entry.id === selected.credentialId);
    els.alertDetail.innerHTML = `
      <p class="eyebrow">Runbook</p>
      <h3>${escapeHtml(selected.title)}</h3>
      <div class="stack">
        <div class="detail-line"><span>Affected credential</span><strong>${escapeHtml(credential?.name || "Unassigned")}</strong></div>
        <div class="detail-line"><span>Affected routes</span><strong>${escapeHtml(String(selected.affectedSessions))}</strong></div>
        <div class="detail-line"><span>Owner</span><strong>${escapeHtml(selected.owner || "Unassigned")}</strong></div>
        <div class="detail-line"><span>Status</span><strong>${escapeHtml(selected.status)}</strong></div>
      </div>
      <p class="eyebrow">Alert lifecycle</p>
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
    const organizationId = organizationIdForRoute(state.route);
    if (
      organizationId
      && !Array.isArray(user.memberships)
    ) {
      return false;
    }
    if (
      organizationId
      && !user.memberships.some((membership) => membership.orgId === organizationId)
    ) {
      return false;
    }
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
    els.userAiAccessStatus.textContent = "Create the user first, then assign access to the platform-managed model.";
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
    ? `Assignment updated ${formatDate(aiAccess.updatedAt)}. The model is managed in AI Infrastructure.`
    : "The assignment is enforced by the gateway; the model is managed in AI Infrastructure.";
}

function populateUserEditor(user) {
  const isCreate = state.userMode === "create";
  const permissions = adminUserRoutePermissions(state.route, routeAccessSnapshot());
  const organizationId = organizationIdForRoute(state.route);
  const membership = organizationId
    ? user?.memberships?.find((entry) => entry.orgId === organizationId)
    : user?.memberships?.[0];
  const aiAccess = user?.id ? currentUserAiAccess(user.id) : normalizeAiAccess(null);
  els.userEditorStatus.textContent = isCreate ? "Create user" : userStatus(user);
  els.userEditorTitle.textContent = isCreate ? "New user" : (user?.name || user?.email || "User");
  els.userName.value = user?.name || "";
  els.userName.disabled = !permissions.editProfile;
  els.userEmail.value = user?.email || "";
  els.userEmail.disabled = !isCreate || !permissions.createUser;
  els.userOrg.disabled = !permissions.editMembership || Boolean(organizationId);
  els.userRole.disabled = !permissions.editMembership;
  els.userPlatformAdmin.checked = user?.platformAdmin === true;
  els.userPlatformAdmin.disabled = !permissions.setPlatformAdmin;
  if (!permissions.setPlatformAdmin) {
    els.userPlatformAdmin.checked = false;
  }
  els.userSendInvite.checked = true;
  els.userSendInvite.disabled = !isCreate || !permissions.createUser;
  if (organizationId) {
    els.userOrg.value = organizationId;
    els.userRole.value = normalizeOrganizationRoleInput(membership?.role);
  } else if (membership?.orgId) {
    els.userOrg.value = membership.orgId;
    els.userRole.value = normalizeOrganizationRoleInput(membership.role);
  } else if (els.userOrg.options.length > 0) {
    els.userOrg.selectedIndex = 0;
    els.userRole.value = "member";
  }
  els.userDisableButton.textContent = user?.disabled ? "Enable user" : "Disable user";
  els.userDisableButton.disabled = isCreate || !user || !permissions.disableUser;
  els.userDeleteButton.disabled = isCreate || !user || !permissions.deleteUser;
  if (permissions.editAiAccess) {
    els.userAiAccessEnabled.checked = aiAccess.enabled;
    els.userAiAccessEnabled.disabled = isCreate || !user;
    els.userAiAccessProvider.value = aiAccess.provider || "";
    els.userAiAccessProvider.disabled = isCreate || !user;
    renderAiAccessCredentialOptions(user, aiAccess);
    updateAiAccessStatusText(user, aiAccess);
  }
  els.userSaveButton.textContent = permissions.editAiAccess && !permissions.editMembership
    ? "Save AI access"
    : permissions.editMembership && !permissions.editProfile
      ? "Save membership"
      : "Save changes";
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
        <div class="detail-line"><span>Timestamp</span><strong>${escapeHtml(formatDate(selected.timestamp))}</strong></div>
      </div>
    `;
  }
}

function enterCreateMode() {
  if (!canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "create-user")) {
    return;
  }

  state.userMode = "create";
  state.selectedUserId = null;
  void setAdminRoute(toPlatformRoute("platform-users")).then((changed) => {
    if (!changed) return;
    showApp();
    openUserEditor(null);
    setUserSaveStatus(defaultUserSaveStatusMessage());
  });
}

async function refreshCredentialOperations() {
  await Promise.all([
    loadCredentials(),
    loadAlerts(),
    loadAudit(),
  ]);
  renderOverview();
}

async function refreshSelectedUserAiAccessOptions() {
  if (
    !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "edit-ai-access")
    || state.userMode === "create"
    || !state.selectedUserId
  ) {
    return;
  }

  await loadUserAiAccess(state.selectedUserId);
  const user = currentUser();
  if (user) {
    populateUserEditor(user);
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

async function prepareNewCodexCredentialUpload() {
  els.credentialCreateCodexUpload.disabled = true;
  setCredentialCreateStatus("Preparing Codex upload command", "pending");

  try {
    const payload = await fetchJson("/credentials/codex-auth-upload-session", {
      method: "POST",
    });
    state.codexAuthCredentialUpload = payload;
    els.credentialCreateCodexCommand.value = payload.command || "";
    els.credentialCreateCodexCommand.classList.toggle("hidden", !payload.command);
    els.credentialCreateCodexCopy.classList.toggle("hidden", !payload.command);
    setCredentialCreateStatus(`Run the command locally. It expires ${formatDate(payload.upload?.expiresAt)}.`, "success");
  } catch (error) {
    setCredentialCreateStatus(
      `Unable to prepare Codex upload: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    els.credentialCreateCodexUpload.disabled = false;
  }
}

async function copyNewCodexCredentialUploadCommand() {
  const command = state.codexAuthCredentialUpload?.command || els.credentialCreateCodexCommand.value.trim();
  if (!command) {
    setCredentialCreateStatus("Codex upload command is not ready.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(command);
    setCredentialCreateStatus("Command copied.", "success");
  } catch {
    els.credentialCreateCodexCommand.focus();
    els.credentialCreateCodexCommand.select();
    setCredentialCreateStatus("Copy failed. Select the command manually.", "error");
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

  void setAdminRoute(toPlatformRoute("ai-alerts")).then((changed) => {
    if (!changed) return;
    showApp();
    renderAlerts();
  });
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
    drain: `Drain ${credential.name}? New requests will stop using this credential.`,
    rotate: `Rotate ${credential.name}? Active routes will move to another healthy credential if one is available.`,
    revoke: `Revoke ${credential.name}? Existing routes may lose access if no replacement is available.`,
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
    if (action === "resolve") {
      closeModal(els.alertDetailModal);
    }
  } catch (error) {
    window.alert(`Unable to ${action} alert: ${error instanceof Error ? error.message : "unknown_error"}`);
  }
}

function organizationBillingQuantities() {
  return {
    managedAiBasic: Math.max(0, Number.parseInt(els.organizationBillingBasic.value || "0", 10) || 0),
    managedAiExtended: Math.max(0, Number.parseInt(els.organizationBillingExtended.value || "0", 10) || 0),
  };
}

async function runOrganizationBillingAction(action) {
  const organizationId = organizationIdForRoute(state.route);
  const platformOnly = action === "platform";
  const allowed = platformOnly
    ? canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "manage-platform-billing")
    : canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "manage-organization-billing");
  if (!organizationId || !allowed) return;
  const mutation = beginAdminRouteMutation(state.mutations, `organization-billing-${action}`, state.route);
  const quantities = organizationBillingQuantities();
  const manualExpiresAt = fromAdminDateTimeLocalValue(els.organizationBillingManualExpires.value);
  const platformBody = {
    mode: els.organizationBillingPlatformMode.value,
    status: els.organizationBillingPlatformStatus.value,
    quantities,
    ...(els.organizationBillingPlatformMode.value === "manual_access"
      ? {
        manualAccess: {
          enabled: els.organizationBillingManualEnabled.checked,
          expiresAt: manualExpiresAt,
          licenseLimit: quantities.managedAiBasic + quantities.managedAiExtended,
        },
      }
      : {}),
  };
  const requests = {
    checkout: { method: "POST", body: { interval: els.organizationBillingInterval.value, quantities } },
    portal: { method: "POST", body: {} },
    plan: { method: "PATCH", body: { quantities } },
    cancel: { method: "POST", body: {} },
    platform: { method: "PATCH", body: platformBody },
  };
  const request = requests[action];
  if (!mutation || !request) return;
  els.organizationBillingStatus.textContent = `Applying billing ${action}...`;
  try {
    const payload = await fetchJson(`/organizations/${encodeURIComponent(organizationId)}/billing/${action}`, {
      method: request.method,
      body: JSON.stringify(request.body),
    });
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    const redirectUrl = payload?.checkout?.url || payload?.portal?.url;
    if (typeof redirectUrl === "string" && redirectUrl) {
      window.location.assign(redirectUrl);
      return;
    }
    if (payload?.billing) {
      state.organizationBilling = payload.billing;
      renderOrganizationBilling();
    } else {
      await loadOrganizationBilling(state.route);
    }
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    els.organizationBillingStatus.textContent = `Billing ${action} completed.`;
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    els.organizationBillingStatus.textContent = `Billing ${action} failed · ${formatAdminError(error)}`;
  }
}

async function saveOrganization() {
  const orgId = organizationIdForRoute(state.route);
  if (!orgId || !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "edit-organization-profile")) {
    return;
  }
  const mutation = beginAdminRouteMutation(state.mutations, "organization-profile", state.route);

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
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    renderOrganization();
    setOrganizationSaveStatus("Organization saved.", "success");
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setOrganizationSaveStatus(
      `Unable to save organization: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    if (isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) {
      els.organizationSaveButton.disabled = false;
    }
  }
}

async function saveOrganizationDomainModal() {
  const orgId = organizationIdForRoute(state.route);
  if (!orgId || !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "manage-organization-domains")) {
    return;
  }
  const mutation = beginAdminRouteMutation(state.mutations, "organization-domain-save", state.route);
  const domainMode = state.organizationDomainMode;
  const domainId = state.selectedOrganizationDomainId;

  try {
    els.organizationDomainModalSave.disabled = true;
    setDomainModalStatus(
      domainMode === "edit" ? "Saving domain..." : "Adding domain...",
      "pending",
    );
    const payload = {
      domain: els.organizationDomainModalDomain.value.trim(),
      enabled: els.organizationDomainModalEnabled.checked,
      selfSignupEnabled: els.organizationDomainModalSelfSignup.checked,
    };
    if (domainMode === "edit" && domainId) {
      await fetchJson(`/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: payload.enabled,
          selfSignupEnabled: payload.selfSignupEnabled,
        }),
      });
    } else {
      await fetchJson(`/organizations/${encodeURIComponent(orgId)}/domains`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    await loadOrganization();
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    closeModal(els.organizationDomainModal);
    setOrganizationSaveStatus(
      domainMode === "edit" ? "Domain saved." : "Domain added.",
      "success",
    );
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setDomainModalStatus(
      `Unable to save domain: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    if (isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) {
      els.organizationDomainModalSave.disabled = false;
    }
  }
}

async function deleteOrganizationDomain(card) {
  const orgId = organizationIdForRoute(state.route);
  const domainId = card?.dataset?.domainId;
  if (
    !orgId
    || !domainId
    || !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "manage-organization-domains")
  ) {
    return;
  }
  const domainName = card.querySelector("strong")?.textContent?.trim() || "this domain";
  if (!window.confirm(`Remove ${domainName}? Users from this domain will no longer match organization signup policy.`)) {
    return;
  }
  const mutation = beginAdminRouteMutation(state.mutations, `organization-domain-delete:${domainId}`, state.route);

  try {
    setOrganizationSaveStatus("Removing domain...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`, {
      method: "DELETE",
    });
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    await loadOrganization();
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setOrganizationSaveStatus("Domain removed.", "success");
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setOrganizationSaveStatus(
      `Unable to remove domain: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function createOrganizationInvite() {
  const orgId = organizationIdForRoute(state.route);
  if (!orgId || !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "manage-organization-invites")) {
    return;
  }
  const mutation = beginAdminRouteMutation(state.mutations, "organization-invite-create", state.route);

  try {
    els.organizationInviteModalSend.disabled = true;
    setInviteModalStatus("Sending invite...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/invites`, {
      method: "POST",
      body: JSON.stringify({
        email: els.organizationInviteModalEmail.value.trim(),
        role: normalizeOrganizationRoleInput(els.organizationInviteModalRole.value),
      }),
    });
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    await loadOrganization();
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    closeModal(els.organizationInviteModal);
    setOrganizationSaveStatus("Invite sent.", "success");
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setInviteModalStatus(
      `Unable to send invite: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    if (isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) {
      els.organizationInviteModalSend.disabled = false;
    }
  }
}

async function resendOrganizationInvite(card) {
  const orgId = organizationIdForRoute(state.route);
  const inviteId = card?.dataset?.inviteId;
  if (
    !orgId
    || !inviteId
    || !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "manage-organization-invites")
  ) {
    return;
  }
  const mutation = beginAdminRouteMutation(state.mutations, `organization-invite-resend:${inviteId}`, state.route);

  try {
    setOrganizationSaveStatus("Resending invite...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/resend`, {
      method: "POST",
    });
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    await loadOrganization();
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setOrganizationSaveStatus("Invite resent.", "success");
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setOrganizationSaveStatus(
      `Unable to resend invite: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function revokeOrganizationInvite(card) {
  const orgId = organizationIdForRoute(state.route);
  const inviteId = card?.dataset?.inviteId;
  if (
    !orgId
    || !inviteId
    || !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "manage-organization-invites")
  ) {
    return;
  }
  const inviteEmail = card.querySelector("strong")?.textContent?.trim() || "this invite";
  if (!window.confirm(`Revoke invite for ${inviteEmail}?`)) {
    return;
  }
  const mutation = beginAdminRouteMutation(state.mutations, `organization-invite-revoke:${inviteId}`, state.route);

  try {
    setOrganizationSaveStatus("Revoking invite...", "pending");
    await fetchJson(`/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/revoke`, {
      method: "POST",
    });
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    await loadOrganization();
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setOrganizationSaveStatus("Invite revoked.", "success");
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setOrganizationSaveStatus(
      `Unable to revoke invite: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  }
}

async function saveUser() {
  const permissions = adminUserRoutePermissions(state.route, routeAccessSnapshot());
  const wasCreating = state.userMode === "create";
  if (wasCreating && !canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "create-user")) {
    return;
  }
  const targetUser = wasCreating ? null : currentUser();
  if (!wasCreating && !targetUser) return;
  const payload = {
    email: els.userEmail.value.trim(),
    name: els.userName.value.trim(),
    platformAdmin: els.userPlatformAdmin.checked,
    orgId: els.userOrg.value || null,
    orgRole: normalizeOrganizationRoleInput(els.userRole.value),
  };
  const updatePayload = wasCreating ? payload : buildUserUpdatePayload(payload);
  const canEditAiAccess = permissions.editAiAccess && !wasCreating;
  if (!wasCreating && !updatePayload && !canEditAiAccess) return;
  const aiAccessInput = canEditAiAccess
    ? {
        ...readAiAccessFormValue(),
        credentialId: readAiAccessCredentialValue(),
      }
    : null;
  const mutation = beginAdminRouteMutation(
    state.mutations,
    `user-save:${targetUser?.id || "create"}`,
    state.route,
  );

  try {
    els.userSaveButton.disabled = true;
    setUserSaveStatus(wasCreating ? "Creating user..." : "Saving user...", "pending");
    if (wasCreating) {
      const existingUser = findUserByEmail(payload.email);
      if (existingUser) {
        if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
        state.userMode = "edit";
        state.selectedUserId = existingUser.id;
        renderUsers();
        if (permissions.editAiAccess) {
          await loadUserAiAccess(existingUser.id);
        }
        if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
        populateUserEditor(existingUser);
        setUserSaveStatus("That email already exists. Showing the existing user record instead.", "error");
        return;
      }
    }
    if (wasCreating) {
      const created = await fetchJson("/users", {
        method: "POST",
        body: JSON.stringify(updatePayload),
      });
      if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
      state.userMode = "edit";
      state.selectedUserId = created?.user?.id || null;
    } else if (updatePayload) {
      await fetchJson(`/users/${encodeURIComponent(targetUser.id)}`, {
        method: "PATCH",
        body: JSON.stringify(updatePayload),
      });
    }
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    if (canEditAiAccess) {
      await saveUserAiAccess(targetUser.id, aiAccessInput);
    }
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    if (wasCreating || updatePayload) await loadUsers();
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    const selectedUser = state.users.find((entry) => entry.id === (targetUser?.id || state.selectedUserId)) || currentUser();
    if (selectedUser?.id) {
      populateUserEditor(selectedUser);
    }
    if (state.route?.area === "platform" && hasCapability("audit")) {
      await loadAudit();
    }
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setUserSaveStatus(
      wasCreating
        ? "User created. Review AI access separately if needed."
        : permissions.editAiAccess && !permissions.editMembership
          ? "AI access saved."
          : permissions.editMembership && !permissions.editProfile
            ? "Organization membership saved."
            : "User changes saved.",
      "success",
    );
    closeModal(els.userEditorModal);
  } catch (error) {
    if (!isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) return;
    setUserSaveStatus(
      `Unable to save user: ${error instanceof Error ? error.message : "unknown_error"}`,
      "error",
    );
  } finally {
    if (isAdminRouteMutationCurrent(state.mutations, mutation, state.route)) {
      els.userSaveButton.disabled = false;
    }
  }
}

async function toggleUserDisabled() {
  if (!canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "disable-user")) {
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
  if (!canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "delete-user")) {
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
  els.platformNavItems.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const route = toPlatformRoute(item.dataset.platformRoute || "overview");
      if (state.session) void setAdminRoute(route);
      else showLogin();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  els.organizationNavItems.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const organizationId = organizationIdForRoute(state.route);
      if (!organizationId || !state.session) return;
      void setAdminRoute({ area: "organization", page: item.dataset.organizationRoute, organizationId });
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
  els.organizationSelectorInput.addEventListener("change", () => void selectOrganizationFromSelector());
  els.organizationSelectorInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void selectOrganizationFromSelector();
    }
  });
  els.organizationDirectoryList.addEventListener("click", (event) => {
    const entry = event.target.closest("[data-enter-organization-id]");
    if (!entry) return;
    const route = switchOrganizationRoute(toPlatformRoute("organizations"), entry.dataset.enterOrganizationId);
    void setAdminRoute(route);
  });
  els.organizationDomainAddButton.addEventListener("click", () => openOrganizationDomainModal());
  els.organizationDomainModalSave.addEventListener("click", () => void saveOrganizationDomainModal());
  els.organizationDomainModalClose.addEventListener("click", () => closeModal(els.organizationDomainModal));
  els.organizationInviteSendButton.addEventListener("click", () => openOrganizationInviteModal());
  els.organizationInviteModalSend.addEventListener("click", () => void createOrganizationInvite());
  els.organizationInviteModalClose.addEventListener("click", () => closeModal(els.organizationInviteModal));
  els.organizationBillingCheckout.addEventListener("click", () => void runOrganizationBillingAction("checkout"));
  els.organizationBillingPortal.addEventListener("click", () => void runOrganizationBillingAction("portal"));
  els.organizationBillingPlanSave.addEventListener("click", () => void runOrganizationBillingAction("plan"));
  els.organizationBillingCancel.addEventListener("click", () => void runOrganizationBillingAction("cancel"));
  els.organizationBillingPlatformSave.addEventListener("click", () => void runOrganizationBillingAction("platform"));
  els.credentialCreateProvider.addEventListener("change", updateCredentialCreateFields);
  els.credentialCreateSubmit.addEventListener("click", () => void createCredential());
  els.credentialCreateCodexUpload.addEventListener("click", () => void prepareNewCodexCredentialUpload());
  els.credentialCreateCodexCopy.addEventListener("click", () => void copyNewCodexCredentialUploadCommand());
  els.modelPolicySaveButton.addEventListener("click", () => void saveModelPolicy());
  els.modelPolicyCredential.addEventListener("change", () => {
    modelDiscoveryAbortController?.abort();
    modelDiscoveryAbortController = null;
    selectModelDiscoveryCredential(state.modelDiscovery, els.modelPolicyCredential.value);
    renderModelPolicy();
  });
  els.modelPolicyDiscoverButton.addEventListener("click", () => void discoverModelsForPolicy());
  els.modelPolicyDiscoveredModel.addEventListener("change", () => {
    els.modelPolicyAddButton.disabled =
      state.modelPolicy.saving ||
      state.modelDiscovery.loading ||
      !els.modelPolicyDiscoveredModel.value;
  });
  els.modelPolicyAddButton.addEventListener("click", addDiscoveredModel);
  els.modelPolicyList.addEventListener("change", (event) => {
    const active = event.target.closest("[data-model-policy-active-provider]");
    if (!active) return;
    selectDraftActiveModel(active.dataset.modelPolicyActiveProvider, active.dataset.modelPolicyActiveModel);
  });
  els.modelPolicyList.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-model-policy-remove-provider]");
    if (!remove) return;
    removeDraftModel(remove.dataset.modelPolicyRemoveProvider, remove.dataset.modelPolicyRemoveModel);
  });
  els.credentialsShowDeleted.addEventListener("change", () => {
    state.showDeletedCredentials = els.credentialsShowDeleted.checked;
    void loadCredentials();
  });
  els.credentialSearch.addEventListener("input", () => {
    state.credentialFilters.search = els.credentialSearch.value;
    renderCredentials();
  });
  els.credentialProviderFilter.addEventListener("change", () => {
    state.credentialFilters.provider = els.credentialProviderFilter.value;
    renderCredentials();
  });
  els.credentialStateFilter.addEventListener("change", () => {
    state.credentialFilters.state = els.credentialStateFilter.value;
    renderCredentials();
  });
  els.userSaveButton.addEventListener("click", () => void saveUser());
  els.userDisableButton.addEventListener("click", () => void toggleUserDisabled());
  els.userDeleteButton.addEventListener("click", () => void deleteUser());
  els.credentialDetailModalClose.addEventListener("click", () => closeModal(els.credentialDetailModal));
  els.alertDetailModalClose.addEventListener("click", () => closeModal(els.alertDetailModal));
  els.userModalClose.addEventListener("click", () => closeModal(els.userEditorModal));
  els.auditDetailModalClose.addEventListener("click", () => closeModal(els.auditDetailModal));

  els.credentialsTableBody.addEventListener("click", (event) => {
    const alertLink = event.target.closest("[data-open-alerts]");
    if (alertLink) {
      event.preventDefault();
      state.selectedCredentialId = alertLink.dataset.openAlerts;
      openAlertsForSelectedCredential();
      return;
    }
    const row = event.target.closest("[data-credential-id]");
    if (!row) return;
    openCredentialDetail(row.dataset.credentialId);
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
      closeAllModals();
      openAlertsForSelectedCredential();
    }
  });

  els.alertList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-alert-id]");
    if (!card) return;
    openAlertDetail(card.dataset.alertId);
  });

  els.alertDetail.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-alert-action]");
    if (actionButton) {
      void runAlertAction(actionButton.dataset.alertAction);
      return;
    }

    const routeAudit = event.target.closest("[data-route-audit]");
    if (routeAudit) {
      closeAllModals();
      void setAdminRoute(toPlatformRoute("audit")).then((changed) => {
        if (!changed) return;
        showApp();
        renderAudit();
      });
    }
  });
  els.alertStatusFilterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.alertStatusFilter = button.dataset.alertStatusFilter;
      renderAlerts();
    });
  });

  els.userList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-user-id]");
    if (!card) return;
    openUserEditor(card.dataset.userId);
    if (
      state.selectedUserId
      && canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "edit-ai-access")
    ) {
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
    if (event.target.closest("[data-domain-edit]")) {
      openOrganizationDomainModal(card.dataset.domainId);
      return;
    }
    if (event.target.closest("[data-domain-delete]")) {
      void deleteOrganizationDomain(card);
      return;
    }
    openOrganizationDomainModal(card.dataset.domainId);
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
    openAuditDetail(card.dataset.auditId);
  });

  els.userSearch.addEventListener("input", renderUsers);
  els.userStatusFilter.addEventListener("change", renderUsers);
  els.userRoleFilter.addEventListener("change", renderUsers);
  els.userAiAccessProvider.addEventListener("change", () => {
    if (!canPerformAdminRouteAction(state.route, routeAccessSnapshot(), "edit-ai-access")) {
      return;
    }
    const user = currentUser();
    const aiAccess = user?.id ? currentUserAiAccess(user.id) : normalizeAiAccess(null);
    renderAiAccessCredentialOptions(user, aiAccess);
    updateAiAccessStatusText(user, aiAccess);
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
  const route = parseAdminRoute(location.pathname);
  if (route) {
    state.route = route;
    state.navigation = createAdminNavigationState(route);
    renderRoute();
  }
}

window.addEventListener("popstate", () => {
  if (!applyAdminPopState(state.navigation, location.pathname)) return;
  const route = state.navigation.route;
  if (!state.session || !canAccessAdminRoute(route, routeAccessSnapshot())) {
    const fallback = firstAuthorizedRoute();
    if (fallback) void setAdminRoute(fallback, { historyMode: "replace" });
    return;
  }
  state.route = route;
  void setAdminRoute(route, { historyMode: "replace" });
});

bindNavigation();
bindActions();
updateCredentialCreateFields();
handleRoute();
void initializeAuth();
