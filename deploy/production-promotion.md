# Production Promotion

The merge workflow builds one Release Bundle, activates and verifies Test, then
automatically activates Production. Production uses that exact shared bundle.
This is the temporary post-SQM policy; the `production` GitHub Environment is
retained for its environment-scoped configuration but has no required reviewer.

1. Open the deployment run for the deploy-affecting push to `main`.
2. Confirm Test Activation and its smoke checks pass. A Test failure prevents
   Production from starting.
3. Confirm the automatically started Production job's bounded activation and
   public smoke check are green. If Test or Production verification fails, do
   not rebuild locally; investigate the exact workflow run.

The deployment workflow uses a non-cancelling concurrency group. A second
merge waits for the first rather than cancelling or overlapping it.
