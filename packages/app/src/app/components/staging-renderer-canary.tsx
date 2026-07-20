export const STAGING_RENDERER_CANARY_MARKER = "veslo.staging.renderer_canary";

/**
 * A staging-only compile-time entry point for validating renderer error capture.
 * It is dynamically imported only when Vite bakes the staging canary flag into
 * the build, so production and ordinary staging artifacts omit this module.
 */
export default function StagingRendererCanary(): never {
  throw new Error(STAGING_RENDERER_CANARY_MARKER);
}
