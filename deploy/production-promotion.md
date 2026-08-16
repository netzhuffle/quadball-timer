# Production Promotion

The merge workflow builds one Release Bundle, activates and verifies Test, then
waits before Production activation. Production uses that exact shared bundle.

1. Open the successful deployment run for the desired merge to `main`.
2. Wait for Test Activation and its smoke checks to pass.
3. Open the pending `production` Environment review and approve it as
   `netzhuffle`. Approval is required before the Production job starts; there is
   no timeout-based activation and administrators cannot bypass the gate.
4. Confirm the Production job's bounded activation and public smoke check are
   green. If Test or Production verification fails, do not rebuild locally;
   investigate the exact workflow run.

The deployment workflow uses a non-cancelling concurrency group. A second
merge waits for the first rather than cancelling or overlapping it.
