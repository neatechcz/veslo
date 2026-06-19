import Link from "next/link";

const googleDataUses = [
  "Gmail connectors may access message metadata, message content, labels, attachments, and draft data only after you authorize Gmail access.",
  "Calendar connectors may access calendar lists, free/busy information, and event details only after you authorize Calendar access.",
  "Drive connectors may access file metadata and file content needed for the Drive actions you request only after you authorize Drive access."
];

const dataUsePurposes = [
  "connect Veslo to the Google Workspace account you authorize",
  "search, summarize, display, draft, or otherwise process Google Workspace data when you request it in Veslo",
  "maintain, secure, troubleshoot, and audit the connector service",
  "store outputs or workspace records that you choose to keep in Veslo"
];

export default function PrivacyPage() {
  return (
    <main className="ow-legal-shell">
      <div className="ow-legal-container">
        <nav className="ow-legal-nav" aria-label="Veslo legal navigation">
          <Link href="/">Veslo</Link>
          <Link href="/terms">Terms</Link>
        </nav>

        <article className="ow-legal-doc">
          <p className="ow-legal-kicker">Effective date: June 19, 2026</p>
          <h1>Privacy Policy</h1>
          <p>
            Veslo is operated by Neatech. This policy explains how Veslo handles data for app.veslo.work,
            api.veslo.work, and the optional Veslo Google Workspace connectors.
          </p>

          <h2>Google Workspace Data</h2>
          <p>
            Google Workspace connectors are optional. Veslo accesses Google data only after a user authorizes a
            specific connector with Google OAuth.
          </p>
          <ul>
            {googleDataUses.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>

          <h2>How Veslo Uses Data</h2>
          <p>Veslo uses authorized Google Workspace data to:</p>
          <ul>
            {dataUsePurposes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            Veslo does not use Google Workspace data for advertising and does not sell Google Workspace data.
          </p>

          <h2>Storage and Protection</h2>
          <p>
            Veslo stores OAuth grants so that authorized connectors can keep working. OAuth grant data is encrypted
            at rest. Veslo uses HTTPS in transit, access controls, and operational monitoring to protect the service.
            Google Workspace content may be processed transiently to complete requested actions. Outputs that a user
            chooses to save may remain in Veslo workspace or session records.
          </p>

          <h2>Sharing</h2>
          <p>
            Veslo does not share Google Workspace data except as needed to provide and secure the Veslo service,
            comply with law, or respond to abuse, security, or support issues. Service providers may process data
            only for those purposes.
          </p>

          <h2>Google API Limited Use</h2>
          <p>
            Veslo&apos;s use and transfer of information received from Google APIs adheres to the Google API
            Services User Data Policy, including the Limited Use requirements.
          </p>

          <h2>Your Controls</h2>
          <p>
            You can disconnect a Google Workspace connector in Veslo or revoke Veslo&apos;s access from your Google
            Account permissions. To request deletion or support, contact vaclav.soukup@neatech.cz.
          </p>
        </article>
      </div>
    </main>
  );
}
