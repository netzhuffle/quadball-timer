# Deploy every deploy-affecting main change automatically

Status: temporary post-SQM policy, accepted 24 August 2026.

Every push to `main` that changes a runtime, build, dependency, release-bundle,
activation, or deployment-workflow input builds and verifies one immutable
Release Bundle. The workflow activates and verifies that bundle in Test first.
Only after Test succeeds does Production automatically activate the exact same
bundle without rebuilding it.

The workflow trigger uses a conservative negative list for known
documentation-only, test-only, focused-test-only, and type-declaration-only
paths. Those pushes do not run any deployment stage. Any new or unclassified
path deploys by default, avoiding a missed deployment when a deployable input is
added without a corresponding trigger update.

The `production` GitHub Environment remains attached to the Production job so
its environment-scoped secrets, variables, URL, and deployment history remain
intact, but it has no required-reviewer protection rule while this policy is in
effect. The deployment concurrency group remains non-cancelling, so releases do
not overlap or supersede an in-progress activation.

This supersedes only the manual Production Approval from the SQM deployment
policy. Artifact immutability, Test-before-Production ordering, activation
backup and rollback behavior, release identity checks, and deployment outcome
reporting remain required.
