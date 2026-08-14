import {
  canonicalizeEventGameRecordRoot,
  cloneEventGameRecordRoot,
  validateEventGameRecordRoot,
  type EventGameRecordRoot,
} from "@/lib/foundation-record-types";
import { computeGrantAuditIntegrityTag } from "@/lib/grant-crypto";
import {
  cloneStoredGrant,
  cloneStoredGrantAuditEntry,
  cloneStoredGrantSession,
  type GrantKeyRing,
  type ControlGrantScope,
  type StoredGrant,
  type StoredGrantAuditEntry,
  type StoredGrantSession,
} from "@/lib/grant-types";
import {
  FoundationStorageClosedError,
  FoundationStorageConstraintError,
  FoundationStorageNotReadyError,
  type FoundationStorage,
  type FoundationStorageReadiness,
  type FoundationStorageTransaction,
  type FoundationStorageTransactionWork,
  type StoredControlAction,
  type StoredControlAuditEntry,
  type StoredControlIdempotencyEntry,
  type StoredEventGameRecordMetadata,
  type StoredEventGameRecordRoot,
  isThenable,
  DURABLE_EVIDENCE_PROVENANCE,
} from "@/lib/foundation-storage";
import {
  CONTROL_AUDIT_VERSION,
  CONTROL_ACTION_VERSION,
  LEGACY_CONTROL_AUDIT_VERSION,
  LEGACY_CONTROL_ACTION_VERSION,
  actionIdentity,
  parseStoredControlAction,
} from "@/lib/event-game-actions";
import { validateGrantState, type GrantStateValidationContext } from "@/lib/grant-state-validation";

type MemoryState = {
  roots: Map<string, StoredEventGameRecordRoot>;
  actions: Map<string, Map<string, StoredControlAction>>;
  idempotency: Map<string, Map<string, StoredControlIdempotencyEntry>>;
  metadata: Map<string, StoredEventGameRecordMetadata>;
  controlAudits: Map<string, Map<string, StoredControlAuditEntry>>;
  actionProvenance: Map<string, Map<string, "current" | "legacy">>;
  auditProvenance: Map<string, Map<string, "current" | "legacy">>;
  grants: Map<string, StoredGrant>;
  sessions: Map<string, StoredGrantSession>;
  grantAudits: Map<string, StoredGrantAuditEntry>;
  grantAuditProvenance: Map<string, StoredGrantAuditEntry>;
  grantAuditIntegrityTags: Map<string, string>;
};

export function createInMemoryFoundationStorage(): FoundationStorage {
  return new InMemoryFoundationStorage();
}

class InMemoryFoundationStorage implements FoundationStorage {
  private readonly state: MemoryState = {
    roots: new Map(),
    actions: new Map(),
    idempotency: new Map(),
    metadata: new Map(),
    controlAudits: new Map(),
    actionProvenance: new Map(),
    auditProvenance: new Map(),
    grants: new Map(),
    sessions: new Map(),
    grantAudits: new Map(),
    grantAuditProvenance: new Map(),
    grantAuditIntegrityTags: new Map(),
  };
  private writerTail: Promise<void> = Promise.resolve();
  private closed = false;
  private revision = 0;
  private grantValidationContext: GrantStateValidationContext = {};

  transaction<T>(work: FoundationStorageTransactionWork<T>): Promise<T> {
    const operation = this.writerTail.then(() => {
      this.assertOpen();
      const grantFailure = this.grantStateFailure();
      if (grantFailure !== null) {
        throw new FoundationStorageNotReadyError({
          ok: false,
          status: "integrity-failure",
          detail: grantFailure,
          storage: "memory",
        });
      }
      const undo: (() => void)[] = [];
      try {
        const result = work(
          createTransaction(this.state, undo, this.revision, this.grantValidationContext.keyRing),
        );
        if (isThenable(result)) {
          throw new TypeError("Foundation storage transactions must complete synchronously.");
        }
        this.revision += 1;
        return result;
      } catch (error) {
        for (const revert of undo.reverse()) revert();
        throw error;
      }
    });
    this.writerTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  readRoot(recordId: string): Promise<EventGameRecordRoot | null> {
    return this.writerTail.then(() => {
      this.assertOpen();
      const stored = this.state.roots.get(recordId);
      return stored === undefined ? null : cloneEventGameRecordRoot(stored.root);
    });
  }

  readActions(recordId: string): Promise<StoredControlAction[]> {
    return this.writerTail.then(() => {
      this.assertOpen();
      return cloneActions(
        this.state.actions.get(recordId),
        this.state.actionProvenance.get(recordId),
      );
    });
  }

  readRecordMetadata(recordId: string): Promise<StoredEventGameRecordMetadata | null> {
    return this.writerTail.then(() => {
      this.assertOpen();
      const metadata = this.state.metadata.get(recordId);
      return metadata === undefined ? null : structuredClone(metadata);
    });
  }

  readIdempotencyEntries(recordId: string): Promise<StoredControlIdempotencyEntry[]> {
    return this.writerTail.then(() => {
      this.assertOpen();
      return [...(this.state.idempotency.get(recordId)?.values() ?? [])].map((entry) =>
        structuredClone(entry),
      );
    });
  }

  readAuditEntries(recordId: string): Promise<StoredControlAuditEntry[]> {
    return this.writerTail.then(() => {
      this.assertOpen();
      return cloneAudits(
        this.state.controlAudits.get(recordId),
        this.state.auditProvenance.get(recordId),
      );
    });
  }

  readiness(): Promise<FoundationStorageReadiness> {
    return this.writerTail.then(() => {
      if (this.closed) {
        return {
          ok: false,
          status: "closed",
          detail: "In-memory foundation storage is closed.",
          storage: "memory",
        } satisfies FoundationStorageReadiness;
      }
      for (const stored of this.state.roots.values()) {
        const validated = validateEventGameRecordRoot(stored.root);
        if (
          !validated.ok ||
          canonicalizeEventGameRecordRoot(validated.value) !== stored.canonicalContent
        ) {
          return {
            ok: false,
            status: "integrity-failure",
            detail: "An in-memory Event Game Record root failed semantic validation.",
            storage: "memory",
          } satisfies FoundationStorageReadiness;
        }
      }
      for (const [recordId, actions] of this.state.actions) {
        for (const stored of actions.values()) {
          if (!parseStoredControlAction(stored.action).ok) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "An in-memory Control Action failed structural validation.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
          const provenance = this.state.actionProvenance
            .get(recordId)
            ?.get(stored.action.operationId);
          if (provenance !== "current" && provenance !== "legacy") {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "In-memory evidence provenance is missing.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
          if (
            provenance === "current" &&
            stored.action.controlActionVersion !== CONTROL_ACTION_VERSION
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "Current in-memory action evidence was downgraded.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
          if (
            provenance === "legacy" &&
            stored.action.controlActionVersion !== LEGACY_CONTROL_ACTION_VERSION
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "Legacy in-memory action evidence is inconsistent.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
        }
      }
      for (const [recordId, actions] of this.state.actions) {
        const idempotency = this.state.idempotency.get(recordId);
        if (idempotency === undefined || idempotency.size !== actions.size) {
          return {
            ok: false,
            status: "integrity-failure",
            detail: "In-memory action and idempotency state is inconsistent.",
            storage: "memory",
          } satisfies FoundationStorageReadiness;
        }
        for (const stored of actions.values()) {
          const expectedId = actionIdentity(stored.action.recordId, stored.action.operationId);
          const entry = idempotency.get(expectedId);
          if (
            entry === undefined ||
            entry.actionId !== expectedId ||
            entry.recordId !== stored.action.recordId ||
            entry.operationId !== stored.action.operationId ||
            entry.contentFingerprint !== stored.contentFingerprint ||
            entry.acceptedAtMs !== stored.action.acceptedAtMs
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "In-memory action and idempotency state is inconsistent.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
        }
      }
      for (const [recordId, audits] of this.state.controlAudits) {
        for (const entry of audits.values()) {
          const provenance = this.state.auditProvenance.get(recordId)?.get(entry.auditId);
          if (
            (provenance === "current" && entry.auditVersion !== CONTROL_AUDIT_VERSION) ||
            (provenance === "legacy" && entry.auditVersion !== LEGACY_CONTROL_AUDIT_VERSION)
          ) {
            return {
              ok: false,
              status: "integrity-failure",
              detail: "In-memory audit evidence format is inconsistent.",
              storage: "memory",
            } satisfies FoundationStorageReadiness;
          }
        }
      }
      for (const [recordId, entries] of this.state.idempotency) {
        if (!this.state.actions.has(recordId) && entries.size > 0) {
          return {
            ok: false,
            status: "integrity-failure",
            detail: "In-memory idempotency state has entries without actions.",
            storage: "memory",
          } satisfies FoundationStorageReadiness;
        }
      }
      const grantFailure = this.grantStateFailure();
      if (grantFailure !== null) {
        return {
          ok: false,
          status: "integrity-failure",
          detail: grantFailure,
          storage: "memory",
        } satisfies FoundationStorageReadiness;
      }
      return {
        ok: true,
        schemaVersion: "memory",
        storage: "memory",
      } satisfies FoundationStorageReadiness;
    });
  }

  close(): void {
    this.closed = true;
  }

  setGrantKeyRing(keyRing: GrantKeyRing): void {
    this.grantValidationContext = { ...this.grantValidationContext, keyRing };
  }

  setGrantValidationContext(context: GrantStateValidationContext): void {
    this.grantValidationContext = {
      ...this.grantValidationContext,
      ...context,
      ...(context.migrationProvenance === undefined
        ? {}
        : { migrationProvenance: new Map(context.migrationProvenance) }),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new FoundationStorageClosedError();
  }

  private grantStateFailure(): string | null {
    return validateGrantState(
      this.state.grants.values(),
      this.state.sessions.values(),
      this.state.grantAudits.values(),
      {
        ...this.grantValidationContext,
        auditProvenance: this.state.grantAuditProvenance,
        auditIntegrityTags: this.state.grantAuditIntegrityTags,
      },
    );
  }
}

function createTransaction(
  state: MemoryState,
  undo: (() => void)[],
  revision: number,
  keyRing: GrantKeyRing | undefined,
): FoundationStorageTransaction {
  return {
    revision,
    findRootByRecordId(recordId) {
      return cloneRoot(state.roots.get(recordId));
    },
    findRootByEventGameId(eventGameId) {
      return findRoot(state.roots, (stored) => stored.root.eventGameId === eventGameId);
    },
    findRootByPitchSlotId(pitchSlotId) {
      return findRoot(
        state.roots,
        (stored) => stored.root.externalScope.pitchSlotId === pitchSlotId,
      );
    },
    findRootByGameSideId(gameSideId) {
      return findRoot(state.roots, (stored) =>
        stored.root.gameSides.some((side) => side.id === gameSideId),
      );
    },
    findActionByOperationId(recordId, operationId) {
      return cloneAction(
        state.actions.get(recordId)?.get(operationId),
        state.actionProvenance.get(recordId)?.get(operationId),
      );
    },
    listActions(recordId) {
      return cloneActions(state.actions.get(recordId), state.actionProvenance.get(recordId));
    },
    listIdempotencyEntries(recordId) {
      return [...(state.idempotency.get(recordId)?.values() ?? [])].map((entry) =>
        structuredClone(entry),
      );
    },
    readRecordMetadata(recordId) {
      const metadata = state.metadata.get(recordId);
      return metadata === undefined ? null : structuredClone(metadata);
    },
    listAuditEntries(recordId) {
      return cloneAudits(state.controlAudits.get(recordId), state.auditProvenance.get(recordId));
    },
    insertRoot(storedRoot) {
      if (state.roots.has(storedRoot.root.recordId)) {
        throw new FoundationStorageConstraintError("record-id");
      }
      if (
        findRoot(state.roots, (stored) => stored.root.eventGameId === storedRoot.root.eventGameId)
      ) {
        throw new FoundationStorageConstraintError("event-game-id");
      }
      if (
        findRoot(
          state.roots,
          (stored) =>
            stored.root.externalScope.pitchSlotId === storedRoot.root.externalScope.pitchSlotId,
        )
      ) {
        throw new FoundationStorageConstraintError("pitch-slot-id");
      }
      for (const side of storedRoot.root.gameSides) {
        if (
          findRoot(state.roots, (stored) =>
            stored.root.gameSides.some((candidate) => candidate.id === side.id),
          )
        ) {
          throw new FoundationStorageConstraintError("game-side-id");
        }
      }
      state.roots.set(storedRoot.root.recordId, {
        root: cloneEventGameRecordRoot(storedRoot.root),
        canonicalContent: storedRoot.canonicalContent,
      });
      undo.push(() => state.roots.delete(storedRoot.root.recordId));
    },
    insertAction(storedAction) {
      const { action } = storedAction;
      if (!state.roots.has(action.recordId)) {
        throw new FoundationStorageConstraintError("record-id");
      }
      let actions = state.actions.get(action.recordId);
      if (actions === undefined) {
        actions = new Map();
        state.actions.set(action.recordId, actions);
        undo.push(() => state.actions.delete(action.recordId));
      }
      if (actions.has(action.operationId)) {
        throw new FoundationStorageConstraintError("operation-id");
      }
      actions.set(action.operationId, {
        ...structuredClone(storedAction),
        durableFormat: "current",
      });
      let provenance = state.actionProvenance.get(action.recordId);
      if (provenance === undefined) {
        provenance = new Map();
        state.actionProvenance.set(action.recordId, provenance);
        undo.push(() => state.actionProvenance.delete(action.recordId));
      }
      provenance.set(action.operationId, "current");
      undo.push(() => provenance?.delete(action.operationId));
      undo.push(() => actions?.delete(action.operationId));
      const actionId = actionIdentity(action.recordId, action.operationId);
      let idempotency = state.idempotency.get(action.recordId);
      if (idempotency === undefined) {
        idempotency = new Map();
        state.idempotency.set(action.recordId, idempotency);
        undo.push(() => state.idempotency.delete(action.recordId));
      }
      if (idempotency.has(actionId)) {
        throw new FoundationStorageConstraintError("operation-id");
      }
      idempotency.set(actionId, {
        actionId,
        recordId: action.recordId,
        operationId: action.operationId,
        contentFingerprint: storedAction.contentFingerprint,
        acceptedAtMs: action.acceptedAtMs,
      });
      undo.push(() => idempotency?.delete(actionId));
    },
    upsertRecordMetadata(metadata) {
      const previous = state.metadata.get(metadata.recordId);
      state.metadata.set(metadata.recordId, structuredClone(metadata));
      undo.push(() => {
        if (previous === undefined) state.metadata.delete(metadata.recordId);
        else state.metadata.set(metadata.recordId, previous);
      });
    },
    appendAuditEntry(entry) {
      let audits = state.controlAudits.get(entry.recordId);
      if (audits === undefined) {
        audits = new Map();
        state.controlAudits.set(entry.recordId, audits);
        undo.push(() => state.controlAudits.delete(entry.recordId));
      }
      if (audits.has(entry.auditId)) {
        throw new FoundationStorageConstraintError("audit-id");
      }
      audits.set(entry.auditId, {
        ...structuredClone(entry),
        durableFormat: "current",
      });
      let provenance = state.auditProvenance.get(entry.recordId);
      if (provenance === undefined) {
        provenance = new Map();
        state.auditProvenance.set(entry.recordId, provenance);
        undo.push(() => state.auditProvenance.delete(entry.recordId));
      }
      provenance.set(entry.auditId, "current");
      undo.push(() => provenance?.delete(entry.auditId));
      undo.push(() => audits?.delete(entry.auditId));
    },
    findGrantById(grantId) {
      const grant = state.grants.get(grantId);
      return grant === undefined ? null : cloneStoredGrant(grant);
    },
    findGrantByCredentialLookupDigest(lookupDigest) {
      return findGrant(state.grants, (grant) => grant.credential.lookupDigest === lookupDigest);
    },
    findActiveSessionByGrantAndContext(grantId, browserContextDigest) {
      return findSession(
        state.sessions,
        (session) =>
          session.grantId === grantId &&
          session.browserContextDigest === browserContextDigest &&
          session.status === "active",
      );
    },
    findSessionByBearerVerifier(bearerLookupVerifier, bearerLookupKeyVersion) {
      return findSession(
        state.sessions,
        (session) =>
          session.bearerLookupVerifier === bearerLookupVerifier &&
          session.bearerLookupKeyVersion === bearerLookupKeyVersion,
      );
    },
    listGrantSessions(grantId) {
      return [...state.sessions.values()]
        .filter((session) => session.grantId === grantId)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map(cloneStoredGrantSession);
    },
    listGrantAudit(grantId) {
      return [...state.grantAudits.values()]
        .filter((entry) => entry.grantId === grantId)
        .sort((left, right) => left.auditId.localeCompare(right.auditId))
        .map(cloneStoredGrantAuditEntry);
    },
    insertGrant(grant) {
      if (state.grants.has(grant.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      if (findGrant(state.grants, (candidate) => candidate.grantVersion === grant.grantVersion)) {
        throw new FoundationStorageConstraintError("grant-version");
      }
      if (
        findGrant(
          state.grants,
          (candidate) =>
            grant.credential.lookupDigest !== null &&
            candidate.credential.lookupDigest === grant.credential.lookupDigest,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-credential-digest");
      }
      if (
        grant.grantType === "control" &&
        findGrant(
          state.grants,
          (candidate) =>
            (candidate.scope as ControlGrantScope).pitchSlotId ===
            (grant.scope as ControlGrantScope).pitchSlotId,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-pitch-slot-id");
      }
      state.grants.set(grant.grantId, cloneStoredGrant(grant));
      undo.push(() => state.grants.delete(grant.grantId));
    },
    updateGrant(grant) {
      if (!state.grants.has(grant.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      if (
        findGrant(
          state.grants,
          (candidate) =>
            candidate.grantId !== grant.grantId && candidate.grantVersion === grant.grantVersion,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-version");
      }
      if (
        grant.grantType === "control" &&
        findGrant(
          state.grants,
          (candidate) =>
            candidate.grantId !== grant.grantId &&
            (candidate.scope as ControlGrantScope).pitchSlotId ===
              (grant.scope as ControlGrantScope).pitchSlotId,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-pitch-slot-id");
      }
      if (
        findGrant(
          state.grants,
          (candidate) =>
            candidate.grantId !== grant.grantId &&
            grant.credential.lookupDigest !== null &&
            candidate.credential.lookupDigest === grant.credential.lookupDigest,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-credential-digest");
      }
      const previous = state.grants.get(grant.grantId);
      state.grants.set(grant.grantId, cloneStoredGrant(grant));
      undo.push(() => {
        if (previous !== undefined) state.grants.set(grant.grantId, previous);
      });
    },
    insertGrantSession(session) {
      if (state.sessions.has(session.sessionId)) {
        throw new FoundationStorageConstraintError("grant-session-id");
      }
      if (
        findSession(
          state.sessions,
          (candidate) =>
            session.bearerLookupVerifier !== null &&
            candidate.bearerLookupVerifier === session.bearerLookupVerifier,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-verifier");
      }
      if (
        session.status === "active" &&
        findSession(
          state.sessions,
          (candidate) =>
            candidate.grantId === session.grantId &&
            candidate.browserContextDigest === session.browserContextDigest &&
            candidate.status === "active",
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-context");
      }
      if (!state.grants.has(session.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      state.sessions.set(session.sessionId, cloneStoredGrantSession(session));
      undo.push(() => state.sessions.delete(session.sessionId));
    },
    updateGrantSession(session) {
      if (!state.sessions.has(session.sessionId)) {
        throw new FoundationStorageConstraintError("grant-session-id");
      }
      if (!state.grants.has(session.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      if (
        findSession(
          state.sessions,
          (candidate) =>
            candidate.sessionId !== session.sessionId &&
            session.bearerLookupVerifier !== null &&
            candidate.bearerLookupVerifier === session.bearerLookupVerifier,
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-verifier");
      }
      if (
        session.status === "active" &&
        findSession(
          state.sessions,
          (candidate) =>
            candidate.sessionId !== session.sessionId &&
            candidate.grantId === session.grantId &&
            candidate.browserContextDigest === session.browserContextDigest &&
            candidate.status === "active",
        )
      ) {
        throw new FoundationStorageConstraintError("grant-session-context");
      }
      const previous = state.sessions.get(session.sessionId);
      state.sessions.set(session.sessionId, cloneStoredGrantSession(session));
      undo.push(() => {
        if (previous !== undefined) state.sessions.set(session.sessionId, previous);
      });
    },
    appendGrantAudit(entry) {
      if (keyRing === undefined) {
        throw new Error("Grant Audit Trail integrity requires the Grant key ring.");
      }
      if (state.grantAudits.has(entry.auditId)) {
        throw new FoundationStorageConstraintError("grant-audit-id");
      }
      if (!state.grants.has(entry.grantId)) {
        throw new FoundationStorageConstraintError("grant-id");
      }
      state.grantAudits.set(entry.auditId, cloneStoredGrantAuditEntry(entry));
      undo.push(() => state.grantAudits.delete(entry.auditId));
      state.grantAuditProvenance.set(entry.auditId, cloneStoredGrantAuditEntry(entry));
      undo.push(() => state.grantAuditProvenance.delete(entry.auditId));
      state.grantAuditIntegrityTags.set(
        entry.auditId,
        computeGrantAuditIntegrityTag(entry, keyRing),
      );
      undo.push(() => state.grantAuditIntegrityTags.delete(entry.auditId));
    },
  };
}

function findRoot(
  roots: Map<string, StoredEventGameRecordRoot>,
  predicate: (stored: StoredEventGameRecordRoot) => boolean,
): EventGameRecordRoot | null {
  for (const stored of roots.values()) {
    if (predicate(stored)) return cloneEventGameRecordRoot(stored.root);
  }
  return null;
}

function cloneRoot(stored: StoredEventGameRecordRoot | undefined): EventGameRecordRoot | null {
  return stored === undefined ? null : cloneEventGameRecordRoot(stored.root);
}

function cloneAction(
  stored: StoredControlAction | undefined,
  provenance: "current" | "legacy" | undefined,
): StoredControlAction | null {
  return stored === undefined
    ? null
    : {
        ...structuredClone(stored),
        durableFormat: provenance ?? stored.durableFormat,
        [DURABLE_EVIDENCE_PROVENANCE]: provenance ?? stored[DURABLE_EVIDENCE_PROVENANCE],
      };
}

function cloneActions(
  actions: Map<string, StoredControlAction> | undefined,
  provenance: Map<string, "current" | "legacy"> | undefined,
): StoredControlAction[] {
  return [...(actions?.values() ?? [])].map((stored) =>
    cloneAction(stored, provenance?.get(stored.action.operationId))!,
  );
}

function cloneAudits(
  audits: Map<string, StoredControlAuditEntry> | undefined,
  provenance: Map<string, "current" | "legacy"> | undefined,
): StoredControlAuditEntry[] {
  return [...(audits?.values() ?? [])].map((entry) => ({
    ...structuredClone(entry),
    durableFormat: provenance?.get(entry.auditId) ?? entry.durableFormat,
    [DURABLE_EVIDENCE_PROVENANCE]:
      provenance?.get(entry.auditId) ?? entry[DURABLE_EVIDENCE_PROVENANCE],
  }));
}

function findGrant(
  state: Map<string, StoredGrant>,
  predicate: (grant: StoredGrant) => boolean,
): StoredGrant | null {
  for (const grant of state.values()) {
    if (predicate(grant)) return cloneStoredGrant(grant);
  }
  return null;
}

function findSession(
  state: Map<string, StoredGrantSession>,
  predicate: (session: StoredGrantSession) => boolean,
): StoredGrantSession | null {
  for (const session of state.values()) {
    if (predicate(session)) return cloneStoredGrantSession(session);
  }
  return null;
}
