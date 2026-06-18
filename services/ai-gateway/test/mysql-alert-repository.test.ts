import assert from "node:assert/strict";
import test from "node:test";

import { MySqlAlertRepository } from "../src/alerts/mysql-repository.js";
import type { AiGatewayDb } from "../src/db/index.js";

type HealthRow = {
  eventId: string;
  credentialId: string;
  reason: string | null;
  toState: string;
  occurredAt: Date;
};

type AuditRow = {
  alertId: string;
  actor: string | null;
  action: string;
  createdAt: Date;
};

function createAlertDb(input: {
  healthRows: HealthRow[];
  auditRows?: AuditRow[];
}) {
  return {
    select(selection: Record<string, unknown>) {
      if ("eventId" in selection) {
        return {
          from() {
            return {
              orderBy() {
                return {
                  async limit() {
                    return input.healthRows;
                  },
                };
              },
            };
          },
        };
      }

      if ("activeLeases" in selection) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  async groupBy() {
                    return [];
                  },
                };
              },
            };
          },
        };
      }

      return {
        from() {
          return {
            where() {
              return {
                async orderBy() {
                  return input.auditRows ?? [];
                },
              };
            },
          };
        },
      };
    },
  };
}

test("listAlerts resolves older credential fault alerts after a later healthy event", async () => {
  const repository = new MySqlAlertRepository(createAlertDb({
    healthRows: [
      {
        eventId: "health_recovered",
        credentialId: "cred_codex_1",
        reason: "admin_reconnect",
        toState: "healthy",
        occurredAt: new Date("2026-06-17T10:05:00.000Z"),
      },
      {
        eventId: "health_fault",
        credentialId: "cred_codex_1",
        reason: "codex_refresh_token_reused",
        toState: "unhealthy",
        occurredAt: new Date("2026-06-17T10:00:00.000Z"),
      },
    ],
    auditRows: [
      {
        alertId: "alert_health_fault",
        actor: "admin@example.test",
        action: "alert.acknowledge",
        createdAt: new Date("2026-06-17T10:01:00.000Z"),
      },
    ],
  }) as AiGatewayDb);

  const alerts = await repository.listAlerts();
  const faultAlert = alerts.find((alert) => alert.id === "alert_health_fault");
  const recoveredAlert = alerts.find((alert) => alert.id === "alert_health_recovered");

  assert.equal(faultAlert?.status, "resolved");
  assert.equal(faultAlert?.owner, null);
  assert.equal(recoveredAlert?.status, "resolved");
});
