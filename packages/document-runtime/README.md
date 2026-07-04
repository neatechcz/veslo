# Veslo Document Runtime Package

This package owns the manifest and updater-feed contract for the managed
document runtime used by Veslo's DOCX, XLSX, PDF, and PPTX platform skills.

The runtime is distributed as signed Veslo packages. Normal customer desktop
installers carry a bootstrap package for offline first use, and the Veslo
updater can later install newer packages after signature/hash verification and a
successful `veslo-document-runtime doctor --json` run.

Headless local staging contract:

```bash
veslo-document-runtime pack --headless --source <expanded-runtime-dir> --output <file.veslopkg>
veslo-document-runtime install --headless --package <file.veslopkg> --sha256 <digest> --activate
veslo-document-runtime stage --headless --source <expanded-runtime-dir> --activate
veslo-document-runtime doctor --json
```

The `.veslopkg` artifact is a Veslo-owned gzip NDJSON archive that can be
packed and installed with Node APIs only. `install --headless` verifies the
artifact sha256 before extraction, unpacks into a temporary Veslo-owned
directory, stages the expanded runtime under `packages/<version>`, runs `doctor`
against the staged copy, and only then rewrites `active.json` when `--activate`
is present.

`stage --headless` remains the installer/updater primitive for already expanded
bootstrap resources. Both paths require an expanded runtime containing
`manifest.json`, `bin/`, `fonts/`, Python packages, and Node modules. Neither
path installs host packages or mutates the global PATH.

`doctor --json` must prove managed execution for the document-skill command
surface before the runtime can be marked ready: `soffice`, `pandoc`,
`pdftoppm`, `pdftotext`, `pdfimages`, `qpdf`, `weasyprint`, managed Python
imports, managed Node modules, and fonts.

Validation entrypoints:

```bash
pnpm --filter veslo-document-runtime test
node scripts/document-runtime/validate-manifest.mjs
node scripts/document-runtime/validate-package-feed.mjs
node scripts/document-runtime/check-licenses.mjs
```
