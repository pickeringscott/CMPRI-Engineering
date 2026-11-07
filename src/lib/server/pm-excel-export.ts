import AdmZip from "adm-zip";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { findPmTemplate } from "../pm/catalog";

export type ExportEntry = {
  template_id: string; period_start: string; scope_key: string;
  responses?: Record<string, unknown>; form_data?: Record<string, unknown>;
  notes?: string; deficiency_notes?: string; completed_on?: string | null;
  is_complete?: boolean; completed_by_name?: string | null; status?: string;
  work_order_id?: string | null;
};
const MONTHS = ["JAN", "FEB", "MAR", "APRIL", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"];
const escape = (value: unknown) => {
  const text = String(value ?? "");
  if (text.length > 32767) throw new Error("An entered field exceeds Excel's 32,767 character cell limit.");
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
};
const unescape = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, key: string) => ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"}[key]!));
const attribute = (xml: string, name: string) => unescape(xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || "");
const cells = (xml: string) => [...xml.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map(match => match[0]);
const serial = (date: string) => (Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
const validDate = (date: unknown): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(serial(date)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const column = (ref: string) => ref.replace(/\d/g, "");

/** Edit the original OOXML archive, preserving styles, formulas and untouched parts verbatim. */
export async function exportPmWorkbook(week: string, entries: ExportEntry[]) {
  if (!validDate(week)) throw new Error("Select a valid export week.");
  if (!Array.isArray(entries) || entries.length > 2000 || JSON.stringify(entries).length > 2_000_000) throw new Error("The export is too large.");
  const zip = new AdmZip(await readFile(path.join(process.cwd(), ".bridge/Copy of Preventative Maintenance Tracking - CMPRI.xlsx")));
  const read = (file: string) => zip.readAsText(file);
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t => unescape(t[1])).join(""));
  const value = (cell: string) => {
    const raw = cell.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "";
    return attribute(cell, "t") === "s" ? shared[Number(raw)] : unescape(raw);
  };
  let workbook = read("xl/workbook.xml");
  let relationships = read("xl/_rels/workbook.xml.rels");
  const files = new Map<string, string>();
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/>/g)) {
    const id = attribute(match[0], "r:id");
    const relationship = [...relationships.matchAll(/<Relationship\b[^>]*\/>/g)].find(r => attribute(r[0], "Id") === id)?.[0];
    if (relationship) files.set(attribute(match[0], "name"), path.posix.normalize(`xl/${attribute(relationship, "Target").replace(/^\/xl\//, "")}`));
  }
  const sheets = new Map([...files].map(([name, file]) => [name, read(file)]));
  let updated = 0;
  const write = (sheet: string, ref: string, next: string | number | boolean) => {
    const xml = sheets.get(sheet);
    if (!xml) return;
    const original = cells(xml).find(cell => attribute(cell, "r") === ref);
    if (!original || /<f(?:\s|>)/.test(original)) return; // Formula cells are never overwritten.
    const attrs = original.match(/^<c\b([^>]*?)(?:\/>|>)/)![1].replace(/\s+t="[^"]*"/g, "");
    const replacement = typeof next === "boolean" ? `<c${attrs} t="b"><v>${Number(next)}</v></c>`
      : typeof next === "number" ? `<c${attrs}><v>${next}</v></c>`
      : `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escape(next)}</t></is></c>`;
    sheets.set(sheet, xml.replace(original, replacement)); updated++;
  };
  const detail: unknown[][] = [["CMPRI PM Form Data", "Export week", week], ["Form", "Period", "Location / scope", "Record status", "Field / checklist item", "Entered value"]];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("An export record is invalid.");
    if (entry.completed_on && !validDate(entry.completed_on)) throw new Error("A completion date is invalid.");
    const template = findPmTemplate(entry.template_id);
    if (!template || !validDate(entry.period_start) || typeof entry.scope_key !== "string") throw new Error("An export record is invalid.");
    const sheet = MONTHS[Number(entry.period_start.slice(5, 7)) - 1];
    const xml = sheets.get(sheet) || "";
    const sheetCells = cells(xml);
    const add = (label: string, input: unknown) => detail.push([template.title, entry.period_start, entry.scope_key, entry.status || "Saved", label, typeof input === "object" ? JSON.stringify(input) : input]);
    for (const [key, input] of Object.entries(entry.form_data || {})) {
      if (key === "logEntries" && Array.isArray(input)) {
        input.forEach((row, index) => {
          for (const [field, content] of Object.entries(row || {})) add(`Record ${index + 1}: ${template.repeatableFields?.find(f => f.id === field)?.label || field}`, content);
        });
      } else add(template.fields.find(f => f.id === key)?.label || key, input);
    }
    for (const [key, input] of Object.entries(entry.responses || {})) {
      const item = template.checklist.find(item => item.id === key);
      add(item?.label || key, typeof input === "boolean" ? input ? "Complete" : "Open" : input);
      if (template.kind !== "routine" || typeof input !== "boolean" || !item) continue;
      // Monthly tabs belong to the reference calendar year; other years stay in Form Data.
      const calendarDate = sheetCells.find(c => /^[A-Z]+5$/.test(attribute(c, "r")) && Number(value(c)) > 40000);
      const calendarYear = calendarDate ? new Date(Date.UTC(1899, 11, 30) + Number(value(calendarDate)) * 86400000).getUTCFullYear() : null;
      if (calendarYear !== Number(entry.period_start.slice(0, 4))) continue;
      let ref = "";
      if (template.cadence === "daily") {
        const dateCell = sheetCells.find(c => /5$/.test(attribute(c, "r")) && Number(value(c)) === serial(entry.period_start));
        const row = key.match(/^daily-(\d+)$/)?.[1];
        if (dateCell && row) ref = `${column(attribute(dateCell, "r"))}${row}`;
      } else if (template.cadence === "weekly") {
        const slot = `WK${Math.ceil(Number(entry.period_start.slice(8)) / 7)}`;
        const heading = sheetCells.find(c => value(c) === slot);
        const row = key.match(/^weekly-(\d+)$/)?.[1];
        if (heading && row) ref = `${column(attribute(heading, "r"))}${row}`;
      } else {
        const row = item.source?.match(/![A-Z]+(\d+)/)?.[1];
        if (row) ref = `A${row}`;
      }
      if (ref) write(sheet, ref, input);
    }
    if (template.kind === "room" && entry.completed_on) {
      const year = entry.period_start.slice(0, 4);
      const room = entry.scope_key.match(/^room:(\d+)$/)?.[1];
      const roomCell = cells(sheets.get(year) || "").find(c => /^A\d+$/.test(attribute(c, "r")) && Number(value(c)) === Number(room));
      if (roomCell) write(year, `${String.fromCharCode(66 + Math.floor((Number(entry.period_start.slice(5, 7)) - 1) / 3))}${attribute(roomCell, "r").slice(1)}`, serial(entry.completed_on));
    }
    for (const [label, input] of [["Inspection notes", entry.notes], ["Deficiencies / follow-up", entry.deficiency_notes], ["Completion date", entry.completed_on], ["Completed", entry.is_complete], ["Completed by", entry.completed_by_name], ["Work order", entry.work_order_id]]) if (input !== undefined && input !== null) add(String(label), input);
  }
  for (const [name, xml] of sheets) if (xml !== read(files.get(name)!)) zip.updateFile(files.get(name)!, Buffer.from(xml));
  // Separate detail tab avoids inserting rows/columns into the reference's fixed layouts.
  const id = Math.max(...[...workbook.matchAll(/sheetId="(\d+)"/g)].map(m => Number(m[1]))) + 1;
  const rid = `rIdCmpriFormData${id}`;
  workbook = workbook.replace("</sheets>", `<sheet name="Form Data" sheetId="${id}" r:id="${rid}"/></sheets>`);
  workbook = workbook.replace(/<calcPr\b[^>]*\/>/, '<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>');
  relationships = relationships.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/cmpri-form-data.xml"/></Relationships>`);
  zip.updateFile("xl/workbook.xml", Buffer.from(workbook));
  zip.updateFile("xl/_rels/workbook.xml.rels", Buffer.from(relationships));
  zip.updateFile("[Content_Types].xml", Buffer.from(read("[Content_Types].xml").replace("</Types>", '<Override PartName="/xl/worksheets/cmpri-form-data.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')));
  const rows = detail.map((row, i) => `<row r="${i + 1}">${row.map((input, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(input)}</t></is></c>`).join("")}</row>`).join("");
  zip.addFile("xl/worksheets/cmpri-form-data.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="45" customWidth="1"/><col min="2" max="4" width="22" customWidth="1"/><col min="5" max="6" width="65" customWidth="1"/></cols><sheetData>${rows}</sheetData><autoFilter ref="A2:F${Math.max(2, detail.length)}"/></worksheet>`));
  return { buffer: zip.toBuffer(), updatedCells: updated, records: entries.length };
}
