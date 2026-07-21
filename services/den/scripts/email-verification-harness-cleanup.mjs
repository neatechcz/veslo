const SAFE_EMAIL_VERIFICATION_PROJECT = /^veslo-den-email-verification-[a-f0-9]{6,32}$/

export async function assertComposeProjectResourcesAbsent(composeProject, capture) {
  if (!SAFE_EMAIL_VERIFICATION_PROJECT.test(composeProject)) {
    throw new Error(`Refusing to audit an unexpected Docker Compose project: ${composeProject}`)
  }

  const label = `label=com.docker.compose.project=${composeProject}`
  const queries = [
    ["containers", ["ps", "-aq", "--filter", label]],
    ["networks", ["network", "ls", "-q", "--filter", label]],
    ["volumes", ["volume", "ls", "-q", "--filter", label]],
  ]
  const survivors = []
  for (const [kind, args] of queries) {
    const output = (await capture("docker", args)).trim()
    if (output) survivors.push(`${kind}=${output.split(/\s+/).join(",")}`)
  }
  if (survivors.length > 0) {
    throw new Error(
      `Docker Compose resources remain after cleanup: ${survivors.join("; ")}; project=${composeProject}`,
    )
  }
}

export function combineAcceptanceAndCleanupErrors(acceptanceError, cleanupError) {
  if (acceptanceError && cleanupError) {
    return new AggregateError(
      [acceptanceError, cleanupError],
      "Email verification acceptance and cleanup both failed.",
    )
  }
  return acceptanceError ?? cleanupError ?? null
}
