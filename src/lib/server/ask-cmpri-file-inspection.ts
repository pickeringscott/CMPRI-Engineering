import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import type { NextRequest } from "next/server";
import { ASK_FILE_LIMIT, type AskFileDescriptor } from "@/lib/ask-cmpri/files";
import { readAskStagedFile } from "./ask-cmpri-file-staging";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
type Zip = InstanceType<typeof AdmZip>;
function archive(bytes: Uint8Array): Zip {
  const zip = new AdmZip(Buffer.from(bytes));
  const entries = zip.getEntries() as { header: { size: number }; entryName: string }[];
  if (entries.length > 100000 || entries.reduce((sum, entry) => sum + Number(entry.header.size), 0) > ASK_FILE_LIMIT
    || entries.some(entry => !Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || /(?:^|\/)\.\.(?:\/|$)/.test(entry.entryName))) {
    throw Error("The expanded document exceeds the original-file processing limit or has invalid archive paths.");
  }
  return zip;
}
function xml(zip: Zip, name: string): Document {
  const bytes = zip.readFile(name);
  if (!bytes) throw Error(`The original workbook is missing ${name}.`);
  const source = UTF8.decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Error("External entities and document types are not accepted in original-file XML.");
  let invalid = false;
  const document = new DOMParser({ errorHandler: { warning: () => { invalid = true; }, error: () => { invalid = true; }, fatalError: () => { invalid = true; } } }).parseFromString(source, "application/xml");
  if (invalid || !document.documentElement) throw Error("The original workbook XML is invalid.");
  return document;
}
const elements = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS("*", name));
const attr = (node: Element, name: string) => node.getAttribute(name) || "";
const text = (node: Element | undefined) => node?.textContent || "";

/** All sheets/cells retain addresses, printed strings, formulas and cached values; no formula evaluation. */
function spreadsheet(bytes: Uint8Array) {
  const zip = archive(bytes);
  const workbook = xml(zip, "xl/workbook.xml"), relationships = xml(zip, "xl/_rels/workbook.xml.rels");
  const shared = zip.getEntry("xl/sharedStrings.xml") ? elements(xml(zip, "xl/sharedStrings.xml"), "si").map(item => elements(item, "t").map(text).join("")) : [];
  const relation = new Map(elements(relationships, "Relationship").map(item => [attr(item, "Id"), item]));
  const styleDoc = zip.getEntry("xl/styles.xml") ? xml(zip, "xl/styles.xml") : null;
  const formats = new Map(styleDoc ? elements(styleDoc, "numFmt").map(item => [attr(item, "numFmtId"), attr(item, "formatCode")]) : []);
  const cellFormats = styleDoc ? elements(styleDoc, "cellXfs").flatMap(item => elements(item, "xf").map(item => attr(item, "numFmtId"))) : [];
  const warnings: string[] = [];
  const sheets = elements(workbook, "sheet").map(sheet => {
    const id = sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || attr(sheet, "r:id");
    const target = relation.get(id);
    if (!target || attr(target, "TargetMode") === "External") throw Error("The original workbook has a missing or external worksheet.");
    const name = attr(target, "Target");
    const part = path.posix.normalize(name.startsWith("/") ? name.slice(1) : "xl/" + name);
    if (!part.startsWith("xl/")) throw Error("The original workbook has an invalid worksheet path.");
    const data = xml(zip, part);
    const rows = elements(data, "row").map(row => ({ row: Number(attr(row, "r")) || null, cells: elements(row, "c").map(cell => {
      const type = attr(cell, "t") || "n", raw = text(elements(cell, "v")[0]), style = attr(cell, "s"), format = cellFormats[Number(style || 0)];
      const formula = elements(cell, "f")[0];
      let value: string | number | boolean | null = raw;
      if (type === "s") {
        if (!/^\d+$/.test(raw) || shared[Number(raw)] === undefined) throw Error("The original workbook has an invalid shared-string cell.");
        value = shared[Number(raw)];
      } else if (type === "inlineStr") value = elements(cell, "is").flatMap(item => elements(item, "t")).map(text).join("");
      else if (type === "b") value = raw === "1";
      else if (type === "n" && raw && Number.isFinite(Number(raw))) value = Number(raw);
      else if (!raw) value = null;
      return { cell: attr(cell, "r"), type, value, ...(style ? { style: Number(style) } : {}),
        ...(format ? { numberFormatId: Number(format), ...(formats.has(format) ? { numberFormat: formats.get(format) } : {}) } : {}),
        ...(formula ? { formula: text(formula), formulaType: attr(formula, "t") || "normal", formulaRange: attr(formula, "ref") || undefined, sharedFormulaId: attr(formula, "si") || undefined, cachedValue: value } : {}) };
    }) }));
    if (!elements(data, "sheetData").length) warnings.push(`${attr(sheet, "name")}: this sheet has no cell table (for example, a chart sheet).`);
    return { name: attr(sheet, "name"), state: attr(sheet, "state") || "visible", rows };
  });
  const properties = elements(workbook, "workbookPr")[0];
  return { kind: "spreadsheet", complete: true, dateSystem: properties && ["1", "true"].includes(attr(properties, "date1904")) ? "1904" : "1900", sheets, warnings,
    interpretation: "Values are the original workbook's stored cells, including cached formula results. Formulas are preserved, never evaluated. Numeric date/time cells retain their original Excel serial and number-format identifiers. Charts, macros and external links are not executed." };
}

/**
 * Read an already-authorized original without network or authentication calls.
 * The caller owns current source access; complete contents remain in its private
 * snapshot for paged tools. A descriptor never substitutes for the actual bytes.
 */
export async function inspectAskOriginalFile({ descriptor, bytes }: { descriptor: AskFileDescriptor; bytes: Uint8Array }) {
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > ASK_FILE_LIMIT
    || bytes.byteLength !== descriptor.size) throw Error("The original file size does not match its source descriptor or exceeds the processing limit.");
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) throw Error("The original file bytes differ from the source SHA-256.");
  const base = { file: descriptor, sha256: descriptor.sha256 };
  const extension = descriptor.name.split(".").at(-1)?.toLowerCase();
  if (descriptor.type === "application/pdf" || extension === "pdf") {
    const { inspectManualPdf } = await import("@/lib/manual-pdf-knowledge");
    const inspected = await inspectManualPdf(bytes, { includeEmptyPages: true });
    const missing = inspected.pages.filter(page => page.needs_ocr).map(page => page.page);
    return { ...base, kind: "pdf", complete: inspected.pages.length === inspected.total_pages && !missing.length && !inspected.warnings.length,
      text: inspected.text, pages: inspected.pages, totalPages: inspected.total_pages, needsOcr: missing, warnings: inspected.warnings };
  }
  if (extension === "xlsx" || descriptor.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return { ...base, ...spreadsheet(bytes) };
  if (extension === "docx" || descriptor.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    archive(bytes);
    const mammoth = await import("mammoth");
    const content = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { ...base, kind: "document", complete: content.messages.length === 0, text: content.value, warnings: content.messages.map(item => item.message),
      interpretation: "Original document text only; no external relationships, embedded programs or macros were executed. Images and visual layout are not represented by plain text." };
  }
  if (descriptor.type.startsWith("text/") || /^(csv|tsv|txt|md|json|xml|html|htm|log|yaml|yml)$/.test(extension || "") || /(?:json|xml)$/.test(descriptor.type)) {
    const value = UTF8.decode(bytes);
    return { ...base, kind: "text", complete: true, text: value, ...(extension === "json" || descriptor.type === "application/json" ? { data: JSON.parse(value) as unknown } : {}) };
  }
  return { ...base, kind: "binary", complete: false, warnings: ["The original bytes are retained for supported native uploads. This file has no supported text reader; its visual/audio contents have not been inferred."] };
}

/** Selected originals always require fresh actor/property authorization and stored-byte verification. */
export async function inspectAskStagedFile(request: NextRequest, token: string) {
  const original = await readAskStagedFile(request, token);
  return inspectAskOriginalFile(original);
}
