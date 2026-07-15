export function normalizeModelRef(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  return provider && model ? { provider, model } : null;
}

export function modelRefsEqual(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model;
}

export function normalizeModelRefs(values) {
  const refs = Array.isArray(values) ? values.map(normalizeModelRef).filter(Boolean) : [];
  return refs
    .filter((entry, index) => refs.findIndex((candidate) => modelRefsEqual(candidate, entry)) === index)
    .sort((left, right) => `${left.provider}\u0000${left.model}`.localeCompare(`${right.provider}\u0000${right.model}`));
}

export function normalizeModelPolicy(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const enabledModels = normalizeModelRefs(value.enabledModels);
  const activeModel = normalizeModelRef(value.activeModel);
  if (!activeModel || !enabledModels.some((entry) => modelRefsEqual(entry, activeModel))) {
    return null;
  }
  return {
    enabledModels,
    activeModel,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function cloneModelRef(value) {
  return value ? { provider: value.provider, model: value.model } : null;
}

function clonePolicy(value) {
  return value
    ? {
        enabledModels: normalizeModelRefs(value.enabledModels),
        activeModel: cloneModelRef(value.activeModel),
        updatedAt: value.updatedAt ?? null,
      }
    : null;
}

function modelPolicyFingerprint(enabledModels, activeModel) {
  return JSON.stringify({
    enabledModels: normalizeModelRefs(enabledModels),
    activeModel: normalizeModelRef(activeModel),
  });
}

export function isModelPolicyDirty(state) {
  const savedEnabledModels = state.saved?.enabledModels ?? [];
  const savedActiveModel = state.saved?.activeModel ?? null;
  return modelPolicyFingerprint(state.draftEnabledModels, state.draftActiveModel)
    !== modelPolicyFingerprint(savedEnabledModels, savedActiveModel);
}

export function createModelPolicyState(savedValue = null) {
  const saved = normalizeModelPolicy(savedValue);
  return {
    saved: clonePolicy(saved),
    draftEnabledModels: saved ? normalizeModelRefs(saved.enabledModels) : [],
    draftActiveModel: saved ? cloneModelRef(saved.activeModel) : null,
    dirty: false,
    loading: false,
    saving: false,
    error: "",
    draftVersion: 0,
    loadRequestId: 0,
    saveRequestId: 0,
  };
}

export function beginModelPolicyLoad(state) {
  state.loadRequestId += 1;
  state.loading = true;
  state.error = "";
  return {
    requestId: state.loadRequestId,
    draftVersion: state.draftVersion,
  };
}

export function completeModelPolicyLoad(state, request, policyValue) {
  if (!request || request.requestId !== state.loadRequestId || !state.loading) {
    return false;
  }
  if (state.dirty || state.draftVersion !== request.draftVersion) {
    state.loading = false;
    return false;
  }
  loadModelPolicyState(state, policyValue);
  state.loading = false;
  return true;
}

export function invalidateModelPolicyLoad(state) {
  state.loadRequestId += 1;
  state.loading = false;
}

export function failModelPolicyLoad(state, request, error) {
  if (!request || request.requestId !== state.loadRequestId || !state.loading) {
    return false;
  }
  state.loading = false;
  if (state.dirty || state.draftVersion !== request.draftVersion) {
    return false;
  }
  state.error = typeof error === "string" && error ? error : "unknown_error";
  return true;
}

export function loadModelPolicyState(state, policyValue) {
  const saved = normalizeModelPolicy(policyValue);
  state.saved = clonePolicy(saved);
  state.draftEnabledModels = saved ? normalizeModelRefs(saved.enabledModels) : [];
  state.draftActiveModel = saved ? cloneModelRef(saved.activeModel) : null;
  state.dirty = false;
  state.error = "";
  state.draftVersion += 1;
  return saved;
}

export function replaceModelPolicyDraft(state, enabledModels, activeModel) {
  const nextEnabledModels = normalizeModelRefs(enabledModels);
  const nextActiveModel = normalizeModelRef(activeModel);
  const currentFingerprint = modelPolicyFingerprint(state.draftEnabledModels, state.draftActiveModel);
  const nextFingerprint = modelPolicyFingerprint(nextEnabledModels, nextActiveModel);
  if (currentFingerprint === nextFingerprint) {
    state.dirty = isModelPolicyDirty(state);
    return false;
  }
  state.draftEnabledModels = nextEnabledModels;
  state.draftActiveModel = cloneModelRef(nextActiveModel);
  state.draftVersion += 1;
  state.dirty = isModelPolicyDirty(state);
  return true;
}

export function beginModelPolicySave(state) {
  if (state.saving) {
    return null;
  }
  const enabledModels = normalizeModelRefs(state.draftEnabledModels);
  const activeModel = normalizeModelRef(state.draftActiveModel);
  if (!activeModel || !enabledModels.some((entry) => modelRefsEqual(entry, activeModel))) {
    return null;
  }
  state.saving = true;
  state.error = "";
  state.saveRequestId += 1;
  return {
    requestId: state.saveRequestId,
    draftVersion: state.draftVersion,
    enabledModels,
    activeModel,
  };
}

export function completeModelPolicySave(state, submission, savedValue) {
  if (!submission || submission.requestId !== state.saveRequestId || !state.saving) {
    return false;
  }
  const saved = normalizeModelPolicy(savedValue);
  if (!saved) {
    state.saving = false;
    state.error = "invalid_model_policy_response";
    state.dirty = isModelPolicyDirty(state);
    return false;
  }
  state.saved = clonePolicy(saved);
  if (state.draftVersion === submission.draftVersion) {
    state.draftEnabledModels = normalizeModelRefs(saved.enabledModels);
    state.draftActiveModel = cloneModelRef(saved.activeModel);
  }
  state.saving = false;
  state.error = "";
  state.dirty = isModelPolicyDirty(state);
  return true;
}

export function failModelPolicySave(state, submission, error) {
  if (!submission || submission.requestId !== state.saveRequestId || !state.saving) {
    return false;
  }
  state.saving = false;
  state.error = typeof error === "string" && error ? error : "unknown_error";
  state.dirty = isModelPolicyDirty(state);
  return true;
}

export function createModelDiscoveryState() {
  return {
    credentialId: "",
    models: [],
    loading: false,
    error: "",
    requestId: 0,
  };
}

export function selectModelDiscoveryCredential(state, credentialId) {
  const nextCredentialId = typeof credentialId === "string" ? credentialId.trim() : "";
  state.requestId += 1;
  state.credentialId = nextCredentialId;
  state.models = [];
  state.loading = false;
  state.error = "";
}

export function beginModelDiscovery(state) {
  if (!state.credentialId) {
    return null;
  }
  state.requestId += 1;
  state.models = [];
  state.loading = true;
  state.error = "";
  return { requestId: state.requestId, credentialId: state.credentialId };
}

export function completeModelDiscovery(state, request, models) {
  if (
    !request ||
    request.requestId !== state.requestId ||
    request.credentialId !== state.credentialId ||
    !state.loading
  ) {
    return false;
  }
  state.models = Array.from(new Set(
    (Array.isArray(models) ? models : [])
      .filter((model) => typeof model === "string")
      .map((model) => model.trim())
      .filter(Boolean),
  ));
  state.loading = false;
  state.error = "";
  return true;
}

export function failModelDiscovery(state, request, error) {
  if (
    !request ||
    request.requestId !== state.requestId ||
    request.credentialId !== state.credentialId ||
    !state.loading
  ) {
    return false;
  }
  state.models = [];
  state.loading = false;
  state.error = typeof error === "string" && error ? error : "unknown_error";
  return true;
}
