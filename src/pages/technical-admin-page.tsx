import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type AdminSession = { authenticated: true; environment: "production" | "test" };

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
    void fetch("/api/admin/session").then(async (response) => {
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
              const optionsResponse = await fetch("/api/admin/enrollment/options", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: enrollmentToken }),
              });
              if (!optionsResponse.ok) throw new Error("Enrollment is unavailable.");
              const options = (await optionsResponse.json()) as RegistrationOptionsResponse;
              const credential = await createCredential(options);
              const complete = await fetch("/api/admin/enrollment/complete", {
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
              const optionsResponse = await fetch("/api/admin/authentication/options", {
                method: "POST",
              });
              if (!optionsResponse.ok) throw new Error("Sign-in unavailable.");
              const options = (await optionsResponse.json()) as AuthenticationOptionsResponse;
              const credential = await getCredential(options);
              const complete = await fetch("/api/admin/authentication/complete", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  challengeId: options.challengeId,
                  response: serializeCredential(credential),
                }),
              });
              if (!complete.ok) throw new Error("Sign-in failed.");
              const sessionResponse = await fetch("/api/admin/session");
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
      <Button
        variant="outline"
        onClick={() =>
          void run(async () => {
            await fetch("/api/admin/logout", { method: "POST" });
            setSession(null);
          })
        }
      >
        Sign out
      </Button>
    </AdminCard>
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
