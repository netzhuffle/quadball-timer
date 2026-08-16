# Test Environment Technical Admin bootstrap checklist

Run this checklist against the disposable Test Environment before any
Production enrollment or reset. It is human verification evidence, not a
Qualification Test, deployment approval, or Production authorization.

1. From an interactive host-operator terminal, run the fixed runner with
   `test status`. Confirm the output contains only the Test Environment name,
   credential presence, active session count, and storage readiness. Confirm it
   contains no origin, RP ID, database path, credential, session token, or
   enrollment secret.
2. Run `test enroll` through the runner. Confirm the Test service stops and is
   confirmed active again before the one enrollment URL is printed. Open the
   URL in the Test browser and complete WebAuthn registration with user
   verification, then sign in through the normal browser ceremony.
3. Confirm a second `test enroll` is rejected and does not replace the active
   credential or existing session.
4. Create a second Test browser session, then run `test reset`. Type exactly
   `test` at the interactive prompt. Confirm the service is restarted and the
   runner prints one new enrollment URL only after it is active.
5. Confirm the old passkey, old browser session, and any pre-reset transient
   authority are rejected. Register the replacement Test passkey and complete a
   fresh browser sign-in.
6. Record only non-secret outcomes. Do not copy Test URLs, credentials, session
   tokens, database contents, or logs into Production or into repository files.
