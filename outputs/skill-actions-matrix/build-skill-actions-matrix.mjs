import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = process.cwd();
const outputPath = path.join(outputDir, "skill-actions-contingency-matrix.xlsx");

const roles = ["Bezny uzivatel", "Organization owner", "Administrator"];

const assumptions = [
  ["Pojem", "Definice pro tuto matici"],
  ["User skill", "Skill patri uzivateli. Muze byt nainstalovany nebo nenainstalovany/deaktivovany."],
  ["Workspace skill", "Skill patri konkretnimu workspace. Mutace se v UI delaji jen pro aktualni workspace."],
  ["Organizacni skill", "Skill z organizacniho katalogu. Muze byt nainstalovany u uzivatele nebo ve workspace, nebo jen dostupny v katalogu."],
  ["Verejny skill", "Skill z verejneho katalogu. Muze byt nainstalovany u uzivatele nebo ve workspace, nebo jen dostupny v katalogu."],
  ["Nainstalovany", "Skill je aktivni v runtime a agent ho muze pouzit."],
  ["Nenainstalovany / deaktivovany", "Skill zustava v inventari nebo katalogu, ale neni aktivni v runtime. Akce zpet je Nainstalovat."],
  ["Nainstalovat", "Jediny spravny label pro aktivaci nebo pridani skillu. Nahrazuje puvodni label Adoptovat."],
  ["Deaktivovat", "Reverzibilni odinstalace. Skill se nema smazat z inventare/katalogu."],
  ["Navrhnout jako organizacni", "Bezny uzivatel muze poslat user/workspace skill ke schvaleni do organizace."],
  ["Vytvorit organizacni", "Organization owner muze z user/workspace skillu vytvorit organizacni skill nap primo."],
  ["Publikovat jako verejny", "Pouze organization owner muze publikovat skill do verejneho katalogu."],
  ["Administrator", "Pracovni predpoklad: administrator spravuje organizacni instalace a schvaluje/odmita navrhy, ale nemuze publikovat verejne ani nap primo vytvaret organizacni skill, pokud zaroven neni organization owner."],
  ["Sdilet", "Akce Sdilet se rusi napric systemem."],
  ["Adoptovat", "Akce Adoptovat se rusi napric systemem a nahrazuje se akci Nainstalovat."],
];

const matrixRows = [
  {
    type: "User skill",
    context: "User scope",
    installState: "Nainstalovany",
    workflowState: "Lokalni / osobni",
    regular: ["Detail", "Upravit", "Deaktivovat", "Navrhnout jako organizacni"],
    owner: ["Detail", "Upravit", "Deaktivovat", "Vytvorit organizacni", "Publikovat jako verejny"],
    admin: ["Detail", "Upravit", "Deaktivovat", "Navrhnout jako organizacni"],
    note: "User skill je osobni, ne verejny. Deaktivace ho ponecha v inventari.",
  },
  {
    type: "User skill",
    context: "User scope",
    installState: "Nenainstalovany / deaktivovany",
    workflowState: "Lokalni / osobni",
    regular: ["Detail", "Upravit", "Nainstalovat", "Navrhnout jako organizacni"],
    owner: ["Detail", "Upravit", "Nainstalovat", "Vytvorit organizacni", "Publikovat jako verejny"],
    admin: ["Detail", "Upravit", "Nainstalovat", "Navrhnout jako organizacni"],
    note: "Nenainstalovany user skill je stale pritomny a muze se znovu aktivovat.",
  },
  {
    type: "User skill",
    context: "User scope",
    installState: "Libovolny",
    workflowState: "Navrh na organizacni ceka",
    regular: ["Detail", "Sledovat stav navrhu", "Zrusit vlastni navrh"],
    owner: ["Detail", "Schvalit jako organizacni", "Odmitnout navrh", "Publikovat jako verejny"],
    admin: ["Detail", "Schvalit jako organizacni", "Odmitnout navrh"],
    note: "Publikace verejne zustava jen pro organization owner.",
  },
  {
    type: "Workspace skill",
    context: "Aktualni workspace",
    installState: "Nainstalovany",
    workflowState: "Lokalni workspace",
    regular: ["Detail", "Upravit", "Deaktivovat", "Kopirovat do user skills", "Presunout do user skills", "Navrhnout jako organizacni"],
    owner: ["Detail", "Upravit", "Deaktivovat", "Kopirovat do user skills", "Presunout do user skills", "Vytvorit organizacni", "Publikovat jako verejny"],
    admin: ["Detail", "Upravit", "Deaktivovat", "Kopirovat do user skills", "Presunout do user skills", "Navrhnout jako organizacni"],
    note: "Mutace jsou dostupne jen pro aktualni workspace a zapisovatelny skill.",
  },
  {
    type: "Workspace skill",
    context: "Aktualni workspace",
    installState: "Nenainstalovany / deaktivovany",
    workflowState: "Lokalni workspace",
    regular: ["Detail", "Upravit", "Nainstalovat", "Kopirovat do user skills", "Presunout do user skills", "Navrhnout jako organizacni"],
    owner: ["Detail", "Upravit", "Nainstalovat", "Kopirovat do user skills", "Presunout do user skills", "Vytvorit organizacni", "Publikovat jako verejny"],
    admin: ["Detail", "Upravit", "Nainstalovat", "Kopirovat do user skills", "Presunout do user skills", "Navrhnout jako organizacni"],
    note: "Deaktivovany workspace skill zustava v inventari aktualniho workspace.",
  },
  {
    type: "Workspace skill",
    context: "Aktualni workspace",
    installState: "Libovolny",
    workflowState: "Navrh na organizacni ceka",
    regular: ["Detail", "Sledovat stav navrhu", "Zrusit vlastni navrh"],
    owner: ["Detail", "Schvalit jako organizacni", "Odmitnout navrh", "Publikovat jako verejny"],
    admin: ["Detail", "Schvalit jako organizacni", "Odmitnout navrh"],
    note: "Navrh je workflow stav nad existujicim user/workspace skillem.",
  },
  {
    type: "Workspace skill",
    context: "Jiny workspace",
    installState: "Nainstalovany",
    workflowState: "Lokalni workspace",
    regular: ["Detail", "Otevrit umisteni, pokud je dostupne"],
    owner: ["Detail", "Otevrit umisteni, pokud je dostupne", "Prepnout workspace pro mutace"],
    admin: ["Detail", "Otevrit umisteni, pokud je dostupne", "Prepnout workspace pro mutace"],
    note: "Zadne primarne mutacni akce bez prepnuti workspace.",
  },
  {
    type: "Workspace skill",
    context: "Jiny workspace",
    installState: "Nenainstalovany / deaktivovany",
    workflowState: "Lokalni workspace",
    regular: ["Detail", "Otevrit umisteni, pokud je dostupne"],
    owner: ["Detail", "Otevrit umisteni, pokud je dostupne", "Prepnout workspace pro mutace"],
    admin: ["Detail", "Otevrit umisteni, pokud je dostupne", "Prepnout workspace pro mutace"],
    note: "Nainstalovat, upravit ani deaktivovat nema byt dostupne z ciziho workspace.",
  },
  {
    type: "Organizacni skill",
    context: "Organizacni katalog",
    installState: "Nenainstalovany",
    workflowState: "Katalog",
    regular: ["Detail", "Nainstalovat"],
    owner: ["Detail", "Nainstalovat", "Upravit organizacni zaznam", "Publikovat jako verejny"],
    admin: ["Detail", "Nainstalovat", "Spravovat organizacni instalace", "Upravit organizacni zaznam"],
    note: "Organizacni skill uz neni user/workspace skill; nejde ho adoptovat.",
  },
  {
    type: "Organizacni skill",
    context: "Nainstalovany u uzivatele nebo workspace",
    installState: "Nainstalovany",
    workflowState: "Katalog + runtime instalace",
    regular: ["Detail", "Deaktivovat"],
    owner: ["Detail", "Deaktivovat", "Aktualizovat", "Upravit organizacni zaznam", "Publikovat jako verejny"],
    admin: ["Detail", "Deaktivovat", "Aktualizovat", "Spravovat organizacni instalace", "Upravit organizacni zaznam"],
    note: "Deaktivace odstrani aktivaci z runtime, ne katalogovy zaznam.",
  },
  {
    type: "Organizacni skill",
    context: "Nainstalovany u uzivatele nebo workspace",
    installState: "Aktualizace dostupna",
    workflowState: "Katalog + runtime instalace",
    regular: ["Detail", "Aktualizovat", "Deaktivovat"],
    owner: ["Detail", "Aktualizovat", "Deaktivovat", "Upravit organizacni zaznam", "Publikovat jako verejny"],
    admin: ["Detail", "Aktualizovat", "Deaktivovat", "Spravovat organizacni instalace", "Upravit organizacni zaznam"],
    note: "Aktualizace je overlay nad nainstalovanym stavem.",
  },
  {
    type: "Verejny skill",
    context: "Verejny katalog",
    installState: "Nenainstalovany",
    workflowState: "Katalog",
    regular: ["Detail", "Nainstalovat"],
    owner: ["Detail", "Nainstalovat"],
    admin: ["Detail", "Nainstalovat"],
    note: "Verejny skill se instaluje, ne adoptuje.",
  },
  {
    type: "Verejny skill",
    context: "Nainstalovany u uzivatele nebo workspace",
    installState: "Nainstalovany",
    workflowState: "Katalog + runtime instalace",
    regular: ["Detail", "Deaktivovat"],
    owner: ["Detail", "Deaktivovat"],
    admin: ["Detail", "Deaktivovat"],
    note: "Verejny skill uz je verejny; neni co publikovat.",
  },
  {
    type: "Verejny skill",
    context: "Nainstalovany u uzivatele nebo workspace",
    installState: "Aktualizace dostupna",
    workflowState: "Katalog + runtime instalace",
    regular: ["Detail", "Aktualizovat", "Deaktivovat"],
    owner: ["Detail", "Aktualizovat", "Deaktivovat"],
    admin: ["Detail", "Aktualizovat", "Deaktivovat"],
    note: "Aktualizace je overlay nad nainstalovanym stavem.",
  },
];

const removedActions = [
  ["Akce", "Rozhodnuti", "Duvod"],
  ["Sdilet", "Zrusit vsude", "V systemu nedava smysl sdilet skill pres public link flow."],
  ["Adoptovat", "Zrusit vsude", "Nahradit jednotnym labelem Nainstalovat."],
  ["Odinstalovat jako smazani", "Nepouzivat pro beznou akci", "Bezny tok ma byt Deaktivovat, protoze skill zustava pritomny a lze ho znovu nainstalovat."],
  ["Lokani editace organizacniho/verejneho katalogoveho skillu", "Nezobrazovat", "Katalogove skilly se spravuji katalogovymi akcemi, ne filesystem editaci runtime kopie."],
];

function bullet(actions) {
  return actions.map((action) => `- ${action}`).join("\n");
}

function rowsToRange(sheet, startCell, rows) {
  const endCol = String.fromCharCode("A".charCodeAt(0) + rows[0].length - 1);
  const endRow = Number(startCell.match(/\d+/)?.[0] ?? "1") + rows.length - 1;
  sheet.getRange(`${startCell}:${endCol}${endRow}`).values = rows;
}

function styleHeader(range) {
  range.format = {
    fill: "#1F2937",
    font: { color: "#FFFFFF", bold: true },
    borders: { preset: "outside", style: "thin", color: "#D1D5DB" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
  };
}

function styleBody(range) {
  range.format = {
    font: { color: "#111827" },
    borders: { preset: "outside", style: "thin", color: "#E5E7EB" },
    verticalAlignment: "top",
    wrapText: true,
  };
}

function styleTitle(range) {
  range.format = {
    fill: "#F3F4F6",
    font: { color: "#111827", bold: true, size: 16 },
    borders: { preset: "outside", style: "thin", color: "#D1D5DB" },
    verticalAlignment: "center",
  };
}

function addLegend(sheet, startRow) {
  const rows = [
    ["Klicove rozhodnuti", "Co z toho plyne pro UI"],
    ["Detail je univerzalni", "Detail musi jit otevrit u kazdeho typu a stavu skillu."],
    ["Nainstalovat nahrazuje Adoptovat", "Adoptovat se nema zobrazovat v zadnem stavu."],
    ["Deaktivovat je reverzibilni", "Skill zustava v inventari a lze ho znovu nainstalovat."],
    ["Sdilet se rusi", "Share/public-link flow odstranit z UI akci skillu."],
    ["Publikovat verejne muze jen owner", "Organization owner je jedina role s akci Publikovat jako verejny."],
  ];
  rowsToRange(sheet, `A${startRow}`, rows);
  styleHeader(sheet.getRange(`A${startRow}:B${startRow}`));
  styleBody(sheet.getRange(`A${startRow + 1}:B${startRow + rows.length - 1}`));
}

const workbook = Workbook.create();
const matrix = workbook.worksheets.getOrAdd("Kontingencni matice", { renameFirstIfOnlyNewSpreadsheet: true });

matrix.getRange("A1:G1").values = [["Kontingencni tabulka akci pro skilly"]];
styleTitle(matrix.getRange("A1:G1"));
matrix.getRange("A2:G2").values = [["Pracovni navrh pro schvaleni terminologie a UI akci. Bunky roli obsahuji jen relevantni akce; akce Sdilet a Adoptovat jsou zamerne vynechane."]];
matrix.getRange("A2:G2").format = { fill: "#FFFBEB", font: { color: "#92400E" }, wrapText: true };

const matrixHeaders = [["Typ skillu", "Kontext", "Stav instalace", "Workflow stav", ...roles, "Poznamka"]];
const matrixBody = matrixRows.map((row) => [
  row.type,
  row.context,
  row.installState,
  row.workflowState,
  bullet(row.regular),
  bullet(row.owner),
  bullet(row.admin),
  row.note,
]);
rowsToRange(matrix, "A4", [...matrixHeaders, ...matrixBody]);
styleHeader(matrix.getRange("A4:H4"));
styleBody(matrix.getRange(`A5:H${4 + matrixBody.length}`));
matrix.getRange("A4:H4").format.autofitColumns();
matrix.getRange(`A1:H${4 + matrixBody.length}`).format.autofitRows();
matrix.freezePanes.freezeRows(4);
addLegend(matrix, 22);

const data = workbook.worksheets.add("Data pro kontingenci");
const dataHeaders = [["Typ skillu", "Kontext", "Stav instalace", "Workflow stav", "Role", "Akce", "Viditelnost", "Poznamka"]];
const dataRows = [];
for (const row of matrixRows) {
  for (const [role, actionList] of [
    ["Bezny uzivatel", row.regular],
    ["Organization owner", row.owner],
    ["Administrator", row.admin],
  ]) {
    for (const action of actionList) {
      dataRows.push([row.type, row.context, row.installState, row.workflowState, role, action, "Zobrazit", row.note]);
    }
  }
}
rowsToRange(data, "A1", [...dataHeaders, ...dataRows]);
styleHeader(data.getRange("A1:H1"));
styleBody(data.getRange(`A2:H${1 + dataRows.length}`));
data.getRange(`A1:H${1 + dataRows.length}`).format.autofitColumns();
data.freezePanes.freezeRows(1);

const dictionary = workbook.worksheets.add("Slovnik a pravidla");
rowsToRange(dictionary, "A1", assumptions);
styleHeader(dictionary.getRange("A1:B1"));
styleBody(dictionary.getRange(`A2:B${assumptions.length}`));
dictionary.getRange(`A1:B${assumptions.length}`).format.autofitColumns();
dictionary.freezePanes.freezeRows(1);

const removed = workbook.worksheets.add("Zrusene akce");
rowsToRange(removed, "A1", removedActions);
styleHeader(removed.getRange("A1:C1"));
styleBody(removed.getRange(`A2:C${removedActions.length}`));
removed.getRange(`A1:C${removedActions.length}`).format.autofitColumns();
removed.freezePanes.freezeRows(1);

const checks = workbook.worksheets.add("Kontroly");
const actionNames = dataRows.map((row) => row[5].toLowerCase());
const containsShare = actionNames.some((name) => name.includes("sdilet"));
const containsAdopt = actionNames.some((name) => name.includes("adopt"));
const ownerPublicRows = dataRows.filter((row) => row[5] === "Publikovat jako verejny");
const nonOwnerPublicRows = ownerPublicRows.filter((row) => row[4] !== "Organization owner");
const rowsMissingDetail = matrixRows.filter((row) => !row.regular.includes("Detail") || !row.owner.includes("Detail") || !row.admin.includes("Detail"));
const checkRows = [
  ["Kontrola", "Vysledek", "Detail"],
  ["Detail je u vsech roli ve vsech stavech", rowsMissingDetail.length === 0 ? "OK" : "CHYBA", rowsMissingDetail.map((row) => `${row.type} / ${row.context} / ${row.installState}`).join("; ")],
  ["Akce Sdilet neni v matici", containsShare ? "CHYBA" : "OK", containsShare ? "Nalezena zakazana akce" : ""],
  ["Akce Adoptovat neni v matici", containsAdopt ? "CHYBA" : "OK", containsAdopt ? "Nalezena zakazana akce" : ""],
  ["Publikovat jako verejny ma jen organization owner", nonOwnerPublicRows.length === 0 ? "OK" : "CHYBA", nonOwnerPublicRows.map((row) => `${row[0]} / ${row[4]}`).join("; ")],
  ["Pocet radku matice", matrixRows.length, ""],
  ["Pocet datovych radku akci", dataRows.length, ""],
];
rowsToRange(checks, "A1", checkRows);
styleHeader(checks.getRange("A1:C1"));
styleBody(checks.getRange(`A2:C${checkRows.length}`));
checks.getRange(`A1:C${checkRows.length}`).format.autofitColumns();
checks.freezePanes.freezeRows(1);

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
console.log(formulaErrors.ndjson);

const matrixInspect = await workbook.inspect({
  kind: "table",
  range: "Kontingencni matice!A1:H18",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 8,
});
console.log(matrixInspect.ndjson);

await workbook.render({ sheetName: "Kontingencni matice", range: "A1:H30", scale: 2 });
await workbook.render({ sheetName: "Data pro kontingenci", range: "A1:H30", scale: 2 });
await workbook.render({ sheetName: "Slovnik a pravidla", range: "A1:B18", scale: 2 });
await workbook.render({ sheetName: "Zrusene akce", range: "A1:C8", scale: 2 });
await workbook.render({ sheetName: "Kontroly", range: "A1:C8", scale: 2 });

await fs.mkdir(outputDir, { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);
console.log(outputPath);
