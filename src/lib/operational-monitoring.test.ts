import { describe, expect, test } from "bun:test";
import {
  OPERATIONAL_CATEGORIES,
  OPERATIONAL_PHASES,
  createOperationalMonitoringAdapter,
  type OperationalEvent,
} from "@/lib/operational-monitoring";

describe("operational monitoring adapter", () => {
  test("emits only fixed operational fields across every phase", async () => {
    const events: OperationalEvent[] = [];
    let sendStarted = false;
    const adapter = createOperationalMonitoringAdapter({
      enabled: true,
      now: () => 123,
      scheduleTimeout: (callback) => callback(),
      send: (event) => {
        sendStarted = true;
        events.push(event);
      },
    });

    for (const [index, phase] of OPERATIONAL_PHASES.entries()) {
      adapter.reportFailure({
        operation: "deployment",
        environment: "production",
        releaseAttempt: "sha-safe-run-1-attempt-1",
        phase,
        outcome: "failed",
        category: OPERATIONAL_CATEGORIES[index % OPERATIONAL_CATEGORIES.length] ?? "readiness",
        timestampMs: 123,
        error: "Bearer secret /var/lib/private stdout=do-not-send",
      } as never);
    }
    expect(sendStarted).toBe(false);
    await Promise.resolve();

    expect(events).toHaveLength(OPERATIONAL_PHASES.length);
    expect(events[0]).toEqual({
      operation: "deployment",
      environment: "production",
      releaseAttempt: "sha-safe-run-1-attempt-1",
      phase: "preflight",
      outcome: "failed",
      category: "backup-candidate",
      timestampMs: 123,
    });
    expect(JSON.stringify(events)).not.toContain("Bearer");
    expect(JSON.stringify(events)).not.toContain("/var/lib/private");

    adapter.reportFailure({
      operation: "deployment Bearer raw-secret" as never,
      environment: "production",
      releaseAttempt: "token=private",
      phase: "/var/lib/private" as never,
      outcome: "stdout=private" as never,
      category: "stderr=private" as never,
    });
    await Promise.resolve();
    expect(events.at(-1)).toEqual({
      operation: "deployment",
      environment: "production",
      phase: "readiness",
      outcome: "failed",
      category: "readiness",
      timestampMs: 123,
    });
  });

  test("reports an outage without retrying or delaying the operation", async () => {
    let sends = 0;
    const deliveries: string[] = [];
    const adapter = createOperationalMonitoringAdapter({
      enabled: true,
      timeoutMs: 10,
      scheduleTimeout: (callback) => callback(),
      send: async () => {
        sends += 1;
        throw new Error("monitoring outage");
      },
      onDelivery: (delivery) => deliveries.push(delivery),
    });

    adapter.reportFailure({
      operation: "restore",
      environment: "production",
      phase: "staged-restore",
      outcome: "failed",
      category: "technical-admin-auth-sanitization",
    });
    expect(deliveries).toEqual([]);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(sends).toBe(1);
    expect(deliveries).toEqual(["failed"]);
  });

  test("awaits one bounded reporter delivery and returns its truthful status", async () => {
    let sends = 0;
    const deliveries: string[] = [];
    const adapter = createOperationalMonitoringAdapter({
      enabled: true,
      scheduleTimeout: () => {},
      send: async (event) => {
        sends += 1;
        expect(event).toEqual({
          operation: "readiness",
          environment: "test",
          releaseAttempt: "sha-readiness-run-1-attempt-1",
          phase: "readiness",
          outcome: "failed",
          category: "key-version",
          timestampMs: 321,
        });
        return true;
      },
      onDelivery: (delivery) => deliveries.push(delivery),
    });

    const delivery = await adapter.deliverFailure({
      operation: "readiness",
      environment: "test",
      releaseAttempt: "sha-readiness-run-1-attempt-1",
      phase: "readiness",
      outcome: "failed",
      category: "key-version",
      timestampMs: 321,
      message: "secret-bearing failure /var/lib/private token=secret",
    } as never);

    expect(delivery).toBe("sent");
    expect(sends).toBe(1);
    expect(deliveries).toEqual(["sent"]);
  });

  test("surfaces a failed reporter attempt without retrying it", async () => {
    let sends = 0;
    const adapter = createOperationalMonitoringAdapter({
      enabled: true,
      scheduleTimeout: () => {},
      send: () => {
        sends += 1;
        return false;
      },
    });

    const delivery = await adapter.deliverFailure({
      operation: "backup",
      environment: "production",
      phase: "backup-verify",
      outcome: "failed",
      category: "backup-candidate",
    });
    expect(delivery).toBe("failed");
    expect(sends).toBe(1);
  });

  test("does not retry the underlying operation when monitoring fails", async () => {
    let operationRuns = 0;
    let monitoringCalls = 0;
    const events: OperationalEvent[] = [];
    const deliveries: string[] = [];
    const adapter = createOperationalMonitoringAdapter({
      enabled: true,
      scheduleTimeout: (callback) => callback(),
      send: (event) => {
        monitoringCalls += 1;
        events.push(event);
        throw new Error("secret-bearing operation failure /var/lib/private token=secret");
      },
      onDelivery: (delivery) => deliveries.push(delivery),
    });

    const runOperation = () => {
      operationRuns += 1;
      return "failed" as const;
    };
    const operations = [
      [
        "deployment",
        "production",
        "sha-deployment-run-1-attempt-0",
        "preflight",
        "atomic-install",
        "failed",
      ],
      [
        "deployment",
        "test",
        "sha-deployment-run-1-attempt-0-test",
        "quiesce-stop",
        "atomic-install",
        "failed",
      ],
      [
        "deployment",
        "production",
        "sha-deployment-run-1-attempt-1",
        "release-switch",
        "atomic-install",
        "failed",
      ],
      [
        "backup",
        "production",
        "sha-backup-run-1-attempt-1",
        "backup-create",
        "backup-candidate",
        "failed",
      ],
      [
        "backup",
        "production",
        "sha-backup-run-1-attempt-2",
        "backup-verify",
        "backup-candidate",
        "failed",
      ],
      [
        "backup",
        "production",
        "sha-backup-run-1-attempt-3",
        "backup-promote",
        "backup-candidate",
        "failed",
      ],
      [
        "migration",
        "production",
        "sha-migration-run-1-attempt-1",
        "candidate-validation",
        "schema-incompatibility",
        "incompatible",
      ],
      [
        "migration",
        "test",
        "sha-migration-run-1-attempt-2",
        "live-migration",
        "migration-candidate",
        "failed",
      ],
      [
        "restore",
        "production",
        "sha-restore-run-1-attempt-1",
        "staged-restore",
        "technical-admin-auth-sanitization",
        "failed",
      ],
      [
        "restore",
        "production",
        "sha-restore-run-1-attempt-2",
        "staged-restore",
        "re-enrollment-required",
        "degraded",
      ],
      ["readiness", "test", "sha-readiness-run-1-attempt-1", "startup", "key-version", "failed"],
      [
        "readiness",
        "production",
        "sha-readiness-run-1-attempt-2",
        "readiness",
        "readiness",
        "failed",
      ],
      [
        "deployment",
        "production",
        "sha-deployment-run-1-attempt-2",
        "rollback-restart",
        "binary-rollback",
        "failed",
      ],
      [
        "deployment",
        "test",
        "sha-deployment-run-1-attempt-3",
        "final-report",
        "atomic-install",
        "failed",
      ],
    ] as const;
    const results = operations.map(
      ([operation, environment, releaseAttempt, phase, category, outcome]) => {
        const result = runOperation();
        adapter.reportFailure({
          operation,
          environment,
          releaseAttempt,
          phase,
          outcome,
          category,
        });
        return result;
      },
    );
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(results).toEqual(operations.map(() => "failed"));
    expect(operationRuns).toBe(operations.length);
    expect(monitoringCalls).toBe(operations.length);
    expect(deliveries).toEqual(operations.map(() => "failed"));
    expect(events).toEqual(
      operations.map(([operation, environment, releaseAttempt, phase, category, outcome]) => ({
        operation,
        environment,
        releaseAttempt,
        phase,
        outcome,
        category,
        timestampMs: expect.any(Number),
      })),
    );
    expect(JSON.stringify(events)).not.toContain("secret-bearing");
    expect(JSON.stringify(events)).not.toContain("/var/lib/private");
    expect(JSON.stringify(events)).not.toContain("token=secret");
    expect(new Set(events.map(({ phase }) => phase))).toEqual(new Set(OPERATIONAL_PHASES));
  });

  test("marks an unavailable transport without invoking an operation", () => {
    const deliveries: string[] = [];
    const adapter = createOperationalMonitoringAdapter({
      enabled: false,
      onDelivery: (delivery) => deliveries.push(delivery),
    });

    adapter.reportFailure({
      operation: "readiness",
      environment: "test",
      phase: "readiness",
      outcome: "unavailable",
      category: "readiness",
    });

    expect(deliveries).toEqual(["unavailable"]);
  });
});
