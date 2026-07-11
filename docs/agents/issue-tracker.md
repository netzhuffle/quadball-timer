# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Use the `gh` CLI for all operations and infer the repository from the current clone.

## Conventions

- **Create:** `gh issue create --title "..." --body-file <path>`
- **Read:** `gh issue view <number> --comments`
- **List:** use `gh issue list` with explicit state and label filters; request JSON for machine-readable output.
- **Comment:** `gh issue comment <number> --body-file <path>`
- **Label:** `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close:** post any closing explanation, then run `gh issue close <number>`.

Use `--body-file` for multiline content so commands remain compatible with fish shell. When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: yes.**

External pull requests run through the same labels and states as issues. Include authors whose `authorAssociation` is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`; exclude `OWNER`, `MEMBER`, and `COLLABORATOR`.

- Read with `gh pr view <number> --comments` and `gh pr diff <number>`.
- List with `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, then filter by author association.
- Comment, label, and close with the corresponding `gh pr` commands.

GitHub shares one number space across issues and pull requests. For an ambiguous `#<number>`, try `gh pr view` and fall back to `gh issue view`.

## Wayfinding operations

- **Map:** one issue labelled `wayfinder:map`, containing Notes, Decisions so far, and Fog.
- **Child:** a GitHub sub-issue labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. If sub-issues are unavailable, use a task-list link and add `Part of #<map>` to the child.
- **Blocking:** use native issue dependencies. If unavailable, add `Blocked by: #<number>` near the top of the child body. A child is unblocked when every blocker is closed.
- **Frontier:** choose the first open child in map order that has no open blocker and no assignee.
- **Claim:** assign the issue to yourself before starting work.
- **Resolve:** comment with the answer, close the child, and add a context pointer to the map's Decisions so far.
