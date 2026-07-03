---
name: veslo-pdf
description: "Extract, create, merge, split, annotate, fill forms, and validate PDF documents using standard skill execution."
---

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features, JavaScript libraries, and detailed examples, see REFERENCE.md. If you need to fill out a PDF form, read FORMS.md and follow its instructions.

## Managed Runtime

Run PDF tooling through the managed office runtime:

```bash
veslo-document-runtime exec -- <command>
```

Do not install host dependencies with `pip install`, `brew install`, `choco install`, `winget install`, or OS package managers during a task. If a runtime tool is missing, run `veslo-document-runtime doctor --json` and use Veslo package repair/update instead of changing the user's machine.

## Creating New PDF Documents

When the user asks to **create a new PDF** (report, document, letter, etc.), use this workflow. It produces professionally formatted output with proper typography.

**Requirements:** `pandoc` and `weasyprint` from the managed runtime.

### Step 1: Write content as Markdown

Create a `.md` file with the document content.

### Step 2: Convert to HTML

```bash
BODY=$(veslo-document-runtime exec -- pandoc document.md -t html5)
```

### Step 3: Wrap in styled HTML template

Create a complete HTML file with inline CSS. **Default page size is A4.** If the user requests a different size (A5, Letter, etc.), change the `@page { size: ... }` value.

```bash
cat > /tmp/veslo-pdf-temp.html << HTMLEOF
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<style>
@page {
    size: A4;
    margin: 25mm 25mm 25mm 25mm;
    @bottom-center {
        content: counter(page);
        font-family: "Helvetica Neue", Arial, sans-serif;
        font-size: 9pt;
        color: #999;
    }
}
body {
    font-family: "Helvetica Neue", "Segoe UI", Arial, sans-serif;
    font-size: 12pt;
    line-height: 1.55;
    color: #1a1a1a;
    text-align: justify;
    hyphens: auto;
    -webkit-hyphens: auto;
}
h1 { font-size: 24pt; font-weight: 700; color: #111; margin-top: 0; margin-bottom: 12pt; line-height: 1.2; text-align: left; }
h2 { font-size: 16pt; font-weight: 600; color: #222; margin-top: 16pt; margin-bottom: 8pt; line-height: 1.3; text-align: left; }
h3 { font-size: 13pt; font-weight: 600; color: #333; margin-top: 18pt; margin-bottom: 6pt; line-height: 1.3; text-align: left; }
p { margin-top: 4pt; margin-bottom: 8pt; orphans: 3; widows: 3; }
strong { font-weight: 600; color: #111; }
em { font-style: italic; color: #444; }
blockquote { margin: 10pt 0; padding: 8pt 14pt; border-left: 3pt solid #888; background-color: #f7f7f7; color: #444; font-style: italic; }
blockquote p { margin: 2pt 0; }
hr { display: none; }
a { color: #2563eb; text-decoration: none; word-break: break-all; overflow-wrap: break-word; }
ul, ol { margin-top: 4pt; margin-bottom: 8pt; padding-left: 20pt; }
li { margin-bottom: 3pt; }
code { font-family: "SF Mono", "Fira Code", "Consolas", monospace; font-size: 10pt; background-color: #f3f3f3; padding: 1pt 4pt; border-radius: 2pt; }
pre { background-color: #f5f5f5; padding: 10pt 12pt; border-radius: 4pt; font-size: 9.5pt; line-height: 1.5; overflow-wrap: break-word; white-space: pre-wrap; text-align: left; }
table { width: 100%; border-collapse: collapse; margin: 10pt 0; font-size: 10.5pt; }
th { background-color: #f0f0f0; font-weight: 600; text-align: left; padding: 6pt 8pt; border-bottom: 1.5pt solid #999; }
td { padding: 5pt 8pt; border-bottom: 0.5pt solid #ddd; }
tr:last-child td { border-bottom: none; }
</style>
</head>
<body>
$BODY
</body>
</html>
HTMLEOF
```

### Step 4: Convert HTML to PDF

```bash
veslo-document-runtime exec -- weasyprint /tmp/veslo-pdf-temp.html output.pdf
```

### Notes
- **CRITICAL: heredoc delimiter must NOT be quoted** — use `<< HTMLEOF`, NEVER `<< 'HTMLEOF'`. Single-quoted delimiters prevent `$BODY` variable expansion and produce literal `$BODY` text in the PDF.
- **Always use inline CSS** — do not use external stylesheets or pandoc `--standalone`.
- The managed runtime supplies the library paths required by weasyprint on macOS and Windows.
- **Page size** — default A4. Change `@page { size: A5; }` or `size: Letter;` as needed. Adjust margins proportionally for smaller sizes.
- **Markdown validation** — ensure blank lines before lists (`- ` or `1. `) so pandoc renders them correctly.
- **If pandoc or weasyprint are unavailable**, run `veslo-document-runtime doctor --json` and repair/update the Veslo document runtime package; do not install host dependencies.

---

## Reading and Manipulating Existing PDFs

For working with existing PDF files (extracting text, merging, splitting, forms), use the tools below.

### Quick Start

```python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
```

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract Metadata
```python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}")
print(f"Author: {meta.author}")
print(f"Subject: {meta.subject}")
print(f"Creator: {meta.creator}")
```

#### Rotate Pages
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # Rotate 90 degrees clockwise
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### pdfplumber - Text and Table Extraction

#### Extract Text with Layout
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

#### Extract Tables
```python
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
```

#### Advanced Table Extraction
```python
import pandas as pd

with pdfplumber.open("document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            if table:  # Check if table is not empty
                df = pd.DataFrame(table[1:], columns=table[0])
                all_tables.append(df)

# Combine all tables
if all_tables:
    combined_df = pd.concat(all_tables, ignore_index=True)
    combined_df.to_excel("extracted_tables.xlsx", index=False)
```

### reportlab - Create PDFs

#### Basic PDF Creation
```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter

# Add text
c.drawString(100, height - 100, "Hello World!")
c.drawString(100, height - 120, "This is a PDF created with reportlab")

# Add a line
c.line(100, height - 140, 400, height - 140)

# Save
c.save()
```

#### Create PDF with Multiple Pages
```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

# Add content
title = Paragraph("Report Title", styles['Title'])
story.append(title)
story.append(Spacer(1, 12))

body = Paragraph("This is the body of the report. " * 20, styles['Normal'])
story.append(body)
story.append(PageBreak())

# Page 2
story.append(Paragraph("Page 2", styles['Heading1']))
story.append(Paragraph("Content for page 2", styles['Normal']))

# Build PDF
doc.build(story)
```

## Command-Line Tools

### pdftotext (poppler-utils)
```bash
# Extract text
veslo-document-runtime exec -- pdftotext input.pdf output.txt

# Extract text preserving layout
veslo-document-runtime exec -- pdftotext -layout input.pdf output.txt

# Extract specific pages
veslo-document-runtime exec -- pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf
```bash
# Merge PDFs
veslo-document-runtime exec -- qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
veslo-document-runtime exec -- qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
veslo-document-runtime exec -- qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
veslo-document-runtime exec -- qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
veslo-document-runtime exec -- qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)
```bash
# Merge
veslo-document-runtime exec -- pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
veslo-document-runtime exec -- pdftk input.pdf burst

# Rotate
veslo-document-runtime exec -- pdftk input.pdf rotate 1east output rotated.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs
```python
# Requires OCR extras in the managed runtime; do not pip install into the host environment
import pytesseract
from pdf2image import convert_from_path

# Convert PDF to images
images = convert_from_path('scanned.pdf')

# OCR each page
text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"

print(text)
```

### Add Watermark
```python
from pypdf import PdfReader, PdfWriter

# Create watermark (or load existing)
watermark = PdfReader("watermark.pdf").pages[0]

# Apply to all pages
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Extract Images
```bash
# Using pdfimages (poppler-utils)
veslo-document-runtime exec -- pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

### Password Protection
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

# Add password
writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | `writer.add_page(page)` |
| Split PDFs | pypdf | One page per file |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | `veslo-document-runtime exec -- qpdf --empty --pages ...` |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf (see FORMS.md) | See FORMS.md |

## Next Steps

- For advanced pypdfium2 usage, see REFERENCE.md
- For JavaScript libraries (pdf-lib), see REFERENCE.md
- If you need to fill out a PDF form, follow the instructions in FORMS.md
- For troubleshooting guides, see REFERENCE.md
