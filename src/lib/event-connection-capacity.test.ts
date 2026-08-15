import { describe, expect, test } from "bun:test";
import { readEventConnectionCapacity } from "@/lib/event-connection-capacity";

describe("Event connection capacity configuration", () => {
  test("provides one sanitized envelope with a live Controller count", () => {
    let activeControllers = 1;
    const capacity = readEventConnectionCapacity(
      {
        EVENT_TOTAL_CONNECTION_CAPACITY: "610",
        EVENT_RESERVED_CONNECTION_CAPACITY: "3",
      },
      () => activeControllers,
    );

    expect(capacity.totalConnections).toBe(610);
    expect(capacity.reservedConnections).toBe(3);
    expect(capacity.activeControllerSessions()).toBe(1);
    activeControllers = 4;
    expect(capacity.activeControllerSessions()).toBe(4);
  });

  test("uses the accepted 502 total and 2 reserved defaults for invalid input", () => {
    const capacity = readEventConnectionCapacity(
      {
        EVENT_TOTAL_CONNECTION_CAPACITY: "invalid",
        EVENT_RESERVED_CONNECTION_CAPACITY: "-1",
      },
      () => 0,
    );
    expect(capacity).toMatchObject({ totalConnections: 502, reservedConnections: 2 });
  });
});
