import type { FoundationStorage } from "@/lib/foundation-storage";
import type { LiveEventGameRuntime } from "@/lib/live-event-game-runtime";
import type { TechnicalAdminAuth, TechnicalAdminStorageStatus } from "@/lib/technical-admin-auth";

/** The intentionally small dependency surface of the public health contract. */
export type PublicHealthDependencies = {
  foundationStorage: Pick<FoundationStorage, "readiness"> | undefined;
  technicalAdminAuth: Pick<TechnicalAdminAuth, "storageStatus">;
  /** The SQM-critical authoritative services that must remain available. */
  authoritativeServices: {
    eventAdministration: boolean;
    liveEventRuntime: Pick<LiveEventGameRuntime, "readiness"> | null;
  };
};

const PUBLIC_HEALTH_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * Render the sole public readiness signal. The body is deliberately a fixed two-value
 * representation, so readiness evidence and failure details cannot become a public oracle.
 */
export async function readPublicHealth(dependencies: PublicHealthDependencies): Promise<Response> {
  const healthy = await isPubliclyHealthy(dependencies);
  return new Response(healthy ? "healthy\n" : "unhealthy\n", {
    status: healthy ? 200 : 503,
    headers: PUBLIC_HEALTH_HEADERS,
  });
}

export function createPublicHealthRoute(dependencies: PublicHealthDependencies) {
  return {
    GET(_request: Request) {
      return readPublicHealth(dependencies);
    },
  };
}

export async function isPubliclyHealthy(dependencies: PublicHealthDependencies): Promise<boolean> {
  if (
    !dependencies.authoritativeServices.eventAdministration ||
    dependencies.authoritativeServices.liveEventRuntime === null
  ) {
    return false;
  }

  if (!(await isFoundationStorageHealthy(dependencies.authoritativeServices.liveEventRuntime))) {
    return false;
  }

  let technicalAdminStatus: TechnicalAdminStorageStatus;
  try {
    technicalAdminStatus = dependencies.technicalAdminAuth.storageStatus();
  } catch {
    return false;
  }
  if (technicalAdminStatus.state !== "ready") return false;

  if (dependencies.foundationStorage === undefined) return false;
  return isFoundationStorageHealthy(dependencies.foundationStorage);
}

async function isFoundationStorageHealthy(
  storage: Pick<FoundationStorage, "readiness">,
): Promise<boolean> {
  try {
    const readiness = await storage.readiness();
    if (!readiness.ok) return false;
    if (readiness.storage === "memory") return true;
    return readiness.evidence?.transaction.writePressure === "normal";
  } catch {
    return false;
  }
}
