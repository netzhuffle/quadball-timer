# Activate Test automatically and promote Production manually

Status: temporarily superseded on 24 August 2026 by the post-SQM automatic
deployment policy in
[`0005-post-sqm-automatic-deployment.md`](0005-post-sqm-automatic-deployment.md).

After an eligible merge to `main`, GitHub Actions builds one immutable Release Bundle and performs Test Activation first. The dependent Production job downloads that exact shared artifact without rebuilding and pauses for the required `production` Environment Production Approval; this keeps one artifact chain and prevents an unreviewed restart of the SQM Production service.

The deployment workflow is non-cancelling and Test failure prevents Production from starting. The single-operator SQM setup allows `netzhuffle` to approve its own promotion; no timeout promotes an unapproved release.
