const fs = require("fs");
const path = require("path");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  Header,
  Footer,
  AlignmentType,
  LevelFormat,
  HeadingLevel,
  BorderStyle,
  WidthType,
  ShadingType,
  PageNumber,
  PageBreak,
  TabStopType,
  TabStopPosition,
} = require("docx");

const PAGE_W = 11906; // A4
const PAGE_H = 16838;
const MARGIN = 1134;
const CONTENT_W = PAGE_W - MARGIN * 2;

const COL_GREY = "595959";
const COL_LIGHT_GREY = "D9D9D9";
const COL_HEADER_FILL = "1F3A5F";
const COL_ROW_ALT = "F2F4F8";
const COL_ACCENT = "1F3A5F";
const COL_HIGHLIGHT_FILL = "EAF1FB";
const COL_ROADMAP_FILL = "FFF6E5";
const COL_ROADMAP_BORDER = "E0B66B";

const border = { style: BorderStyle.SINGLE, size: 4, color: COL_LIGHT_GREY };
const cellBorders = { top: border, bottom: border, left: border, right: border };

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 120, before: opts.before ?? 0, line: 300 },
    alignment: opts.alignment,
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        color: opts.color,
        size: opts.size,
      }),
    ],
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 180 },
    children: [new TextRun({ text, bold: true, size: 32, color: COL_ACCENT })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 140 },
    children: [new TextRun({ text, bold: true, size: 26, color: COL_ACCENT })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 220, after: 120 },
    children: [new TextRun({ text, bold: true, size: 22, color: "262626" })],
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: "bullets", level },
    spacing: { after: 80, line: 300 },
    children: [new TextRun({ text })],
  });
}

function bulletBoldLead(lead, rest, level = 0) {
  return new Paragraph({
    numbering: { reference: "bullets", level },
    spacing: { after: 80, line: 300 },
    children: [
      new TextRun({ text: lead, bold: true }),
      new TextRun({ text: rest }),
    ],
  });
}

function calloutBox(lines, fill = COL_HIGHLIGHT_FILL, borderColor = COL_LIGHT_GREY) {
  const calloutBorder = { style: BorderStyle.SINGLE, size: 6, color: borderColor };
  const cb = { top: calloutBorder, bottom: calloutBorder, left: calloutBorder, right: calloutBorder };
  const rows = lines.map((line, idx) => {
    return new TableRow({
      children: [
        new TableCell({
          borders: cb,
          width: { size: CONTENT_W, type: WidthType.DXA },
          shading: { fill, type: ShadingType.CLEAR, color: "auto" },
          margins: { top: 160, bottom: 160, left: 240, right: 240 },
          children: [
            new Paragraph({
              spacing: { line: 300, after: idx === lines.length - 1 ? 0 : 80 },
              children: [
                new TextRun({
                  text: line.text,
                  bold: line.bold,
                  size: line.size ?? 22,
                  color: line.color ?? "1F3A5F",
                }),
              ],
            }),
          ],
        }),
      ],
    });
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    rows,
  });
}

function cell({ text, widthDxa, header = false, altRow = false, bold = false }) {
  const fill = header ? COL_HEADER_FILL : altRow ? COL_ROW_ALT : "FFFFFF";
  const color = header ? "FFFFFF" : "262626";
  return new TableCell({
    borders: cellBorders,
    width: { size: widthDxa, type: WidthType.DXA },
    shading: { fill, type: ShadingType.CLEAR, color: "auto" },
    margins: { top: 120, bottom: 120, left: 160, right: 160 },
    children: [
      new Paragraph({
        spacing: { line: 280 },
        children: [
          new TextRun({
            text,
            bold: header || bold,
            color,
            size: 20,
          }),
        ],
      }),
    ],
  });
}

function buildTable(headers, rows, columnWidths) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((t, i) =>
      cell({ text: t, widthDxa: columnWidths[i], header: true })
    ),
  });
  const bodyRows = rows.map(
    (r, rIdx) =>
      new TableRow({
        children: r.map((t, i) =>
          cell({
            text: t,
            widthDxa: columnWidths[i],
            altRow: rIdx % 2 === 1,
            bold: i === 0,
          })
        ),
      })
  );
  return new Table({
    width: { size: columnWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths,
    rows: [headerRow, ...bodyRows],
  });
}

function spacer(size = 80) {
  return new Paragraph({ spacing: { after: size }, children: [new TextRun("")] });
}

const coverChildren = [
  new Paragraph({
    spacing: { before: 2200, after: 360 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Veslo", bold: true, size: 72, color: COL_ACCENT })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [
      new TextRun({ text: "Security & Data Processing Overview", bold: true, size: 40, color: "262626" }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 480 },
    children: [
      new TextRun({
        text: "Reference document for client IT and information-security review",
        italics: true, size: 24, color: COL_GREY,
      }),
    ],
  }),
  calloutBox([
    { text: "Local-first runtime — ready for on-premise deployment", bold: true, size: 28 },
    {
      text:
        "The agentic runtime executes on the user's own device. Customer files and workspaces stay on-device by default. The architecture is suitable for fully on-premise deployment inside the client's network.",
      size: 22, color: "262626",
    },
  ]),
  spacer(240),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 },
    children: [
      new TextRun({
        text: "AI inference: managed external provider, contractually configured for Zero Data Retention (ZDR).",
        size: 22, color: "262626",
      }),
    ],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 },
    children: [
      new TextRun({
        text:
          "Native local inference and own-inference deployments are on the active product roadmap (see Section 13).",
        italics: true, size: 22, color: COL_GREY,
      }),
    ],
  }),
  new Paragraph({ children: [new PageBreak()] }),
];

const tocChildren = [
  h1("Contents"),
  p("1.  Executive summary"),
  p("2.  Local-first foundation and on-premise readiness"),
  p("3.  System architecture and runtime model"),
  p("4.  Data classification and data flow"),
  p("5.  AI provider integration: managed access with Zero Data Retention"),
  p("6.  Identity, authentication and session handoff"),
  p("7.  Authorization and permission model"),
  p("8.  Credential and secret management"),
  p("9.  Network and transport security"),
  p("10. Audit, observability and traceability"),
  p("11. Multi-device behaviour and data residency"),
  p("12. Compliance posture"),
  p("13. Roadmap: local inference, own inference, attestations"),
  p("14. Vulnerability disclosure and security operations"),
  p("Appendix A. At-a-glance security statement"),
  p("Appendix B. Glossary"),
  new Paragraph({ children: [new PageBreak()] }),
];

const sec1 = [
  h1("1. Executive summary"),
  p(
    "Veslo is a local-first, cloud-backed control surface for agentic work. The desktop application runs the entire agentic workflow on the user's own device. Workspace files, source code and tool execution stay on-device by default. This local-first foundation is what makes Veslo directly suitable for on-premise deployment inside the client's own infrastructure."
  ),
  p(
    "AI inference is currently delegated to a managed external AI provider through a centrally administered access policy. The provider is contractually configured under the Zero Data Retention (ZDR) data-processing mode: the provider does not retain prompts or completions, does not log request and response bodies, and does not use customer content to train, improve or evaluate any models. The identity, jurisdiction and DPA terms of the upstream provider are disclosed under the master agreement and the sub-processor list, not in this overview document."
  ),
  p(
    "In parallel, Veslo is actively developing native local inference and customer-hosted on-premise inference. Both are described in Section 13. Once delivered, customers requiring strict locality will be able to remove the external provider from the deployment entirely."
  ),
  p("Key security properties:", { bold: true, after: 80, before: 80 }),
  bulletBoldLead("Local-first execution. ", "Workspace files stay on the user's device by default."),
  bulletBoldLead("On-premise ready. ", "The runtime is local by architecture and can be deployed inside the client's network."),
  bulletBoldLead("Centralized AI access. ", "End users do not hold provider keys; administrators bind users to approved providers and models."),
  bulletBoldLead("Zero Data Retention. ", "Prompts and completions are processed transiently by the AI provider and discarded."),
  bulletBoldLead("Two-layer authorization. ", "Workspaces are explicitly authorized; the engine asks before each sensitive action."),
  bulletBoldLead("Credentials in OS keychain. ", "End-user secrets stay on-device; provider credentials are server-side only."),
  bulletBoldLead("End-to-end audit trail. ", "Every run produces an exportable record of prompts, plan, tool calls, decisions and outputs."),
  bulletBoldLead("TLS 1.3 everywhere. ", "All cloud-bound traffic is encrypted; the local engine binds to loopback only."),
];

const sec2 = [
  h1("2. Local-first foundation and on-premise readiness"),
  p(
    "Veslo's runtime is local by design, not by configuration. The desktop application starts a local engine bound to the loopback interface (127.0.0.1) on the user's device. All sessions run against real workspace directories on that device. Customer source material — files, attachments, command output — is processed in place and does not leave the device unless the user takes an explicit action."
  ),
  p(
    "Two categories of data cross the device boundary by default: AI traffic to the configured provider (under ZDR; see Section 5) and synced metadata to Veslo Cloud. Both paths are TLS-protected. Where the user pastes file content into a prompt, that content travels to the provider as prompt data — described in Sections 4 and 5."
  ),
  h3("2.1 Suitability for on-premise deployment"),
  bullet("The desktop client and the local engine run entirely on customer-controlled endpoints and customer-controlled networks."),
  bullet("Identity and synchronization can be operated against a customer-hosted control plane in place of Veslo Cloud (see Section 13 for current availability)."),
  bullet("Outbound connectivity can be restricted to a small, well-defined endpoint list, or eliminated entirely once on-premise inference is in place."),
  bullet("No customer file is required to traverse Veslo Cloud or any external service for the core workflow to operate."),
  spacer(60),
  calloutBox([
    { text: "Net effect for IT", bold: true, size: 24 },
    {
      text:
        "Today the runtime is on-premise-ready and the AI provider operates under ZDR. As the items in Section 13 land, the same runtime can be operated end-to-end inside the client's network with no external AI dependency.",
      size: 22, color: "262626",
    },
  ]),
  spacer(80),
];

const sec3 = [
  h1("3. System architecture and runtime model"),
  p("Veslo has three architectural layers, each with a distinct security boundary."),
  h3("3.1 Local execution layer (default)"),
  bullet("The desktop application starts a local engine bound to the loopback interface (127.0.0.1)."),
  bullet("Sessions run against real workspace directories on the user's device."),
  bullet("Workspaces are either created by Veslo or selected via the operating system's native folder picker."),
  bullet("No inbound firewall rule is required for normal operation."),
  h3("3.2 Cloud-backed identity and synchronization"),
  bullet("Veslo Cloud stores account, organization, chat and session metadata."),
  bullet("Cloud is used for identity and synchronization; it is not the default execution environment."),
  bullet("In on-premise deployments, the identity and synchronization control plane can be hosted by the customer."),
  h3("3.3 Optional remote execution capability"),
  bullet("Remote execution against trusted runtimes is supported as a platform capability but is off by default."),
  bullet("Activation requires an administrator action and is recorded centrally so customers can verify whether it is enabled across their fleet."),
];

const sec4 = [
  h1("4. Data classification and data flow"),
  p(
    "The table below summarizes the categories of data Veslo handles. Where the present-day position differs from the on-premise/own-inference target, the row reflects the present day; the target state is described in Section 13."
  ),
  buildTable(
    ["Data category", "Processing location", "Transport / protection"],
    [
      ["Workspace files, source code, attachments", "User device only by default", "Not transmitted unless explicitly moved or pasted into a prompt"],
      ["Prompt and completion content (AI traffic)", "Routed via the Veslo AI gateway to the configured AI provider under ZDR", "TLS 1.3; transient processing only at the provider"],
      ["Account identity (email, organization)", "Veslo Cloud (or customer-hosted control plane on-premise)", "TLS 1.3; encrypted at rest"],
      ["Run / session metadata, audit records", "Veslo Cloud (or customer-hosted control plane on-premise)", "TLS 1.3; encrypted at rest; integrity-checked"],
      ["Provider credentials (managed)", "Platform credential pool, server-side only", "Never exposed to the desktop app"],
      ["End-user secrets / personal API keys", "Operating-system keychain on user's device", "Never written to repository or cloud"],
      ["Crash and error telemetry", "Veslo Cloud, opt-out per organization", "TLS 1.3; scrubbed of prompt/file content before transport"],
    ],
    [3300, 3000, 3338]
  ),
  spacer(120),
];

const sec5 = [
  h1("5. AI provider integration: managed access with Zero Data Retention"),
  p(
    "Veslo currently delegates upstream AI inference to a managed external AI provider. Access is mediated by Veslo's centrally managed AI access model and is contractually configured to operate under the provider's Zero Data Retention (ZDR) data-processing mode. The provider's identity, jurisdiction, ZDR contractual reference and the full sub-processor list are disclosed alongside the master agreement and the DPA."
  ),
  h2("5.1 Routing model"),
  bullet("End users do not supply their own provider API keys; the customer's administrator assigns each user a provider and a default model."),
  bullet("The desktop app sends the prompt to the local Veslo server, which forwards it to the Veslo-operated AI gateway, which selects a platform credential and forwards to the AI provider over TLS."),
  bullet("The provider processes the request under ZDR and returns the completion; the response is streamed back through the same path."),
  bullet("Provider credentials can be rotated centrally without any end-user action; every upstream request is attributable to a signed-in identity for audit."),
  h2("5.2 The Veslo AI gateway"),
  p(
    "The gateway is the only Veslo-operated component on the AI request path. It enforces the administrator's policy, selects the platform credential and forwards traffic upstream. It does not persist prompt or completion bodies; it logs only request metadata (timestamp, user, organization, model, token counts, outcome). It is multi-tenant with strict per-organization isolation, runs in the same region as the customer's Veslo Cloud deployment, and is in scope of Veslo's planned external attestations (see Section 13)."
  ),
  h2("5.3 Zero Data Retention (ZDR) — what it means"),
  bullet("The provider does not store prompts, completions or any tool-use payloads after the response has been returned, and does not write request or response bodies to its operational logs."),
  bullet("Customer content is not used to train, fine-tune, evaluate or otherwise improve any of the provider's models."),
  bullet("Data is processed in transit, for the duration of the request only."),
  bullet("ZDR is contractual; Veslo monitors the provider's terms and notifies customers if the contractual basis materially changes."),
  h2("5.4 Provider's broader security posture"),
  p(
    "Beyond ZDR, the AI provider's enterprise tier holds SOC 2 Type 2, enforces TLS for all API traffic, applies role-based internal access controls, and publishes a DPA and standard contractual clauses. Specific reports and clauses are referenced in the customer's DPA package."
  ),
  h2("5.5 What Veslo persists about AI traffic"),
  bullet("Request metadata: timestamp, user and organization identity, provider, model, token counts, outcome."),
  bullet("Audit-record content (see Section 10): prompts and any customer material inside them are stored in the run's audit record; retention is per-organization and governed by the DPA."),
  bullet("Synced chat history: only when the organization explicitly opts in; encrypted in transit and at rest; stays inside the customer environment in on-premise deployments."),
];

const sec6 = [
  h1("6. Identity, authentication and session handoff"),
  bullet("Authentication is browser-delegated; credentials never enter the desktop process. Sign-in is OIDC against the customer's identity provider (Google, Microsoft Entra ID, generic OIDC); MFA and step-up are enforced by the IdP and respected by Veslo. SAML 2.0 and SCIM are tracked in Section 13."),
  bullet("After a successful sign-in, the platform issues a single-use, time-bounded handoff code which the desktop app exchanges for a bearer token; the exchange is atomic and replay-protected at the database layer."),
  bullet("Bearer tokens have a short access-token lifetime with refresh, and are server-side revocable. Disabling a user at the IdP propagates to Veslo within the refresh window."),
  bullet("Worker tokens used by optional remote-execution capabilities are encrypted at rest with versioned cryptography; visibility is restricted and reveal events are audited."),
];

const sec7 = [
  h1("7. Authorization and permission model"),
  h3("7.1 Application-level authorization"),
  bullet("Workspaces are either implicitly created by Veslo or explicitly chosen via the OS folder picker."),
  bullet("Veslo remembers authorized roots per profile and per device; anything outside is denied by default."),
  bullet("Administrators can publish organization-wide deny lists (paths, file patterns, capabilities) that override end-user choices."),
  h3("7.2 Engine-level permissions"),
  bullet("The engine requests user permission for sensitive actions; Veslo surfaces scope and reason."),
  bullet("Choices: allow once, allow for the current session, or deny. Decisions are recorded in the run's audit log."),
  bullet("\"Allow once\" never expands persistent scope. \"Always allow\" is explicit and reversible, and can be disabled organization-wide by the administrator."),
];

const sec8 = [
  h1("8. Credential and secret management"),
  bullet("End-user credentials are stored in the OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). They are never written to repositories, project files or cloud storage."),
  bullet("Provider API keys are managed in a server-side credential pool; they are not transmitted to or visible from any end-user device."),
  bullet("Credential rotation is performed centrally and does not require end-user action."),
  bullet("Worker tokens for optional remote execution are encrypted at rest with versioned cryptography (envelope-encrypted with a KMS-managed key)."),
  bullet("Desktop binaries are signed (Apple notarization on macOS, Authenticode on Windows). Auto-update verifies signatures before applying any update."),
];

const sec9 = [
  h1("9. Network and transport security"),
  bullet("All cloud-bound traffic uses TLS 1.3. Certificate validation uses the OS trust store; pinning is not used so corporate TLS-inspection middleboxes remain compatible."),
  bullet("The local engine binds to loopback only and is not network-exposed. Origin and CSRF checks protect it from local cross-origin and DNS-rebinding attempts."),
  bullet("No inbound firewall rule is required. Outbound is required to the Veslo AI gateway and Veslo Cloud; in a fully on-premise deployment with own inference, outbound can be eliminated."),
  bullet("Optional remote-execution capability uses TLS 1.3 with explicit, scoped credentials when enabled."),
];

const sec10 = [
  h1("10. Audit, observability and traceability"),
  p("Every Veslo run produces an exportable audit record that includes:"),
  bullet("The user-supplied goal or prompt."),
  bullet("The plan generated and any user edits to it."),
  bullet("Every tool call performed by the agent, with arguments and outcome."),
  bullet("Every permission decision (allow once, allow for session, deny)."),
  bullet("Outputs and artifacts produced."),
  p(
    "Note on customer content in audit logs. Audit records contain user prompts. When a prompt contains customer source material, that material is therefore stored in the audit record. Retention is configurable per organization and governed by the DPA. In on-premise deployments, audit records remain inside the customer's environment.",
    { before: 60 }
  ),
  p(
    "Configuration changes (credential reveals, AI access policy changes, organization membership changes) emit structured audit events suitable for SIEM ingestion (JSON; CEF on request).",
    { before: 60 }
  ),
];

const sec11 = [
  h1("11. Multi-device behaviour and data residency"),
  bullet("A session is bound to its backing workspace directory on a specific device."),
  bullet("If the workspace exists only on one device, other devices show the session as view-only; continuation requires the workspace to be available there."),
  bullet("Cloud-synced metadata is stored in the region of the customer's Veslo Cloud deployment (EU and US regions today). On-premise deployments place residency inside the customer's network."),
  bullet("The configured AI provider operates under ZDR, so provider residency concerns transit only; with on-premise inference (Section 13) the question disappears entirely. For EU customers whose provider sits outside the EEA, Veslo executes EU SCCs and supplies a Transfer Impact Assessment template alongside the DPA."),
];

const sec12 = [
  h1("12. Compliance posture"),
  buildTable(
    ["Area", "Position"],
    [
      ["Sub-processor disclosure", "The full sub-processor list — including the upstream AI provider — is provided as a standard appendix to the DPA. It is updated with notice of changes."],
      ["AI provider data retention", "The configured AI provider operates under Zero Data Retention; prompts and completions are not retained or used for training."],
      ["AI provider attestation", "The AI provider holds SOC 2 Type 2; specific report references are included in the DPA package."],
      ["Veslo's own attestations", "External SOC 2 Type 2 and ISO 27001 are tracked in Section 13. Internal control documentation is available under NDA today."],
      ["Encryption in transit", "TLS 1.3 on all cloud-bound paths."],
      ["Encryption at rest", "AES-256 for cloud-stored metadata; envelope encryption for sensitive tokens; KMS-managed keys."],
      ["Data minimization", "Local-first execution keeps the bulk of customer content off the cloud by default; on-premise deployment keeps it inside the customer's network."],
      ["Access control", "Administrator-driven AI access policy, OS-keychain for end-user secrets, least-privilege folder authorization, organization-wide deny lists."],
      ["Auditability", "Per-run exportable audit records; structured audit events for security-relevant changes."],
      ["GDPR alignment", "DPA is a standard appendix to the master agreement; SCCs and Transfer Impact Assessment template are provided where international transfers apply."],
    ],
    [2800, 6838]
  ),
];

const sec13 = [
  h1("13. Roadmap: local inference, own inference, attestations"),
  p(
    "Forward-looking items referenced elsewhere are consolidated here. Each item is tracked under change-control; target windows are shared under NDA on request."
  ),
  h3("13.1 Native local inference"),
  p(
    "Small-to-mid open-weights models running on the user's own laptop or workstation, packaged with the desktop app and using on-device GPU or Neural Engine acceleration where available. Routine agentic tasks run locally; heavier work routes to 13.2 or to the external provider."
  ),
  bullet("Hardware target: modern Apple Silicon, or x86 with a workstation GPU (8 GB VRAM and up)."),
  bullet("Model lifecycle: signed model bundles, periodic refresh, offline (air-gapped) install supported."),
  bullet("Status: in active development."),
  h3("13.2 Own inference servers (on-premise)"),
  p(
    "A Veslo-supplied inference service running on customer-controlled GPU hardware inside the customer's network. It exposes the same internal API surface used by the rest of the Veslo runtime, so once it is in place no AI traffic leaves the customer network and no external AI provider participates in the request path."
  ),
  bulletBoldLead("Deployment tiers. ", "Workstation (single workstation-class GPU, single-user); department (one or more mid-range data-center GPUs, dozens of users); enterprise (dedicated GPU cluster, organization-wide)."),
  bulletBoldLead("Models. ", "Curated open-weights models, validated and updated by Veslo. Customers may also bring their own model image."),
  bulletBoldLead("Operation. ", "The customer operates the hardware and the network. Veslo supplies the signed inference image, signed model bundles, signed updates and monitoring tooling. Updates can be delivered offline for air-gapped sites."),
  bulletBoldLead("Resulting data flow. ", "Prompt traffic stays on the customer's network end-to-end; combined with 13.3 the audit records do as well."),
  bulletBoldLead("Status. ", "In active development."),
  h3("13.3 Customer-hosted Veslo control plane"),
  p(
    "Identity, organization, run/session metadata and audit storage hosted inside the customer's network instead of Veslo Cloud. Delivered as a signed container bundle; supports the same OIDC providers and policies as the hosted control plane. Combined with 13.2, this yields an end-to-end deployment in which no customer prompt, file or audit record crosses the customer's network boundary."
  ),
  bullet("Available today as a managed deployment under a separate engagement; self-service deployment is in active development."),
  h3("13.4 External attestations and assurance"),
  bullet("SOC 2 Type 2 and ISO 27001 for Veslo Cloud and the Veslo AI gateway."),
  bullet("Public bug-bounty programme and annual third-party penetration test summary, available under NDA."),
  h3("13.5 Enterprise identity completeness"),
  bullet("SAML 2.0 SSO, SCIM 2.0 provisioning, conditional-access signal pass-through. Tracked alongside the on-premise control plane."),
];

const sec14 = [
  h1("14. Vulnerability disclosure and security operations"),
  bullet("Reports go to the corporate security contact published on the Veslo website (security.txt and security@ alias). PGP key available."),
  bullet("Acknowledgement within one business day for high-severity reports; full triage within five business days."),
  bullet("Coordinated disclosure with the reporter, synchronized with the availability of a fix."),
  bullet("Annual third-party penetration test; executive summary available under NDA."),
];

const appendixA = [
  new Paragraph({ children: [new PageBreak()] }),
  h1("Appendix A. At-a-glance security statement"),
  buildTable(
    ["Question", "Answer"],
    [
      ["Are workspace files uploaded to the cloud by default?", "No. Files stay on-device unless the user explicitly pastes them into a prompt or moves them."],
      ["Can Veslo be deployed on-premise?", "Yes. The runtime is local-first by architecture. A customer-hosted control plane is available under a separate engagement; native local and own-inference are tracked in Section 13."],
      ["Does the AI provider store prompts or completions?", "No. The provider operates under Zero Data Retention."],
      ["Does the AI provider train on customer prompts?", "No. ZDR data is excluded from any training, fine-tuning or evaluation."],
      ["Is the AI provider named?", "Yes — in the sub-processor list appended to the DPA. It is not reproduced in this overview."],
      ["Where are credentials kept?", "End-user secrets in the OS keychain; provider API keys in a server-side credential pool that never reaches end-user devices."],
      ["Are prompts stored anywhere by Veslo?", "Yes — in the run's audit record. Retention is governed per organization by the DPA. In on-premise deployments, audit records stay inside the customer's network."],
      ["Is there an audit trail?", "Yes. Per-run, exportable, structured for SIEM (JSON; CEF on request)."],
      ["Is data encrypted in transit?", "Yes. TLS 1.3."],
      ["Is the local engine network-exposed?", "No. Loopback only, with origin and CSRF checks against local cross-origin and DNS-rebinding."],
      ["Is SSO supported?", "OIDC today (Google, Microsoft Entra ID, generic). SAML 2.0 and SCIM are tracked in Section 13."],
      ["Is a DPA available?", "Yes — as a standard appendix to the master agreement; SCCs and a TIA template are provided where international transfers apply."],
      ["Is Veslo SOC 2 / ISO 27001 attested?", "External attestations are tracked in Section 13. Internal control documentation is available under NDA today."],
    ],
    [4319, 5319]
  ),
];

const appendixB = [
  new Paragraph({ children: [new PageBreak()] }),
  h1("Appendix B. Glossary"),
  buildTable(
    ["Term", "Definition"],
    [
      ["ZDR (Zero Data Retention)", "A contractual AI-provider mode in which prompts and completions are processed transiently and not retained, logged or used for training."],
      ["On-premise deployment", "Deployment in which the Veslo runtime, and (per Section 13) the AI inference model itself, run inside the customer's own infrastructure."],
      ["Native local / own inference", "Veslo's in-development capability to run AI inference on customer-controlled hardware without a third-party AI provider."],
      ["Veslo AI gateway", "The Veslo-operated component that selects a platform credential, applies administrator policy and forwards prompt traffic upstream. Logs metadata only; does not persist prompt or completion bodies."],
      ["Workspace", "A directory on the user's device that scopes a Veslo session. Workspaces are explicitly authorized."],
      ["Run", "A single execution of a task. Each run produces an audit record and a set of artifacts."],
      ["Audit record", "An exportable, structured log of a run, including prompts, plan, tool calls, permission decisions and outputs."],
      ["Platform credential", "A provider API key held server-side by Veslo and used on behalf of users under the administrator's policy."],
      ["Handoff code", "A single-use, time-bounded code issued during browser sign-in; the desktop app exchanges it for a bearer token."],
      ["Loopback", "The 127.0.0.1 network interface, only reachable from the same device. The local engine binds here and nowhere else."],
    ],
    [3000, 6638]
  ),
];

const doc = new Document({
  creator: "Veslo",
  title: "Veslo — Security & Data Processing Overview",
  description:
    "Security overview for client IT, including managed AI access under Zero Data Retention, on-premise readiness, and roadmap for local/own inference.",
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: COL_ACCENT },
        paragraph: { spacing: { before: 360, after: 180 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: COL_ACCENT },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "Arial", color: "262626" },
        paragraph: { spacing: { before: 220, after: 120 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 480, hanging: 280 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 920, hanging: 280 } } } },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { after: 80 },
              children: [
                new TextRun({
                  text: "Veslo — Security & Data Processing Overview",
                  size: 18, color: COL_GREY, italics: true,
                }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
              children: [
                new TextRun({ text: "Confidential — for client IT review", size: 18, color: COL_GREY }),
                new TextRun({ text: "\t", size: 18 }),
                new TextRun({ text: "Page ", size: 18, color: COL_GREY }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18, color: COL_GREY }),
                new TextRun({ text: " / ", size: 18, color: COL_GREY }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: COL_GREY }),
              ],
            }),
          ],
        }),
      },
      children: [
        ...coverChildren, ...tocChildren,
        ...sec1, ...sec2, ...sec3, ...sec4, ...sec5, ...sec6, ...sec7,
        ...sec8, ...sec9, ...sec10, ...sec11, ...sec12, ...sec13, ...sec14,
        ...appendixA, ...appendixB,
      ],
    },
  ],
});

const outDir = process.argv[2] || __dirname;
const outPath = path.join(outDir, "Veslo-Security-Overview.docx");

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outPath, buf);
  console.log("Wrote " + outPath + " (" + buf.length + " bytes)");
});
