import assert from "node:assert/strict";
import test from "node:test";

import { LeaseBroker, type BindingSelector } from "../src/leases/lease-broker.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  SessionLease,
} from "../src/leases/repository.js";
import type { UpstreamFailureKind } from "../src/leases/error-classifier.js";

class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leasesBySession = new Map<string, SessionLease>();
  private leaseIdCounter = 0;

  public createCalls = 0;
  public rebindCalls = 0;
  public lastRebindInput: RebindSessionLeaseInput | null = null;

  async getActiveLeaseBySessionId(sessionId: string): Promise<SessionLease | null> {
    return this.leasesBySession.get(sessionId) ?? null;
  }

  async createSessionLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const existing = this.leasesBySession.get(input.sessionId);
    if (existing) {
      return existing;
    }

    this.createCalls += 1;
    const created: SessionLease = {
      id: `lease_${++this.leaseIdCounter}`,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };
    this.leasesBySession.set(input.sessionId, created);
    return created;
  }

  async rebindSessionLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    this.rebindCalls += 1;
    this.lastRebindInput = input;

    const current = this.leasesBySession.get(input.sessionId);
    if (!current) {
      throw new Error(`lease_missing:${input.sessionId}`);
    }

    if (current.activeBindingId !== input.expectedCurrentBindingId) {
      return null;
    }

    const updated: SessionLease = { ...current, activeBindingId: input.nextBindingId };
    this.leasesBySession.set(input.sessionId, updated);
    return updated;
  }
}

function createSelector() {
  let initialCounter = 0;
  let replacementCounter = 1;

  const calls = {
    initial: 0,
    replacement: 0,
  };

  const selector: BindingSelector = {
    async selectInitialBinding() {
      calls.initial += 1;
      initialCounter += 1;
      return `binding_${initialCounter}`;
    },
    async selectReplacementBinding() {
      calls.replacement += 1;
      replacementCounter += 1;
      return `binding_${replacementCounter}`;
    },
  };

  return { selector, calls };
}

async function triggerFailure(
  broker: LeaseBroker,
  sessionId: string,
  currentBindingId: string,
  failureKind: UpstreamFailureKind,
) {
  return broker.handleFailure({
    sessionId,
    currentBindingId,
    failureKind,
  });
}

test("creates a lease for first session request", async () => {
  const repository = new InMemoryLeaseRepository();
  const { selector, calls } = createSelector();
  const broker = new LeaseBroker(repository, selector);

  const lease = await broker.getOrCreateActiveLease("session_a");

  assert.equal(lease.sessionId, "session_a");
  assert.equal(lease.activeBindingId, "binding_1");
  assert.equal(repository.createCalls, 1);
  assert.equal(calls.initial, 1);
});

test("single-flights parallel first session requests", async () => {
  const repository = new InMemoryLeaseRepository();
  const { selector, calls } = createSelector();
  const broker = new LeaseBroker(repository, {
    ...selector,
    async selectInitialBinding(input) {
      calls.initial += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `binding_initial_${input.sessionId}`;
    },
  });

  const leases = await Promise.all(
    Array.from({ length: 8 }, () => broker.getOrCreateActiveLease("session_parallel_first")),
  );

  assert.equal(repository.createCalls, 1);
  assert.equal(calls.initial, 1);
  assert.ok(leases.every((lease) => lease.id === leases[0]?.id));
  assert.ok(leases.every((lease) => lease.activeBindingId === "binding_initial_session_parallel_first"));
});

test("reuses the same binding for repeated session requests", async () => {
  const repository = new InMemoryLeaseRepository();
  const { selector, calls } = createSelector();
  const broker = new LeaseBroker(repository, selector);

  const first = await broker.getOrCreateActiveLease("session_b");
  const second = await broker.getOrCreateActiveLease("session_b");

  assert.equal(first.id, second.id);
  assert.equal(second.activeBindingId, "binding_1");
  assert.equal(repository.createCalls, 1);
  assert.equal(calls.initial, 1);
});

test("does not rebind on refreshable auth failure", async () => {
  const repository = new InMemoryLeaseRepository();
  const { selector } = createSelector();
  const broker = new LeaseBroker(repository, selector);

  const lease = await broker.getOrCreateActiveLease("session_c");
  const after = await triggerFailure(broker, "session_c", lease.activeBindingId, "refreshable_auth");

  assert.equal(after.activeBindingId, lease.activeBindingId);
  assert.equal(repository.rebindCalls, 0);
});

test("rebinds once on permanent credential failure", async () => {
  const repository = new InMemoryLeaseRepository();
  const { selector, calls } = createSelector();
  const broker = new LeaseBroker(repository, selector);

  const lease = await broker.getOrCreateActiveLease("session_d");
  const rebound = await triggerFailure(
    broker,
    "session_d",
    lease.activeBindingId,
    "permanent_credential",
  );

  assert.equal(repository.rebindCalls, 1);
  assert.equal(calls.replacement, 1);
  assert.equal(repository.lastRebindInput?.expectedCurrentBindingId, "binding_1");
  assert.equal(rebound.activeBindingId, "binding_2");
});

test("uses single-flight rebinding for parallel permanent failures", async () => {
  const repository = new InMemoryLeaseRepository();
  const { selector, calls } = createSelector();
  const broker = new LeaseBroker(repository, {
    ...selector,
    async selectReplacementBinding(input) {
      calls.replacement += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `binding_parallel_${input.previousBindingId}`;
    },
  });

  const lease = await broker.getOrCreateActiveLease("session_e");
  const failures = Array.from({ length: 8 }, () =>
    triggerFailure(broker, "session_e", lease.activeBindingId, "permanent_credential"),
  );

  const results = await Promise.all(failures);

  assert.equal(calls.replacement, 1);
  assert.equal(repository.rebindCalls, 1);
  assert.ok(results.every((item) => item.activeBindingId === "binding_parallel_binding_1"));
});

test("maps upstream failures through classifier in handleUpstreamFailure", async () => {
  const repository = new InMemoryLeaseRepository();
  const { selector } = createSelector();
  const broker = new LeaseBroker(repository, selector);

  const lease = await broker.getOrCreateActiveLease("session_classifier");

  const refreshable = await broker.handleUpstreamFailure({
    sessionId: "session_classifier",
    currentBindingId: lease.activeBindingId,
    failure: { statusCode: 401 },
  });

  assert.equal(refreshable.activeBindingId, lease.activeBindingId);
  assert.equal(repository.rebindCalls, 0);

  const permanent = await broker.handleUpstreamFailure({
    sessionId: "session_classifier",
    currentBindingId: lease.activeBindingId,
    failure: { code: "invalid_grant" },
  });

  assert.equal(repository.rebindCalls, 1);
  assert.equal(permanent.activeBindingId, "binding_2");
});
