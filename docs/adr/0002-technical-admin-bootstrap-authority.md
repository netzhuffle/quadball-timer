# Keep Technical Admin bootstrap authority separate from deployment

Technical Admin Enrollment Authorizations and deliberate passkey resets are exercised only by a human host operator through interactive sudo and a root-owned runner that invokes the reviewed compiled release as the selected Environment's service user. Deployment automation may install that runner but cannot invoke it, and no public endpoint, source checkout, Bun installation, file drop, or environment edit substitutes for this bootstrap authority; this keeps deployment compromise from becoming Technical Admin takeover while making enrollment and recovery available on immutable hosts.

## Local development exception

The host-operator rule above governs deployed Test and Production. A developer's
local worktree may invoke the existing bootstrap CLI from source to enroll its
own Technical Admin against an HTTPS preview origin. The development launcher
requires `NODE_ENV=development`, uses the Test environment and worktree-local
credential storage, and refuses a Production invocation. This exception does not
authorize enrollment or reset on deployed hosts; local HTTP keeps Technical Admin
authentication disabled. Codex's worktree setup hook initializes development
state only and does not issue an Enrollment Authorization.
