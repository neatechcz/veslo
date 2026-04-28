const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
  AlignmentType,
  Document,
  Footer,
  Header,
  ImageRun,
  Packer,
  Paragraph,
  SectionType,
  TabStopPosition,
  TabStopType,
  TextRun,
} = require("docx");

const PAGE_W = 11906; // A4
const PAGE_H = 16838;
const MARGIN = 1134;

const COL_GREY = "595959";
const COL_HEADER_FILL = "1F3A5F";
const COL_ROW_ALT = "F2F4F8";
const COL_ACCENT = "1F3A5F";
const COL_HIGHLIGHT_FILL = "EAF1FB";
const COL_ROADMAP_FILL = "FFF6E5";
const COL_ROADMAP_BORDER = "E0B66B";
const COL_LIGHT_GREY = "D9D9D9";
const COL_BODY = "262626";

const SVG_W = 1120;
const DOC_IMAGE_W = 620;
let nextImageId = 1;

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function svgText(lines, x, y, opts = {}) {
  const size = opts.size ?? 28;
  const lineHeight = opts.lineHeight ?? 34;
  const weight = opts.bold ? "700" : "400";
  const style = opts.italics ? "font-style=\"italic\"" : "";
  const color = opts.color ?? `#${COL_BODY}`;
  return lines
    .map((line, idx) =>
      `<text x="${x}" y="${y + idx * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" ${style} fill="${color}">${esc(line)}</text>`
    )
    .join("");
}

async function svgRun(svg, height, title) {
  const svgBuffer = Buffer.from(svg);
  const pngBuffer = await sharp(svgBuffer).png().toBuffer();
  const id = nextImageId++;
  return new ImageRun({
    type: "png",
    data: pngBuffer,
    transformation: {
      width: DOC_IMAGE_W,
      height: Math.round((height / SVG_W) * DOC_IMAGE_W),
    },
    altText: {
      id: String(id),
      name: `Veslo visual ${id}`,
      title,
      description: title,
    },
  });
}

async function calloutImage(title, body, opts = {}) {
  const fill = opts.fill ?? COL_HIGHLIGHT_FILL;
  const border = opts.border ?? COL_LIGHT_GREY;
  const titleColor = opts.titleColor ?? COL_ACCENT;
  const bodyLines = wrap(body, opts.wrap ?? 72);
  const height = 68 + bodyLines.length * 34 + 22;
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${height}" viewBox="0 0 ${SVG_W} ${height}">
    <rect x="2" y="2" width="${SVG_W - 4}" height="${height - 4}" fill="#${fill}" stroke="#${border}" stroke-width="4"/>
    ${svgText([title], 36, 44, { size: 34, bold: true, color: `#${titleColor}` })}
    ${svgText(bodyLines, 36, 84, { size: 28, color: `#${COL_BODY}`, lineHeight: 34 })}
  </svg>`;
  return svgRun(svg, height, title);
}

async function tableImage(title, rows) {
  const x = 2;
  const y = 2;
  const width = SVG_W - 4;
  const labelW = 430;
  const textX = x + labelW + 30;
  const headerH = 54;
  const rowData = rows.map(([label, text]) => {
    const labelLines = wrap(label, 26);
    const textLines = wrap(text, 54);
    const lineCount = Math.max(labelLines.length, textLines.length);
    return {
      labelLines,
      textLines,
      height: Math.max(58, 24 + lineCount * 31),
    };
  });
  const height = y + headerH + rowData.reduce((sum, row) => sum + row.height, 0) + 2;
  let cursor = y;
  let body = `
    <rect x="${x}" y="${cursor}" width="${width}" height="${headerH}" fill="#${COL_HEADER_FILL}" stroke="#${COL_HEADER_FILL}" stroke-width="4"/>
    ${svgText([title], 30, cursor + 36, { size: 28, bold: true, color: "#FFFFFF" })}
  `;
  cursor += headerH;

  rowData.forEach((row, idx) => {
    const fill = idx % 2 === 1 ? `#${COL_ROW_ALT}` : "#FFFFFF";
    body += `<rect x="${x}" y="${cursor}" width="${width}" height="${row.height}" fill="${fill}" stroke="#${COL_LIGHT_GREY}" stroke-width="3"/>`;
    body += `<line x1="${x + labelW}" y1="${cursor}" x2="${x + labelW}" y2="${cursor + row.height}" stroke="#${COL_LIGHT_GREY}" stroke-width="3"/>`;
    body += svgText(row.labelLines, x + 28, cursor + 36, { size: 25, bold: true, color: `#${COL_BODY}`, lineHeight: 30 });
    body += svgText(row.textLines, textX, cursor + 36, { size: 25, color: `#${COL_BODY}`, lineHeight: 30 });
    cursor += row.height;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${height}" viewBox="0 0 ${SVG_W} ${height}">${body}</svg>`;
  return svgRun(svg, height, title);
}

function run(text, opts = {}) {
  return new TextRun({
    text,
    bold: opts.bold,
    italics: opts.italics,
    color: opts.color ?? COL_BODY,
    size: opts.size ?? 19,
  });
}

function p(runs, opts = {}) {
  return new Paragraph({
    alignment: opts.alignment,
    spacing: {
      before: opts.before ?? 0,
      after: opts.after ?? 58,
      line: opts.line ?? 240,
    },
    indent: opts.indent,
    tabStops: opts.tabStops,
    children: Array.isArray(runs) ? runs : [run(runs, opts)],
  });
}

function imageParagraph(image, after = 95) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after },
    children: [image],
  });
}

function titleBlock() {
  return [
    p([run("Veslo", { bold: true, size: 54, color: COL_ACCENT })], {
      alignment: AlignmentType.CENTER,
      after: 100,
    }),
    p([run("Security & Data Processing Brief", { bold: true, size: 34, color: COL_BODY })], {
      alignment: AlignmentType.CENTER,
      after: 50,
    }),
    p([run("Condensed two-page reference for client IT and information-security review", {
      italics: true,
      size: 20,
      color: COL_GREY,
    })], {
      alignment: AlignmentType.CENTER,
      after: 170,
    }),
  ];
}

function h1(text) {
  return p([run(text, { bold: true, size: 26, color: COL_ACCENT })], {
    before: 105,
    after: 70,
  });
}

function lead(label, text) {
  return p([run(label, { bold: true, size: 20 }), run(text, { size: 20 })], {
    after: 85,
    line: 250,
  });
}

function bullet(label, text) {
  return p([
    run("•", { bold: true, color: COL_ACCENT, size: 20 }),
    run("\t"),
    run(label, { bold: true, size: 19 }),
    run(text, { size: 19 }),
  ], {
    after: 38,
    line: 235,
    indent: { left: 380, hanging: 260 },
    tabStops: [{ type: TabStopType.LEFT, position: 380 }],
  });
}

function header() {
  return new Header({
    children: [
      p([run("Veslo — Security & Data Processing Brief", {
        size: 18,
        color: COL_GREY,
        italics: true,
      })], {
        alignment: AlignmentType.RIGHT,
        after: 80,
      }),
    ],
  });
}

function footer(page) {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          run("Confidential — for client IT review", { size: 18, color: COL_GREY }),
          run("\t", { size: 18 }),
          run(`Page ${page} / 2`, { size: 18, color: COL_GREY }),
        ],
      }),
    ],
  });
}

function section(children, pageNumber, type) {
  return {
    properties: {
      type,
      page: {
        size: { width: PAGE_W, height: PAGE_H },
        margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
      },
    },
    headers: { default: header() },
    footers: { default: footer(pageNumber) },
    children,
  };
}

async function main() {
  const localFirst = await calloutImage(
    "Local-first runtime — ready for on-premise deployment",
    "The agentic runtime executes on the user's own device. Customer files and workspaces stay on-device by default. AI inference is currently delegated to a managed external provider configured for Zero Data Retention."
  );

  const dataTable = await tableImage("Data category / current protection", [
    ["Workspace files, source code, attachments", "User device only by default; not transmitted unless explicitly moved or pasted into a prompt."],
    ["Prompt and completion content", "Veslo AI gateway to configured ZDR provider over TLS 1.3; transient processing only."],
    ["Identity, run metadata and audit records", "Veslo Cloud or customer-hosted control plane; encrypted in transit and at rest."],
    ["End-user secrets", "OS keychain on the user's device; never written to repository or cloud."],
  ]);

  const controlsTable = await tableImage("Control / position", [
    ["Local engine", "Loopback only; no inbound firewall rule required; origin and CSRF checks protect against local cross-origin and DNS-rebinding."],
    ["Transport", "TLS 1.3 on all cloud-bound paths; optional remote execution also uses scoped credentials over TLS 1.3."],
    ["Credential model", "Provider API keys stay in a server-side credential pool and can be rotated centrally without end-user action."],
    ["Desktop integrity", "Signed binaries, Apple notarization on macOS, Authenticode on Windows and signature-verified auto-update."],
    ["Authentication", "Browser-delegated OIDC against the customer's IdP; MFA and step-up controls remain with the IdP."],
    ["Audit", "Per-run exportable records plus structured security events suitable for SIEM ingestion."],
  ]);

  const roadmap = await calloutImage(
    "Roadmap: stricter locality",
    "Native local inference, own inference servers on customer-controlled GPU hardware and self-service customer-hosted control plane deployment are in active development. Combined, these remove external AI dependency and keep prompt traffic inside the customer network end-to-end.",
    { fill: COL_ROADMAP_FILL, border: COL_ROADMAP_BORDER, titleColor: COL_BODY, wrap: 70 }
  );

  const pageOne = [
    ...titleBlock(),
    imageParagraph(localFirst, 120),
    h1("1. Executive summary"),
    lead(
      "In brief. ",
      "Veslo is a local-first, cloud-backed control surface for agentic work. The desktop application runs the workflow on the user's device, while cloud services provide identity, synchronization and centrally governed AI access."
    ),
    bullet("Local-first execution. ", "Workspace files, source code and tool execution stay on-device by default."),
    bullet("On-premise ready. ", "The runtime is local by architecture and can operate inside the client's network."),
    bullet("Zero Data Retention. ", "Prompts and completions are processed transiently by the configured AI provider and are not retained or used for training."),
    bullet("Centralized AI access. ", "End users do not hold provider API keys; administrators bind users to approved providers and models."),
    bullet("Two-layer authorization. ", "Workspaces are explicitly authorized, and sensitive actions require per-run user permission."),
    bullet("End-to-end audit trail. ", "Each run records prompts, plans, tool calls, permission decisions, outputs and artifacts."),
    h1("2. Data handling summary"),
    imageParagraph(dataTable, 0),
  ];

  const pageTwo = [
    h1("3. Security at a glance"),
    imageParagraph(controlsTable, 85),
    h1("4. Compliance posture"),
    bullet("DPA package. ", "Sub-processor list, EU SCCs and a Transfer Impact Assessment template are provided where international transfers apply."),
    bullet("Provider assurance. ", "The configured AI provider operates under ZDR and holds SOC 2 Type 2; report references are included in the DPA package."),
    bullet("Veslo assurance. ", "SOC 2 Type 2 and ISO 27001 for Veslo Cloud and the Veslo AI gateway are on the assurance roadmap; internal controls are available under NDA today."),
    bullet("Data residency. ", "Cloud-synced metadata is stored in the customer's deployment region; on-premise deployments keep residency inside the customer network."),
    imageParagraph(roadmap, 80),
    h1("5. Review answers"),
    bullet("Are workspace files uploaded by default? ", "No. They stay on-device unless explicitly moved, pasted into a prompt or routed to an enabled remote runtime."),
    bullet("Are prompts stored by Veslo? ", "Yes, in the run audit record. Retention is configurable and governed by the DPA; on-premise deployments keep records in the customer environment."),
    bullet("Does the AI provider train on customer prompts? ", "No. ZDR excludes prompt and completion content from training, fine-tuning and evaluation."),
    bullet("Where do vulnerability reports go? ", "To the published security contact and security.txt address with PGP; high-severity reports are acknowledged within one business day."),
  ];

  const doc = new Document({
    creator: "Veslo",
    title: "Veslo — Security & Data Processing Brief",
    description: "Two-page condensed security brief for client IT.",
    styles: {
      default: { document: { run: { font: "Arial", size: 19 } } },
    },
    sections: [
      section(pageOne, 1),
      section(pageTwo, 2, SectionType.NEXT_PAGE),
    ],
  });

  const outDir = process.argv[2] || __dirname;
  const outPath = path.join(outDir, "Veslo-Security-Brief.docx");
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
  console.log("Wrote " + outPath + " (" + buf.length + " bytes)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
