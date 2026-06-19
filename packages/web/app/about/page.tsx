import Link from "next/link";

const connectorSummaries = [
  {
    title: "Gmail",
    body: "Read and summarize authorized mailbox content, extract follow-ups, and create drafts only when the user requests those actions."
  },
  {
    title: "Calendar",
    body: "Read authorized calendar context so Veslo can summarize schedules, prepare for meetings, and answer user-requested scheduling questions."
  },
  {
    title: "Drive",
    body: "Search and read authorized Drive files so users can use their own documents as context for Veslo agent workflows."
  }
];

export default function AboutPage() {
  return (
    <main className="ow-legal-shell">
      <div className="ow-legal-container">
        <nav className="ow-legal-nav" aria-label="Veslo public navigation">
          <Link href="/">Veslo</Link>
          <Link href="/privacy">Privacy Policy</Link>
        </nav>

        <article className="ow-legal-doc">
          <p className="ow-legal-kicker">Veslo Cloud</p>
          <h1>Veslo connects work tools to private agent workspaces.</h1>
          <p>
            Veslo is a cloud-backed control surface for agentic work. It helps users and teams connect work tools,
            run agent workflows, and keep control over the services and data they authorize.
          </p>
          <p>
            The Google Workspace connectors are optional. Each connector starts with Google OAuth, requests only the
            scopes needed for that connector, and can be disconnected in Veslo or revoked from the user&apos;s Google
            Account permissions.
          </p>

          <h2>Google Workspace Connectors</h2>
          <div className="ow-about-grid">
            {connectorSummaries.map((connector) => (
              <section className="ow-about-item" key={connector.title}>
                <h3>{connector.title}</h3>
                <p>{connector.body}</p>
              </section>
            ))}
          </div>

          <h2>Data Use</h2>
          <p>
            Veslo uses Google Workspace data only to provide the actions a user asks Veslo to perform. Veslo does not
            sell Google Workspace data and does not use it for advertising. OAuth grants are stored encrypted.
          </p>
        </article>
      </div>
    </main>
  );
}
