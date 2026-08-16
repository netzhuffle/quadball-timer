# Production Promotion

The merge workflow deploys and verifies Test only. Production is activated only
by promoting the exact Release Bundle that passed Test.

1. Open the successful `Deploy Test environment` run for the desired merge to
   `main`. Record its run ID and attempt number. The Test job must be green.
2. In Actions, choose `Promote Production release` → `Run workflow` on `main`.
   Enter that run ID and attempt number exactly; do not use a different run or
   rebuild locally.
3. The workflow verifies the source run, its `deploy-test` success, its
   immutable artifact, and its release identity before it can reach the
   Production job.
4. Approve the pending `production` Environment deployment as `netzhuffle`.
   Approval is required even after manually dispatching the workflow; there is
   no timeout-based promotion and administrators cannot bypass the gate.
5. Confirm the Production job's bounded activation and public smoke check are
   green. If source validation, artifact download, activation, or verification
   fails, do not retry with a rebuilt artifact; investigate the exact source run.

The promotion workflow uses a non-cancelling Production concurrency group. A
second promotion waits for the first rather than cancelling or overlapping it.
