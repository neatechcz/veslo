# Cloud Deployments

This document defines the operational deploy policy for Veslo cloud services.

Veslo is local-first. Cloud services are data, sync, auth, and provisioning infrastructure. They must not be treated as the default application runtime under test.

## Den control plane on Render

The Den control-plane Render service is deployed explicitly. A commit, push, or merge to `main` or `dev` must not deploy it by itself.

Deploys are run through the `Deploy Den` GitHub Actions workflow. That workflow is intentionally `workflow_dispatch` only.

To deploy Den:

1. Open GitHub Actions.
2. Select `Deploy Den`.
3. Run the workflow manually.
4. Leave the `branch` input empty to use the configured branch resolution, or enter a branch to override it for that run.

The workflow resolves the Render source branch in this order:

1. Manual `branch` workflow input.
2. `DEN_RENDER_CONTROL_PLANE_BRANCH` GitHub Actions variable.
3. The selected workflow branch.

During every manual deploy, the workflow also patches the Render control-plane service with `autoDeploy: no`. This keeps native Render auto-deploy disabled even if the dashboard setting drifted.

## Render auto-deploy policy

Render Auto-Deploy must remain off for the Den control-plane service.

If an operator needs to check or repair the live setting outside GitHub Actions:

1. Open the service in the Render Dashboard.
2. Go to service settings.
3. Set Auto-Deploy to Off.

The equivalent Render API update is:

```json
{
  "autoDeploy": "no"
}
```

Manual deploys remain allowed through the GitHub Actions workflow. Do not use native Render auto-deploy, deploy hooks, or push-triggered GitHub Actions for the Den control plane unless this document and the workflow are updated in the same change.

## Worker services

Den-provisioned worker services are created with Render auto-deploy disabled. Worker service creation is part of the Den provisioning flow, not the control-plane release flow.

## Verification

For changes to Den deployment behavior:

1. Confirm `Deploy Den` has no `push` trigger.
2. Confirm the workflow patches the Render control-plane service with `autoDeploy: no`.
3. Confirm this document and any service-local deployment notes match the workflow.
4. If a live Render change is required immediately, apply the dashboard/API setting directly or run the manual workflow after the workflow change is available on GitHub.
