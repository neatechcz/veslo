import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAdminService } from "../src/http/admin.js";

test("DEN-owned admin mutations never create duplicate Gateway audit rows", async () => {
  let gatewayAuditWrites = 0;
  const user = {
    id: "user_1",
    name: "User One",
    email: "user@example.test",
    emailVerified: true,
    platformAdmin: false,
    disabled: false,
    memberships: [],
  };
  const organization = { id: "org_1", name: "Acme", slug: "acme", ownerUserId: "user_1", seatLimit: 10 };
  const service = createDefaultAdminService("https://den.example.test", {
    denClient: {
      async createUser() { return user; },
      async updateUser() { return user; },
      async disableUser() { return { ...user, disabled: true }; },
      async enableUser() { return user; },
      async deleteUser() {},
      async updateOrganization() { return { organization }; },
      async createOrganizationBillingCheckout() { return { status: 200, body: {} }; },
      async createOrganizationBillingPortal() { return { status: 200, body: {} }; },
      async updateOrganizationBillingPlan() { return { status: 200, body: {} }; },
      async cancelOrganizationBilling() { return { status: 200, body: {} }; },
      async updatePlatformOrganizationBilling() { return { status: 200, body: {} }; },
      async createOrganizationMember() { return { member: { membershipId: "member_1" } }; },
      async updateOrganizationMember() { return { member: { membershipId: "member_1" } }; },
      async deleteOrganizationMember() {},
      async createOrganizationDomain() { return { domain: { id: "domain_1" } }; },
      async updateOrganizationDomain() { return { domain: { id: "domain_1" } }; },
      async deleteOrganizationDomain() {},
      async createOrganizationInvite() { return { invite: { id: "invite_1" } }; },
      async resendOrganizationInvite() { return { invite: { id: "invite_1" } }; },
      async revokeOrganizationInvite() { return { invite: { id: "invite_1" } }; },
    } as never,
    auditRepository: {
      async recordEvent() { gatewayAuditWrites += 1; },
    },
  });

  await service.createUser("token", { email: user.email, name: user.name, platformAdmin: false, orgId: "org_1", orgRole: "member" });
  await service.updateUser("token", user.id, { name: user.name, email: user.email, platformAdmin: false, orgId: "org_1", orgRole: "member" });
  await service.disableUser("token", user.id);
  await service.enableUser("token", user.id);
  await service.deleteUser("token", user.id);
  await service.updateOrganization("token", "org_1", { name: "Acme" });
  await service.createOrganizationBillingCheckout!("token", "org_1", {});
  await service.createOrganizationBillingPortal!("token", "org_1", {});
  await service.updateOrganizationBillingPlan!("token", "org_1", {});
  await service.cancelOrganizationBilling!("token", "org_1", {});
  await service.updatePlatformOrganizationBilling!("token", "org_1", {});
  await service.createOrganizationMember("token", "org_1", { userId: user.id, role: "member" });
  await service.updateOrganizationMember("token", "org_1", "member_1", { role: "organization_admin" });
  await service.deleteOrganizationMember("token", "org_1", "member_1");
  await service.createOrganizationDomain("token", "org_1", { domain: "example.test", enabled: true, selfSignupEnabled: false });
  await service.updateOrganizationDomain("token", "org_1", "domain_1", { enabled: false });
  await service.deleteOrganizationDomain("token", "org_1", "domain_1");
  await service.createOrganizationInvite("token", "org_1", { email: "invite@example.test", role: "member" });
  await service.resendOrganizationInvite("token", "org_1", "invite_1");
  await service.revokeOrganizationInvite("token", "org_1", "invite_1");

  assert.equal(gatewayAuditWrites, 0);
});
