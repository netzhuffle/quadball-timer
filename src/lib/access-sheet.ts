import QRCode from "qrcode";
import type {
  FoundationStorageTransaction,
  EventCatalogAuditEntry,
} from "@/lib/foundation-storage";
import { projectExpectedStartMs, type EventGame, type PitchSlot } from "@/lib/event-catalog";
import type { GrantManagementAuthority, TypedGrantAuthority } from "@/lib/grant-management";
import {
  EVENT_ADMIN_GRANT_TYPE,
  GRANT_TYPE,
  PITCH_MANAGER_GRANT_TYPE,
  type StoredGrant,
} from "@/lib/grant-types";

export type AccessSheetType = "event-admin" | "pitch-manager" | "control-grant";

export type AccessSheetScope = {
  eventId: string;
  gameDayId?: string;
  pitchId?: string;
};

export type AccessSheetRequest = {
  type: AccessSheetType;
  scope: AccessSheetScope;
};

export type AccessSheetVersion = {
  versionId: string;
  environmentId: string;
  type: AccessSheetType;
  scope: AccessSheetScope;
  generatedAtMs: number;
  testMark: boolean;
};

export type AccessSheetArtifact = {
  contentType: "text/html";
  body: string;
  version: AccessSheetVersion;
};

export type AccessSheetRejectedReason = "invalid-input" | "not-found" | "unauthorized";

export type AccessSheetOutcome =
  | { status: "accepted"; value: AccessSheetArtifact }
  | { status: "rejected"; reason: AccessSheetRejectedReason; detail: string }
  | { status: "retryable-failure"; detail: string };

export type AccessSheetIds = {
  next(kind: "version" | "audit" | "operation"): string;
};

export type AccessSheetRendererInput = {
  version: AccessSheetVersion;
  title: string;
  entries: readonly AccessSheetEntry[];
};

export type AccessSheetEntry = {
  label: string;
  qrCredential: string;
  game?: AccessSheetGameSnapshot | null;
};

export type AccessSheetGameSnapshot = {
  scheduledStartMs: number;
  expectedStartMs: number;
  sideA: string | null;
  sideB: string | null;
  gameCode: string | null;
  gameDesignation: string | null;
};

export type AccessSheetRenderer = {
  render(input: AccessSheetRendererInput): { contentType: "text/html"; body: string };
};

export type AccessSheetOptions = {
  environmentId: string;
  nowMs: () => number;
  grants: TypedGrantAuthority;
  authority: GrantManagementAuthority;
  renderer?: AccessSheetRenderer;
  ids?: AccessSheetIds;
};

const DEFAULT_IDS: AccessSheetIds = {
  next: (kind) => `access-sheet-${kind}-${crypto.randomUUID()}`,
};

export const ACCESS_SHEET_AUDIT_ACTION: EventCatalogAuditEntry["action"] = "access-sheet-generated";

export function createPrintableAccessSheetRenderer(): AccessSheetRenderer {
  return { render: renderPrintableAccessSheet };
}

export function generateAccessSheetInTransaction(
  transaction: FoundationStorageTransaction,
  request: AccessSheetRequest,
  actorReference: string,
  options: AccessSheetOptions,
): AccessSheetOutcome {
  const requestError = validateRequest(request);
  if (requestError !== null) return requestError;
  const event = transaction.findEvent(request.scope.eventId);
  if (event === null) return rejected("not-found", "Event was not found.");
  const nowMs = options.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    return rejected("invalid-input", "Generation time is invalid.");
  const version: AccessSheetVersion = {
    versionId: (options.ids ?? DEFAULT_IDS).next("version"),
    environmentId: options.environmentId,
    type: request.type,
    scope: { ...request.scope },
    generatedAtMs: nowMs,
    testMark: options.environmentId !== "production",
  };
  const entries = readEntries(transaction, request, options);
  if (!entries.ok) return entries.outcome;
  const renderer = options.renderer ?? createPrintableAccessSheetRenderer();
  const rendered = renderer.render({
    version,
    title: titleFor(request.type, event.name),
    entries: entries.value,
  });
  const ids = options.ids ?? DEFAULT_IDS;
  transaction.appendEventAudit({
    auditId: ids.next("audit"),
    operationId: ids.next("operation"),
    action: ACCESS_SHEET_AUDIT_ACTION,
    eventId: event.eventId,
    gameDayId: request.scope.gameDayId ?? null,
    actorReference,
    occurredAtMs: nowMs,
    before: null,
    after: {
      versionId: version.versionId,
      environmentId: version.environmentId,
      type: version.type,
      scope: version.scope,
      generatedAtMs: version.generatedAtMs,
      testMark: version.testMark,
    },
  });
  return {
    status: "accepted",
    value: { contentType: rendered.contentType, body: rendered.body, version },
  };
}

function readEntries(
  transaction: FoundationStorageTransaction,
  request: AccessSheetRequest,
  options: AccessSheetOptions,
): { ok: true; value: AccessSheetEntry[] } | { ok: false; outcome: AccessSheetOutcome } {
  const { grants, authority } = options;
  if (request.type === "event-admin") {
    const grant = findGrant(transaction, EVENT_ADMIN_GRANT_TYPE, request.scope.eventId);
    if (grant === null) return missingGrant();
    const credential = reveal(grants, transaction, grant, authority);
    return credential === null
      ? missingGrant()
      : { ok: true, value: [{ label: "Event Admin Grant", qrCredential: credential }] };
  }
  if (request.type === "pitch-manager") {
    const days = transaction
      .listGameDays(request.scope.eventId)
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) || left.gameDayId.localeCompare(right.gameDayId),
      );
    const pitches = transaction
      .listPitches(request.scope.eventId)
      .sort((left, right) => left.pitchId.localeCompare(right.pitchId));
    const entries: AccessSheetEntry[] = [];
    for (const day of days) {
      for (const pitch of pitches) {
        const grant = findGrant(transaction, PITCH_MANAGER_GRANT_TYPE, {
          eventId: request.scope.eventId,
          gameDayId: day.gameDayId,
          pitchId: pitch.pitchId,
        });
        if (grant === null) return missingGrant();
        const credential = reveal(grants, transaction, grant, authority);
        if (credential === null) return missingGrant();
        entries.push({ label: `${pitch.name} · ${day.date}`, qrCredential: credential });
      }
    }
    return { ok: true, value: entries };
  }
  const day = transaction
    .listGameDays(request.scope.eventId)
    .find((candidate) => candidate.gameDayId === request.scope.gameDayId);
  const pitch = transaction.findPitch(request.scope.pitchId ?? "");
  if (day === undefined || pitch === null)
    return { ok: false, outcome: rejected("not-found", "Pitch scope was not found.") };
  const pitchSlots = transaction
    .listPitchSlots(day.gameDayId, pitch.pitchId)
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.pitchSlotId.localeCompare(right.pitchSlotId),
    );
  const games = transaction.listEventGames(day.gameDayId);
  const entries: AccessSheetEntry[] = [];
  for (const pitchSlot of pitchSlots) {
    const grant = findGrant(transaction, GRANT_TYPE, {
      eventId: request.scope.eventId,
      gameDayId: day.gameDayId,
      pitchId: pitch.pitchId,
      pitchSlotId: pitchSlot.pitchSlotId,
    });
    if (grant === null) return missingGrant();
    const credential = reveal(grants, transaction, grant, authority);
    if (credential === null) return missingGrant();
    entries.push({
      label: `${pitch.name} · Pitch Slot ${pitchSlot.sequence}`,
      qrCredential: credential,
      game: readGameSnapshot(transaction, pitchSlot, games),
    });
  }
  return { ok: true, value: entries };
}

function readGameSnapshot(
  transaction: FoundationStorageTransaction,
  pitchSlot: PitchSlot,
  games: readonly EventGame[],
): AccessSheetGameSnapshot | null {
  const game = games.find((candidate) => candidate.pitchSlotId === pitchSlot.pitchSlotId);
  if (game === undefined) return null;
  const gameplaySlot = transaction.findGameplaySlot(game.gameplaySlotId);
  if (gameplaySlot === null) return null;
  return {
    scheduledStartMs: gameplaySlot.scheduledStartMs,
    expectedStartMs: projectExpectedStartMs(gameplaySlot, pitchSlot),
    sideA: game.sideA.eventTeamName,
    sideB: game.sideB.eventTeamName,
    gameCode: game.gameCode,
    gameDesignation: game.gameDesignation,
  };
}

function findGrant(
  transaction: FoundationStorageTransaction,
  grantType: typeof EVENT_ADMIN_GRANT_TYPE | typeof PITCH_MANAGER_GRANT_TYPE | typeof GRANT_TYPE,
  scope: string | { eventId: string; gameDayId: string; pitchId: string; pitchSlotId?: string },
): StoredGrant | null {
  const grants = transaction.listGrants().filter((grant) => {
    if (grant.grantType !== grantType || grant.status !== "active") return false;
    if (typeof scope === "string") return grant.scope.eventId === scope;
    return Object.entries(scope).every(
      ([key, value]) => (grant.scope as Record<string, unknown>)[key] === value,
    );
  });
  return grants.sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null;
}

function reveal(
  grants: TypedGrantAuthority,
  transaction: FoundationStorageTransaction,
  grant: StoredGrant,
  authority: GrantManagementAuthority,
): string | null {
  const result = grants.resolveAccessSheetQrCredentialInTransaction(transaction, {
    grantId: grant.grantId,
    grantType: grant.grantType,
    scope: grant.scope,
    authority,
  });
  return result.status === "resolved" ? result.qrCredential : null;
}

function validateRequest(request: AccessSheetRequest): AccessSheetOutcome | null {
  if (!isType(request.type) || !isScope(request.scope))
    return rejected("invalid-input", "Access Sheet scope is invalid.");
  if (
    request.type === "event-admin" &&
    (request.scope.gameDayId !== undefined || request.scope.pitchId !== undefined)
  )
    return rejected("invalid-input", "Event Admin sheets cannot include Pitch scope.");
  if (
    request.type === "pitch-manager" &&
    (request.scope.gameDayId !== undefined || request.scope.pitchId !== undefined)
  )
    return rejected("invalid-input", "Pitch Manager sheets cover the whole Event.");
  if (
    request.type === "control-grant" &&
    (request.scope.gameDayId === undefined || request.scope.pitchId === undefined)
  )
    return rejected("invalid-input", "Control sheets require one Game Day and Pitch.");
  return null;
}

function renderPrintableAccessSheet(input: AccessSheetRendererInput): {
  contentType: "text/html";
  body: string;
} {
  const marker = input.version.testMark
    ? '<p class="test-mark" aria-label="Test environment">TEST ENVIRONMENT</p>'
    : "";
  const entries = input.entries
    .map((entry, index) => {
      const game = entry.game === undefined ? "" : renderGameSnapshot(entry.game);
      const headingId = `access-sheet-entry-${index + 1}-title`;
      return `<section class="entry" aria-labelledby="${headingId}"><h2 id="${headingId}">${escapeHtml(entry.label)}</h2>${renderQrSvg(entry.qrCredential)}${game}</section>`;
    })
    .join("\n");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>@page{margin:1rem}*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{font-family:system-ui,sans-serif;margin:1rem;color:#111;overflow-wrap:anywhere;word-break:break-word}.sheet{width:100%;max-width:52rem;margin:auto}.test-mark{border:.25rem solid #b91c1c;color:#b91c1c;font-size:1.5rem;font-weight:800;padding:.75rem;text-align:center}.version{font-size:.8rem;color:#555}.entries{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr));gap:1rem}.entry{break-inside:avoid;border:1px solid #aaa;padding:1rem;text-align:center;min-width:0}.qr{width:12rem;height:12rem;max-width:100%}.snapshot{font-size:.85rem;text-align:left}.snapshot dt{font-weight:700}.snapshot dd{margin:0 0 .25rem}@media print{body{margin:0}.entry{border:0;page-break-inside:avoid}.test-mark{break-inside:avoid}}</style></head><body><main class="sheet" aria-labelledby="access-sheet-title"><h1 id="access-sheet-title">${escapeHtml(input.title)}</h1>${marker}<p class="version">Access Sheet Version ${escapeHtml(input.version.versionId)} · ${escapeHtml(input.version.environmentId)} · ${escapeHtml(input.version.type)} · scope ${escapeHtml(JSON.stringify(input.version.scope))} · generated ${new Date(input.version.generatedAtMs).toISOString()}</p><div class="entries" aria-label="Access Sheet credentials">${entries}</div></main></body></html>`;
  return { contentType: "text/html", body };
}

function renderGameSnapshot(game: AccessSheetGameSnapshot | null): string {
  if (game === null) return "";
  return `<dl class="snapshot"><dt>Scheduled start</dt><dd>${escapeHtml(new Date(game.scheduledStartMs).toISOString())}</dd><dt>Expected start</dt><dd>${escapeHtml(new Date(game.expectedStartMs).toISOString())}</dd><dt>Teams</dt><dd>${escapeHtml(game.sideA ?? "TBD")} vs ${escapeHtml(game.sideB ?? "TBD")}</dd>${optionalSnapshot("Game code", game.gameCode)}${optionalSnapshot("Game designation", game.gameDesignation)}</dl>`;
}

function optionalSnapshot(label: string, value: string | null): string {
  return value === null ? "" : `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function renderQrSvg(value: string): string {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const cells: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (qr.modules.data[y * size + x]) cells.push(`M${x},${y}h1v1H${x}z`);
    }
  }
  return `<svg class="qr" role="img" aria-label="QR credential" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="${cells.join("")}"/></svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

function isType(value: unknown): value is AccessSheetType {
  return value === "event-admin" || value === "pitch-manager" || value === "control-grant";
}

function isScope(value: unknown): value is AccessSheetScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope.eventId === "string" &&
    scope.eventId.length > 0 &&
    (scope.gameDayId === undefined || typeof scope.gameDayId === "string") &&
    (scope.pitchId === undefined || typeof scope.pitchId === "string")
  );
}

function titleFor(type: AccessSheetType, eventName: string): string {
  if (type === "event-admin") return `${eventName} · Event Admin Access Sheet`;
  if (type === "pitch-manager") return `${eventName} · Pitch Manager Access Sheet`;
  return `${eventName} · Control Grant Access Sheet`;
}

function missingGrant(): { ok: false; outcome: AccessSheetOutcome } {
  return {
    ok: false,
    outcome: rejected("not-found", "A current QR Grant is not available for this sheet."),
  };
}

function rejected(reason: AccessSheetRejectedReason, detail: string): AccessSheetOutcome {
  return { status: "rejected", reason, detail };
}
