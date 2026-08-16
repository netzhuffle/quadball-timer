import { describe, expect, test } from "bun:test";
import { createAdHocGamesService, createInMemoryAdHocStore } from "@/lib/ad-hoc-games";
import { createEventAdministration } from "@/lib/event-administration";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";
import { createGrantAuthority } from "@/lib/grant-authority";
import { createGrantTestAuthorityVerifier } from "@/lib/grant-authority-test-support";
import { createGrantTestKeyRing } from "@/lib/grant-authority-contract";
import {
  MemoryTechnicalAdminAuthRepository,
  createTechnicalAdminAuth,
} from "@/lib/technical-admin-auth";

function grantOptions() {
  return {
    environmentId: "test",
    clock: { nowMs: () => 1_000 },
    randomness: { bytes: (length: number) => new Uint8Array(length).fill(7) },
    keyRing: createGrantTestKeyRing(),
    controlScopeResolver: {
      resolve: () => ({ status: "unavailable" as const, detail: "scope unavailable" }),
    },
    privilegedAuthorityVerifier: createGrantTestAuthorityVerifier(),
  };
}

describe("public health operation boundaries", () => {
  test("keeps Event, Ad Hoc, and Grant operations fail-closed independently", async () => {
    const adHocStore = {
      ...createInMemoryAdHocStore(),
      createGame() {
        throw new Error("Ad Hoc storage unavailable");
      },
    };
    const adHoc = createAdHocGamesService({ store: adHocStore, now: () => 1_000 });
    expect(await adHoc.create({ homeName: "Home", awayName: "Away" })).toMatchObject({
      status: "rejected",
      reason: "unavailable",
    });

    const storage = createInMemoryFoundationStorage();
    const grants = createGrantAuthority(storage, grantOptions());
    const eventAdministration = createEventAdministration({ storage, grants });
    const technicalAdmin = createTechnicalAdminAuth(
      { environment: "test", origin: "https://timer.example", rpId: "timer.example" },
      new MemoryTechnicalAdminAuthRepository(),
    ).resolveHostLocalAuthority();
    storage.close();

    expect(
      await eventAdministration.createEventAdminGrant("event-unavailable", {
        ...technicalAdmin,
      }),
    ).toMatchObject({ status: "retryable-failure" });
    expect(
      await grants.createControlGrant({
        authority: { kind: "technical-admin", id: "test-admin" },
        scope: {
          eventId: "event-unavailable",
          gameDayId: "day-unavailable",
          pitchId: "pitch-unavailable",
          pitchSlotId: "slot-unavailable",
        },
      }),
    ).toMatchObject({ status: "rejected", reason: "unavailable" });
  });
});
