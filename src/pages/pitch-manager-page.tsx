import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode/lib/browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createGrantSecretOwner, type GrantSecretToken } from "@/lib/grant-secret-owner";

type Scope = {
  eventId: string;
  gameDayId: string;
  gameDayDate: string;
  eventTimeZone: string;
  pitchId: string;
};

type View = {
  eventId: string;
  gameDayId: string;
  gameDayDate: string;
  eventTimeZone: string;
  pitch: { pitchId: string; name: string };
  schedule: Array<{
    pitchSlotId: string;
    gameplaySlotId: string;
    sequence: number;
    expectedStart: string;
    eventGame: {
      eventGameId: string;
      gameCode: string | null;
      gameDesignation: string | null;
      sideA: { displayName: string };
      sideB: { displayName: string };
    } | null;
    conflictEventGameIds: string[];
    controlGrantStatus: string;
  }>;
  grantSessionExpiresAt: string | null;
};

type ControlGrant = {
  grantId: string;
  status: string;
  eligibility: string;
  eventGameId: string | null;
  affectedSessionCount?: number;
};

type GrantCodeProjection = {
  grantId: string;
  grantVersion: string;
  state: "absent" | "present" | "disabled" | "erased";
  formatVersion: 1 | null;
};

type ControlSession = {
  label: string;
  createdAtMs: number;
  lastActiveAtMs: number;
  deviceClass: string;
  browserClass: string;
};

export type GrantQrRenderer = (credential: string) => Promise<string>;

const defaultGrantQrRenderer: GrantQrRenderer = (credential) => QRCode.toDataURL(credential);

export function PitchManagerPage({
  qrRenderer = defaultGrantQrRenderer,
}: {
  qrRenderer?: GrantQrRenderer;
} = {}) {
  const [credential, setCredential] = useState("");
  const [grantCode, setGrantCode] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [controlGrants, setControlGrants] = useState<Record<string, ControlGrant | null>>({});
  const [controlQr, setControlQr] = useState<Record<string, string>>({});
  const [controlCodes, setControlCodes] = useState<Record<string, GrantCodeProjection | null>>({});
  const [controlCodePlaintexts, setControlCodePlaintexts] = useState<Record<string, string>>({});
  const [controlSessions, setControlSessions] = useState<Record<string, ControlSession[]>>({});
  const [controlQrCredentials, setControlQrCredentials] = useState<Record<string, string>>({});
  const [controlRotationCounts, setControlRotationCounts] = useState<Record<string, number>>({});
  const [secretWarning, setSecretWarning] = useState<string | null>(null);
  const [secretOwner] = useState(createGrantSecretOwner);

  const secretScopeKey = (nextScope = scope) =>
    nextScope === null
      ? "pitch-manager:admission"
      : `pitch-manager:${nextScope.eventId}:${nextScope.gameDayId}:${nextScope.pitchId}`;

  const clearGrantSecrets = () => {
    setCredential("");
    setGrantCode("");
    setControlQr({});
    setControlQrCredentials({});
    setControlCodePlaintexts({});
    setControlRotationCounts({});
    setSecretWarning(null);
    setMessage(null);
  };

  const invalidateGrantSecrets = (nextScope = scope) => {
    secretOwner.invalidate(secretScopeKey(nextScope));
    clearGrantSecrets();
  };

  const clearControlGrantSecrets = (pitchSlotId: string) => {
    setControlQr((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
    setControlQrCredentials((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
    setControlCodePlaintexts((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
    setControlRotationCounts((current) => {
      const next = { ...current };
      delete next[pitchSlotId];
      return next;
    });
  };

  useEffect(
    () => () => {
      secretOwner.unmount();
      setCredential("");
      setGrantCode("");
      setControlQr({});
      setControlQrCredentials({});
      setControlCodePlaintexts({});
      setControlRotationCounts({});
      setSecretWarning(null);
    },
    [secretOwner],
  );

  const loadCurrent = useCallback(
    async (token = secretOwner.capture(secretScopeKey(null))) => {
      const response = await fetch("/api/pitch-manager/current");
      const payload = (await response.json()) as { status: string; value?: View };
      if (!response.ok || payload.status !== "accepted" || payload.value === undefined) {
        if (secretOwner.current(token)) throw new Error("Unable to open the Pitch Manager view.");
        return;
      }
      if (!secretOwner.current(token)) return;
      const nextScope: Scope = {
        eventId: payload.value.eventId,
        gameDayId: payload.value.gameDayId,
        gameDayDate: payload.value.gameDayDate,
        eventTimeZone: payload.value.eventTimeZone,
        pitchId: payload.value.pitch.pitchId,
      };
      secretOwner.commit(token, () => {
        setScope(nextScope);
        setView(payload.value!);
        secretOwner.capture(secretScopeKey(nextScope));
      });
    },
    [secretOwner, scope],
  );

  const admit = async () => {
    const body =
      grantCode.length > 0
        ? { grantCode, deviceClass: "mobile" }
        : { qrCredential: credential, deviceClass: "mobile" };
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey(null));
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/pitch-manager/admit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { status: string };
      if (!response.ok || payload.status !== "admitted")
        throw new Error("Unable to admit this Pitch Manager credential.");
      await loadCurrent(token);
    } catch {
      setMessage("Unable to admit this Pitch Manager credential.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (scope !== null || view !== null) return;
    void loadCurrent().catch(() => undefined);
  }, [loadCurrent, scope, view]);

  const leave = async () => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey(null));
    await fetch("/api/pitch-manager/leave", { method: "POST" });
    secretOwner.commit(token, () => {
      setScope(null);
      setView(null);
    });
  };

  const controlGrantUrl = (pitchSlotId: string) =>
    `/api/pitch-manager/events/${scope?.eventId}/game-days/${scope?.gameDayId}/pitches/${scope?.pitchId}/pitch-slots/${pitchSlotId}/control-grant`;

  const controlCodeUrl = (pitchSlotId: string) => `${controlGrantUrl(pitchSlotId)}/code`;

  const inspectControlGrant = async (
    pitchSlotId: string,
    preserveSecrets = false,
    providedToken?: GrantSecretToken,
  ) => {
    let token = providedToken;
    if (!preserveSecrets) {
      invalidateGrantSecrets();
      clearControlGrantSecrets(pitchSlotId);
      token = secretOwner.capture(secretScopeKey());
    }
    token ??= secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return null;
    try {
      const response = await fetch(controlGrantUrl(pitchSlotId));
      const payload = (await response.json()) as { status: string; value?: ControlGrant | null };
      if (!response.ok || payload.status !== "accepted")
        throw new Error("Control Grant lookup failed.");
      if (!secretOwner.current(token)) return null;
      secretOwner.commit(token, () =>
        setControlGrants((current) => ({ ...current, [pitchSlotId]: payload.value ?? null })),
      );
      const codeResponse = await fetch(controlCodeUrl(pitchSlotId));
      const codePayload = (await codeResponse.json()) as {
        status: string;
        value?: GrantCodeProjection | null;
      };
      if (codeResponse.ok && codePayload.status === "accepted" && secretOwner.current(token)) {
        const projection = codePayload.value ?? null;
        secretOwner.commit(token, () => {
          setControlCodes((current) => ({ ...current, [pitchSlotId]: projection }));
          if (projection === null || projection.state !== "present")
            clearControlGrantSecrets(pitchSlotId);
        });
      }
      return payload.value ?? null;
    } catch (error) {
      if (secretOwner.current(token)) throw error;
      return null;
    }
  };

  const createControlGrant = async (pitchSlotId: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(controlGrantUrl(pitchSlotId), { method: "POST" });
    if (!response.ok) {
      if (secretOwner.current(token)) throw new Error("Control Grant creation failed.");
      return;
    }
    await inspectControlGrant(pitchSlotId, true, token);
  };

  const revealControlGrant = async (pitchSlotId: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    const response = await fetch(`${controlGrantUrl(pitchSlotId)}/reveal`, { method: "POST" });
    const payload = (await response.json()) as {
      status: string;
      value?: { qrCredential?: string };
    };
    if (
      !response.ok ||
      payload.status !== "accepted" ||
      payload.value?.qrCredential === undefined
    ) {
      if (secretOwner.current(token)) throw new Error("Control Grant QR reveal failed.");
      return;
    }
    try {
      const dataUrl = await qrRenderer(payload.value.qrCredential);
      secretOwner.commit(token, () =>
        setControlQr((current) => ({ ...current, [pitchSlotId]: dataUrl })),
      );
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const loadControlSessions = async (pitchSlotId: string, providedToken?: GrantSecretToken) => {
    const token = providedToken ?? secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return;
    try {
      const response = await fetch(`${controlGrantUrl(pitchSlotId)}/sessions`);
      const payload = (await response.json()) as { status: string; value?: ControlSession[] };
      if (!response.ok || payload.status !== "accepted") throw new Error("Session list failed.");
      secretOwner.commit(token, () =>
        setControlSessions((current) => ({ ...current, [pitchSlotId]: payload.value ?? [] })),
      );
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const rotateControlGrant = async (pitchSlotId: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    try {
      const response = await fetch(`${controlGrantUrl(pitchSlotId)}/rotate`, { method: "POST" });
      const payload = (await response.json()) as {
        status: string;
        value?: { affectedSessionCount?: number; qrCredential?: string; code?: string };
      };
      if (!response.ok || payload.status !== "accepted")
        throw new Error("Control Grant rotation failed.");
      if (payload.value?.qrCredential === undefined || payload.value.code === undefined)
        throw new Error("Control Grant rotation did not return replacement credentials.");
      const { code, qrCredential, affectedSessionCount = 0 } = payload.value;
      if (
        !secretOwner.commit(token, () => {
          setControlQrCredentials((current) => ({ ...current, [pitchSlotId]: qrCredential }));
          setControlCodePlaintexts((current) => ({ ...current, [pitchSlotId]: code }));
          setControlRotationCounts((current) => ({
            ...current,
            [pitchSlotId]: affectedSessionCount,
          }));
          setMessage(
            `Control Grant fully rotated; ${affectedSessionCount} session(s) revoked. Dictate the new code and scan the new QR now.`,
          );
        })
      )
        return;
      await renderControlQr(pitchSlotId, qrCredential, token);
      if (!secretOwner.current(token)) return;
      const refreshWarnings: string[] = [];
      try {
        await inspectControlGrant(pitchSlotId, true, token);
      } catch {
        refreshWarnings.push("Control Grant state refresh failed.");
      }
      try {
        await loadControlSessions(pitchSlotId, token);
      } catch {
        refreshWarnings.push("Control session refresh failed.");
      }
      if (refreshWarnings.length > 0 && secretOwner.current(token))
        setSecretWarning(refreshWarnings.join(" ") + " Replacement credentials remain visible.");
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const renderControlQr = async (
    pitchSlotId: string,
    credential = controlQrCredentials[pitchSlotId],
    providedToken?: GrantSecretToken,
  ) => {
    if (credential === undefined) return;
    const token = providedToken ?? secretOwner.capture(secretScopeKey());
    if (!secretOwner.current(token)) return;
    try {
      const dataUrl = await qrRenderer(credential);
      secretOwner.commit(token, () => {
        setControlQr((current) => ({ ...current, [pitchSlotId]: dataUrl }));
        setControlQrCredentials((current) => {
          const next = { ...current };
          delete next[pitchSlotId];
          return next;
        });
        setSecretWarning((current) => (current?.includes("QR render failed") ? null : current));
      });
    } catch {
      if (secretOwner.current(token))
        setSecretWarning("Replacement QR render failed. Retry QR render locally.");
    }
  };

  const manageControlCode = async (
    pitchSlotId: string,
    operation: "create" | "replace" | "disable",
  ) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    try {
      const response = await fetch(
        `${controlCodeUrl(pitchSlotId)}${operation === "create" ? "" : `/${operation}`}`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        status: string;
        value?: GrantCodeProjection & { code?: string };
      };
      if (!response.ok || payload.status !== "accepted")
        throw new Error("Grant Code operation failed.");
      if (!secretOwner.current(token)) return;
      if (operation !== "disable" && payload.value?.code !== undefined)
        secretOwner.commit(token, () =>
          setControlCodePlaintexts((current) => ({
            ...current,
            [pitchSlotId]: payload.value!.code!,
          })),
        );
      await inspectControlGrant(pitchSlotId, operation !== "disable", token);
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  const revokeControlSession = async (pitchSlotId: string, label: string) => {
    invalidateGrantSecrets();
    const token = secretOwner.capture(secretScopeKey());
    try {
      const response = await fetch(`${controlGrantUrl(pitchSlotId)}/sessions/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionReference: label }),
      });
      if (!response.ok) throw new Error("Control session revocation failed.");
      await loadControlSessions(pitchSlotId, token);
    } catch (error) {
      if (secretOwner.current(token)) throw error;
    }
  };

  if (view === null || scope === null) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-4">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Pitch Manager handoff</CardTitle>
            <CardDescription>Scan the QR for one Pitch and Game Day.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pitch-manager-credential">Scanned Pitch Manager QR value</Label>
              <Input
                id="pitch-manager-credential"
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                onInput={(event) => setCredential(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pitch-manager-grant-code">Radio Grant Code</Label>
              <Input
                id="pitch-manager-grant-code"
                type="password"
                autoComplete="off"
                placeholder="two words and three digits"
                value={grantCode}
                onChange={(event) => setGrantCode(event.target.value)}
                onInput={(event) => setGrantCode(event.currentTarget.value)}
              />
            </div>
            <Button
              disabled={
                busy ||
                (credential.length === 0 && grantCode.length === 0) ||
                (credential.length > 0 && grantCode.length > 0)
              }
              onClick={() => void admit()}
            >
              Open Pitch
            </Button>
            {message ? <p className="text-sm text-destructive">{message}</p> : null}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl p-4 pb-12 sm:p-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{view.pitch.name}</CardTitle>
            <CardDescription>
              Pitch Manager · Game Day {view.gameDayDate} · {view.eventTimeZone} ·{" "}
              {view.schedule.length} Slots
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => void leave()}>
            Leave
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Session valid until{" "}
            {view.grantSessionExpiresAt === null ? "the Grant expires" : view.grantSessionExpiresAt}
            .
          </p>
          <div className="space-y-2" aria-label="Pitch schedule">
            {view.schedule.map((slot) => {
              const game = slot.eventGame;
              const controlGrant = controlGrants[slot.pitchSlotId];
              return (
                <div
                  className={`rounded border p-3 ${slot.conflictEventGameIds.length > 1 ? "border-destructive" : ""}`}
                  key={slot.pitchSlotId}
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">Slot {slot.sequence}</span>
                    <span>{slot.expectedStart}</span>
                  </div>
                  <p className="text-sm">
                    {game === null
                      ? "No Event Game"
                      : `${game.gameCode ?? game.eventGameId} · ${game.sideA.displayName} vs ${game.sideB.displayName}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Control Grant: {slot.controlGrantStatus}
                    {slot.conflictEventGameIds.length > 1 ? " · Schedule conflict" : ""}
                  </p>
                  <div className="mt-3 space-y-2 border-t pt-2">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void inspectControlGrant(slot.pitchSlotId).catch(() =>
                            setMessage("Control Grant lookup failed."),
                          )
                        }
                      >
                        Inspect Control Grant
                      </Button>
                      {controlGrant === undefined || controlGrant === null ? (
                        <Button
                          size="sm"
                          onClick={() =>
                            void createControlGrant(slot.pitchSlotId).catch(() =>
                              setMessage("Control Grant creation failed."),
                            )
                          }
                        >
                          Create Control Grant
                        </Button>
                      ) : null}
                      {controlGrant ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void revealControlGrant(slot.pitchSlotId).catch(() =>
                                setMessage("Control Grant QR reveal failed."),
                              )
                            }
                          >
                            Reveal QR
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void loadControlSessions(slot.pitchSlotId).catch(() =>
                                setMessage("Session list failed."),
                              )
                            }
                          >
                            Sessions
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void rotateControlGrant(slot.pitchSlotId).catch(() =>
                                setMessage("Control Grant rotation failed."),
                              )
                            }
                          >
                            Rotate Grant
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void manageControlCode(slot.pitchSlotId, "create").catch(() =>
                                setMessage("Grant Code operation failed."),
                              )
                            }
                          >
                            Create Radio Code
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={controlCodes[slot.pitchSlotId]?.state !== "present"}
                            onClick={() =>
                              void manageControlCode(slot.pitchSlotId, "replace").catch(() =>
                                setMessage("Grant Code operation failed."),
                              )
                            }
                          >
                            Replace Code
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={controlCodes[slot.pitchSlotId]?.state !== "present"}
                            onClick={() =>
                              void manageControlCode(slot.pitchSlotId, "disable").catch(() =>
                                setMessage("Grant Code operation failed."),
                              )
                            }
                          >
                            Disable Code
                          </Button>
                        </>
                      ) : null}
                    </div>
                    {controlGrant ? (
                      <p className="text-xs text-muted-foreground">
                        {controlGrant.status} · {controlGrant.eligibility}
                        {controlGrant.eventGameId ? ` · ${controlGrant.eventGameId}` : ""}
                      </p>
                    ) : null}
                    {controlRotationCounts[slot.pitchSlotId] !== undefined ? (
                      <p className="text-xs text-muted-foreground">
                        Full rotation affected {controlRotationCounts[slot.pitchSlotId]} session(s).
                      </p>
                    ) : null}
                    {controlQr[slot.pitchSlotId] ? (
                      <img
                        alt={`Control Grant QR for Pitch Slot ${slot.sequence}`}
                        className="h-40 w-40 rounded border bg-white p-2"
                        src={controlQr[slot.pitchSlotId]}
                      />
                    ) : null}
                    {controlQrCredentials[slot.pitchSlotId] ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void renderControlQr(slot.pitchSlotId)}
                      >
                        Retry QR render
                      </Button>
                    ) : null}
                    {controlGrant ? (
                      <p className="text-xs text-muted-foreground">
                        Radio code: {controlCodes[slot.pitchSlotId]?.state ?? "absent"}
                      </p>
                    ) : null}
                    {controlCodePlaintexts[slot.pitchSlotId] ? (
                      <div className="flex items-center gap-2 rounded bg-muted p-2">
                        <p aria-live="polite" className="font-mono text-sm">
                          Dictate now: {controlCodePlaintexts[slot.pitchSlotId]}
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setControlCodePlaintexts((current) => {
                              const next = { ...current };
                              delete next[slot.pitchSlotId];
                              return next;
                            })
                          }
                        >
                          Clear
                        </Button>
                      </div>
                    ) : null}
                    {(controlSessions[slot.pitchSlotId] ?? []).map((session) => (
                      <div
                        className="flex items-center justify-between gap-2 text-xs"
                        key={session.label}
                      >
                        <span>
                          {session.label} · {session.deviceClass}/{session.browserClass}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void revokeControlSession(slot.pitchSlotId, session.label).catch(() =>
                              setMessage("Control session revocation failed."),
                            )
                          }
                        >
                          Revoke
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {secretWarning ? <p className="text-sm text-destructive">{secretWarning}</p> : null}
          {message ? <p className="text-sm text-destructive">{message}</p> : null}
          <Button
            variant="outline"
            onClick={() => void loadCurrent().catch(() => setMessage("View refresh failed."))}
          >
            Refresh Pitch
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
