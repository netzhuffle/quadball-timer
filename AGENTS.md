## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues, and external contributor pull requests are a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.

### Testing policy

Before adding, changing, reviewing, or running any qualification, soak, load, crash, recovery, or exact-production-artifact test, read `docs/agents/testing.md`. Run a Qualification Test only when the user explicitly names it and invokes `$run-qualification-tests`; ordinary implementation, code review, `bun run test`, `bun run check`, and automatically triggered CI stay on the fast boundary.
