# Activate Test automatically and promote Production manually

After an eligible merge to `main`, GitHub Actions builds one immutable Release Bundle and performs Test Activation only. Production is handled by a separately dispatched workflow that accepts only a successful `main` Promotion Source Run whose Test Activation succeeded, downloads that exact artifact without rebuilding, and pauses for the required `production` Environment Production Approval; this keeps ordinary merges green while preventing an unreviewed restart of the SQM Production service.

The Production promotion workflow is non-cancelling and fails closed when the source run, Test outcome, release identity, or artifact is invalid or unavailable. The single-operator SQM setup allows `netzhuffle` to approve its own promotion; no timeout promotes an unapproved release.
