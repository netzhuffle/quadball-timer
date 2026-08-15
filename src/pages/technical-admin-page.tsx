import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode/lib/browser";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdministrativeAuditBrowser } from "@/pages/administrative-audit-browser";

type AdminSession = {
  authenticated: true;
  environment: "production" | "test";
  activeSessionCount: number;
};

export function TechnicalAdminPage({ enrollment }: { enrollment: boolean }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (enrollment) {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
      setEnrollmentToken(token);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      return;
    }
    void adminFetch("/api/admin/session").then(async (response) => {
      if (response.ok) setSession((await response.json()) as AdminSession);
    });
  }, [enrollment]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch {
      setMessage("Authentication failed. Try again with the same environment and passkey.");
    } finally {
      setBusy(false);
    }
  };

  const completeStepUp = async (purpose: "replace-credential" | "revoke-other-sessions") => {
    const optionsResponse = await adminFetch("/api/admin/step-up/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose }),
    });
    if (!optionsResponse.ok) throw new Error("Fresh verification is unavailable.");
    const options = (await optionsResponse.json()) as AuthenticationOptionsResponse;
    const credential = await getCredential(options);
    const complete = await adminFetch("/api/admin/step-up/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: options.challengeId,
        response: serializeCredential(credential),
      }),
    });
    if (!complete.ok) throw new Error("Fresh verification failed.");
  };

  if (enrollment) {
    return (
      <AdminCard
        title="Enroll Technical Admin"
        description="Register the sole passkey for this environment."
      >
        <p className="text-sm text-muted-foreground">
          The enrollment authorization is single-use and expires after ten minutes.
        </p>
        <Button
          disabled={busy || enrollmentToken === null}
          onClick={() =>
            void run(async () => {
              if (enrollmentToken === null) throw new Error("Missing enrollment authorization.");
              const optionsResponse = await adminFetch("/api/admin/enrollment/options", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: enrollmentToken }),
              });
              if (!optionsResponse.ok) throw new Error("Enrollment is unavailable.");
              const options = (await optionsResponse.json()) as RegistrationOptionsResponse;
              const credential = await createCredential(options);
              const complete = await adminFetch("/api/admin/enrollment/complete", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  challengeId: options.challengeId,
                  response: serializeCredential(credential),
                }),
              });
              if (!complete.ok) throw new Error("Enrollment failed.");
              window.location.assign("/admin");
            })
          }
        >
          {busy ? "Waiting for passkey…" : "Register passkey"}
        </Button>
        {message ? <p className="text-sm text-destructive">{message}</p> : null}
      </AdminCard>
    );
  }

  if (session === null) {
    return (
      <AdminCard title="Technical Admin" description="Passkey authentication is required.">
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const optionsResponse = await adminFetch("/api/admin/authentication/options", {
                method: "POST",
              });
              if (!optionsResponse.ok) throw new Error("Sign-in unavailable.");
              const options = (await optionsResponse.json()) as AuthenticationOptionsResponse;
              const credential = await getCredential(options);
              const complete = await adminFetch("/api/admin/authentication/complete", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  challengeId: options.challengeId,
                  response: serializeCredential(credential),
                }),
              });
              if (!complete.ok) throw new Error("Sign-in failed.");
              const sessionResponse = await adminFetch("/api/admin/session");
              if (!sessionResponse.ok) throw new Error("Session was not created.");
              setSession((await sessionResponse.json()) as AdminSession);
            })
          }
        >
          {busy ? "Waiting for passkey…" : "Sign in with passkey"}
        </Button>
        {message ? <p className="text-sm text-destructive">{message}</p> : null}
      </AdminCard>
    );
  }

  return (
    <AdminCard
      title="Technical Admin administration"
      description={`Authenticated in the ${session.environment} environment.`}
    >
      <p className="text-sm text-muted-foreground">
        Event administration is available from this protected shell.
      </p>
      <p className="text-sm text-muted-foreground">
        Active browser sessions: {session.activeSessionCount}
      </p>
      <Button
        variant="outline"
        onClick={() =>
          void run(async () => {
            await adminFetch("/api/admin/logout", {
              method: "POST",
              headers: { "content-type": "application/json" },
            });
            setSession(null);
          })
        }
      >
        Sign out
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          void run(async () => {
            await completeStepUp("replace-credential");
            const optionsResponse = await adminFetch("/api/admin/replacement/options", {
              method: "POST",
              headers: { "content-type": "application/json" },
            });
            if (!optionsResponse.ok) throw new Error("Replacement is unavailable.");
            const options = (await optionsResponse.json()) as RegistrationOptionsResponse;
            const credential = await createCredential(options);
            const complete = await adminFetch("/api/admin/replacement/complete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                challengeId: options.challengeId,
                response: serializeCredential(credential),
              }),
            });
            if (!complete.ok) throw new Error("Replacement failed.");
            const refreshed = await adminFetch("/api/admin/session");
            if (!refreshed.ok) throw new Error("Replacement session was not created.");
            setSession((await refreshed.json()) as AdminSession);
          })
        }
      >
        Replace passkey
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          void run(async () => {
            await completeStepUp("revoke-other-sessions");
            const response = await adminFetch("/api/admin/sessions/revoke-others", {
              method: "POST",
              headers: { "content-type": "application/json" },
            });
            if (!response.ok) throw new Error("Session revocation failed.");
            const refreshed = await adminFetch("/api/admin/session");
            if (!refreshed.ok) throw new Error("Session status is unavailable.");
            setSession((await refreshed.json()) as AdminSession);
          })
        }
      >
        Log out other sessions
      </Button>
      <EventCatalogPanel />
    </AdminCard>
  );
}

type EventCatalogResponse<T> =
  | { status: "accepted"; value: T }
  | { status: "rejected" | "retryable-failure"; reason?: string; detail: string };

type EventProjection = {
  eventId: string;
  name: string;
  timeZone: string;
  lifecycle: "unscheduled" | "future" | "current" | "past";
  gameDays: Array<{
    gameDayId: string;
    date: string;
    classification: "future" | "current" | "past";
  }>;
};

type EventAdminGrantProjection = {
  grantId: string;
  grantVersion: string;
  eventId: string;
  status: "active" | "disabled" | "revoked" | "expired";
  expiresAtMs: number | null;
};

function EventCatalogPanel() {
  const [events, setEvents] = useState<EventProjection[]>([]);
  const [selected, setSelected] = useState<EventProjection | null>(null);
  const [editedName, setEditedName] = useState("");
  const [editedTimeZone, setEditedTimeZone] = useState("");
  const [editedGameDays, setEditedGameDays] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [timeZone, setTimeZone] = useState("Europe/Zurich");
  const [gameDayDate, setGameDayDate] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [eventAdminGrant, setEventAdminGrant] = useState<EventAdminGrantProjection | null>(null);
  const [revealedCredential, setRevealedCredential] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (revealedCredential === null) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(revealedCredential, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [revealedCredential]);

  const request = async <T,>(url: string, init?: RequestInit) => {
    const response = await adminFetch(url, init);
    const payload = (await response.json()) as EventCatalogResponse<T>;
    if (!response.ok || payload.status !== "accepted") {
      throw new Error("detail" in payload ? payload.detail : "Event catalog operation failed.");
    }
    return payload.value;
  };

  const refresh = async () => {
    const value = await request<readonly EventProjection[]>("/api/admin/events");
    setEvents([...value]);
    if (selected !== null) {
      const current = await request<EventProjection>(`/api/admin/events/${selected.eventId}`);
      setSelected(current);
      setEditedName(current.name);
      setEditedTimeZone(current.timeZone);
      setEditedGameDays(
        Object.fromEntries(current.gameDays.map((day) => [day.gameDayId, day.date])),
      );
      const grant = await request<EventAdminGrantProjection | null>(
        `/api/admin/events/${current.eventId}/event-admin-grant`,
      );
      setEventAdminGrant(grant);
    }
  };

  const selectEvent = async (eventId: string) => {
    const current = await request<EventProjection>(`/api/admin/events/${eventId}`);
    setSelected(current);
    setEditedName(current.name);
    setEditedTimeZone(current.timeZone);
    setEditedGameDays(Object.fromEntries(current.gameDays.map((day) => [day.gameDayId, day.date])));
    setEventAdminGrant(
      await request<EventAdminGrantProjection | null>(
        `/api/admin/events/${current.eventId}/event-admin-grant`,
      ),
    );
    setRevealedCredential(null);
  };

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Unable to load Events."),
    );
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Event catalog operation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Event catalog</CardTitle>
        <CardDescription>
          Create and maintain Unpublished Events and their Game Days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await request<EventProjection>("/api/admin/events", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-technical-admin-csrf": "1",
                },
                body: JSON.stringify({ name, timeZone }),
              });
              setName("");
              await refresh();
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="event-name">Event name</Label>
            <Input
              id="event-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-time-zone">Event timezone</Label>
            <Input
              id="event-time-zone"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              required
            />
          </div>
          <Button className="self-end" disabled={busy} type="submit">
            Create Event
          </Button>
        </form>

        {message ? <p className="text-sm text-destructive">{message}</p> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Events</h3>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Events yet.</p>
            ) : null}
            {events.map((event) => (
              <button
                className="block w-full rounded-lg border p-3 text-left hover:bg-muted"
                key={event.eventId}
                onClick={() => void run(() => selectEvent(event.eventId))}
                type="button"
              >
                <span className="font-medium">{event.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {event.timeZone} · {event.lifecycle}
                </span>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="space-y-3 rounded-lg border p-3">
              <div>
                <h3 className="font-semibold">{selected.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {selected.eventId} · {selected.timeZone}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="selected-event-name">Event name</Label>
                  <Input
                    id="selected-event-name"
                    value={editedName}
                    onChange={(event) => setEditedName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="selected-event-time-zone">Event timezone</Label>
                  <Input
                    id="selected-event-time-zone"
                    value={editedTimeZone}
                    onChange={(event) => setEditedTimeZone(event.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || editedName.length === 0 || editedTimeZone.length === 0}
                  onClick={() =>
                    void run(async () => {
                      await request(`/api/admin/events/${selected.eventId}`, {
                        method: "PATCH",
                        headers: {
                          "content-type": "application/json",
                          "x-technical-admin-csrf": "1",
                        },
                        body: JSON.stringify({ name: editedName, timeZone: editedTimeZone }),
                      });
                      await refresh();
                    })
                  }
                  type="button"
                >
                  Save Event
                </Button>
                <Button
                  disabled={busy || selected.gameDays.length > 0}
                  onClick={() =>
                    void run(async () => {
                      await request(`/api/admin/events/${selected.eventId}`, {
                        method: "DELETE",
                        headers: { "x-technical-admin-csrf": "1" },
                      });
                      setSelected(null);
                      await refresh();
                    })
                  }
                  type="button"
                  variant="outline"
                >
                  Remove empty Event
                </Button>
                <Button
                  variant="outline"
                  onClick={() => window.location.assign(`/event-admin?eventId=${selected.eventId}`)}
                >
                  Open Event Hub
                </Button>
              </div>
              <AdministrativeAuditBrowser
                eventId={selected.eventId}
                route="technical-admin"
                request={adminFetch}
              />
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <h3 className="font-semibold">Event Admin Grant</h3>
                  <p className="text-xs text-muted-foreground">
                    Shared Event-scoped handoff; the QR credential is shown only after an explicit
                    reveal.
                  </p>
                </div>
                {eventAdminGrant ? (
                  <p className="text-sm">
                    {eventAdminGrant.status} · {eventAdminGrant.grantId}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No Event Admin Grant yet.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy || eventAdminGrant !== null}
                    onClick={() =>
                      void run(async () => {
                        setEventAdminGrant(
                          await request<EventAdminGrantProjection>(
                            `/api/admin/events/${selected.eventId}/event-admin-grant`,
                            {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                            },
                          ),
                        );
                      })
                    }
                  >
                    Create Grant
                  </Button>
                  <Button
                    disabled={busy || eventAdminGrant === null}
                    onClick={() =>
                      void run(async () => {
                        const response = await adminFetch(
                          `/api/admin/events/${selected.eventId}/event-admin-grant/reveal`,
                          { method: "POST", headers: { "content-type": "application/json" } },
                        );
                        const payload = (await response.json()) as EventCatalogResponse<{
                          qrCredential: string;
                        }>;
                        if (!response.ok || payload.status !== "accepted")
                          throw new Error("Grant reveal failed.");
                        setRevealedCredential(payload.value.qrCredential);
                      })
                    }
                  >
                    Reveal QR credential
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || eventAdminGrant?.status !== "active"}
                    onClick={() =>
                      void run(async () => {
                        await request(
                          `/api/admin/events/${selected.eventId}/event-admin-grant/rotate`,
                          {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                          },
                        );
                        setRevealedCredential(null);
                        await refresh();
                      })
                    }
                  >
                    Rotate Grant
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || eventAdminGrant?.status !== "active"}
                    onClick={() =>
                      void run(async () => {
                        await request(
                          `/api/admin/events/${selected.eventId}/event-admin-grant/disable`,
                          { method: "POST", headers: { "content-type": "application/json" } },
                        );
                        await refresh();
                      })
                    }
                  >
                    Disable Grant
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || eventAdminGrant?.status !== "active"}
                    onClick={() =>
                      void run(async () => {
                        await request(
                          `/api/admin/events/${selected.eventId}/event-admin-grant/revoke`,
                          { method: "POST", headers: { "content-type": "application/json" } },
                        );
                        await refresh();
                      })
                    }
                  >
                    Revoke Grant
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      busy || eventAdminGrant?.status === "active" || eventAdminGrant === null
                    }
                    onClick={() =>
                      void run(async () => {
                        await request(
                          `/api/admin/events/${selected.eventId}/event-admin-grant/reactivate`,
                          { method: "POST", headers: { "content-type": "application/json" } },
                        );
                        setRevealedCredential(null);
                        await refresh();
                      })
                    }
                  >
                    Reactivate Grant
                  </Button>
                </div>
                {qrDataUrl ? (
                  <div className="space-y-2 rounded-md border bg-white p-3">
                    <img
                      alt="Event Admin Grant QR code"
                      className="mx-auto size-80 max-w-full"
                      src={qrDataUrl}
                    />
                    <p className="text-center text-xs text-muted-foreground">
                      Scan this protected QR code on the Event Admin device.
                    </p>
                  </div>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="game-day-date">Add Game Day</Label>
                <div className="flex gap-2">
                  <Input
                    id="game-day-date"
                    type="date"
                    value={gameDayDate}
                    onChange={(event) => setGameDayDate(event.target.value)}
                  />
                  <Button
                    disabled={busy || gameDayDate.length === 0}
                    onClick={() =>
                      void run(async () => {
                        await request(`/api/admin/events/${selected.eventId}/game-days`, {
                          method: "POST",
                          headers: {
                            "content-type": "application/json",
                            "x-technical-admin-csrf": "1",
                          },
                          body: JSON.stringify({ date: gameDayDate }),
                        });
                        setGameDayDate("");
                        await refresh();
                      })
                    }
                    type="button"
                  >
                    Add
                  </Button>
                </div>
              </div>
              <ul className="space-y-1 text-sm">
                {selected.gameDays.map((day) => (
                  <li className="flex items-center justify-between gap-2" key={day.gameDayId}>
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Game Day ${day.gameDayId} date`}
                        id={`game-day-date-${day.gameDayId}`}
                        type="date"
                        value={editedGameDays[day.gameDayId] ?? day.date}
                        onChange={(event) =>
                          setEditedGameDays((current) => ({
                            ...current,
                            [day.gameDayId]: event.target.value,
                          }))
                        }
                      />
                      <span>{day.classification}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        disabled={busy || (editedGameDays[day.gameDayId] ?? day.date).length === 0}
                        onClick={() =>
                          void run(async () => {
                            await request(
                              `/api/admin/events/${selected.eventId}/game-days/${day.gameDayId}`,
                              {
                                method: "PATCH",
                                headers: {
                                  "content-type": "application/json",
                                  "x-technical-admin-csrf": "1",
                                },
                                body: JSON.stringify({
                                  date: editedGameDays[day.gameDayId] ?? day.date,
                                }),
                              },
                            );
                            await refresh();
                          })
                        }
                        size="sm"
                        type="button"
                      >
                        Save Game Day
                      </Button>
                      <Button
                        onClick={() =>
                          void run(async () => {
                            await request(
                              `/api/admin/events/${selected.eventId}/game-days/${day.gameDayId}`,
                              {
                                method: "DELETE",
                                headers: { "x-technical-admin-csrf": "1" },
                              },
                            );
                            await refresh();
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
                {selected.gameDays.length === 0 ? (
                  <li className="text-muted-foreground">No Game Days.</li>
                ) : null}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Select an Event to inspect it.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AdminCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </main>
  );
}

type RegistrationOptionsResponse = {
  challengeId: string;
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  timeout: number;
  attestation: "none";
  authenticatorSelection: { residentKey: "required"; userVerification: "required" };
};

type AuthenticationOptionsResponse = {
  challengeId: string;
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ id: string; type: "public-key" }>;
  timeout: number;
  userVerification: "required";
};

async function createCredential(options: RegistrationOptionsResponse) {
  if (!window.PublicKeyCredential || !navigator.credentials.create)
    throw new Error("WebAuthn unavailable.");
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: decode(options.challenge),
      user: { ...options.user, id: decode(options.user.id) },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey returned.");
  return credential;
}

async function getCredential(options: AuthenticationOptionsResponse) {
  if (!window.PublicKeyCredential || !navigator.credentials.get)
    throw new Error("WebAuthn unavailable.");
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: decode(options.challenge),
      allowCredentials: options.allowCredentials.map((item) => ({ ...item, id: decode(item.id) })),
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey returned.");
  return credential;
}

function serializeCredential(credential: PublicKeyCredential) {
  const response = credential.response;
  const common = { clientDataJSON: encode(new Uint8Array(response.clientDataJSON)) };
  if ("attestationObject" in response) {
    const registration = response as AuthenticatorAttestationResponse;
    return {
      id: credential.id,
      type: credential.type,
      response: {
        ...common,
        attestationObject: encode(new Uint8Array(registration.attestationObject)),
      },
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    type: credential.type,
    response: {
      ...common,
      authenticatorData: encode(new Uint8Array(assertion.authenticatorData)),
      signature: encode(new Uint8Array(assertion.signature)),
    },
  };
}

function encode(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
function decode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if ((init.method ?? "GET").toUpperCase() !== "GET") {
    const csrf = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("__Host-technical-admin-csrf="))
      ?.slice("__Host-technical-admin-csrf=".length);
    if (csrf) headers.set("x-technical-admin-csrf", csrf);
  }
  return fetch(input, { ...init, headers });
}
