
export type ReportLog = Record<string, unknown> & { log_date: string };

/** Inclusive calendar months, with MM/YY interpreted as 2000–2099. */
export function reportMonths(start: string, end: string): string[] {
  const parse = (value: string) => {
    const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(value.trim());
    if (!match) throw new Error("Enter each month as MM/YY (for example, 01/26).");
    return (2000 + Number(match[2])) * 12 + Number(match[1]) - 1;
  };
  const first = parse(start), last = parse(end);
  if (last < first) throw new Error("The end month must be on or after the start month.");
  if (last - first >= 120) throw new Error("Print up to ten years at a time.");
  return Array.from({ length: last - first + 1 }, (_, i) => {
    const month = first + i;
    return `${Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, "0")}`;
  });
}

export function reportReading(log: ReportLog, reading: "ph" | "sanitizer", location: "shallow" | "deep", period: "am" | "pm") {
  // Preserve distinct legacy end readings; current shared samples fill both ends.
  const value = log[`${reading}_${location}_${period}`] ?? (reading === "sanitizer"
    ? log[`sanitizer_band_${period}`] ?? log[`sanitizer_${period}`]
    : log[`${reading}_${period}`]);
  return value == null ? "" : String(value).replace(/^legacy:/, "");
}

/** Overlay the supplied official Letter form, keeping its artwork and geometry intact. */
export async function createPoolReport(template: ArrayBuffer, months: string[], logs: ReportLog[]) {
  const { PDFDocument, StandardFonts, rgb, setCharacterSpacing, setWordSpacing } = await import("pdf-lib");
  // Embedded views share a parent-owned fetch. Its ArrayBuffer belongs to a
  // different window, so normalize it before pdf-lib checks instanceof.
  const source = await PDFDocument.load(new Uint8Array(template));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const clean = (value: unknown) => Array.from(String(value ?? "").replace(/[–−]/g, "-").replace(/—/g, "-").replace(/[\r\n\t]+/g, " ")).map(char => {
    try { font.encodeText(char); return char; } catch { return "?"; }
  }).join("");
  const byDate = new Map(logs.map(log => [log.log_date, log]));
  const yesNo = (value: unknown) => value === true ? "Yes" : value === false ? "No" : "";
  const columns = [39, 63.3, 88.7, 113.2, 137, 169.4, 196.2, 221.3, 246.7, 271.5, 321.3, 358.6, 396.4, 427.3, 456.3, 489.3, 589.6];
  for (const month of months) {
    const [page] = await pdf.copyPages(source, [0]);
    pdf.addPage(page);
    page.pushOperators(setCharacterSpacing(0), setWordSpacing(0));
    const text = (value: unknown, left: number, right: number, top: number, size = 7) => {
      const label = clean(value);
      if (!label) return;
      const width = font.widthOfTextAtSize(label, size);
      const fitted = Math.min(size, size * (right - left - 3) / Math.max(width, 1));
      page.drawText(label, { x: left + (right - left - font.widthOfTextAtSize(label, fitted)) / 2, y: 792 - top - fitted, font, size: fitted, color: rgb(0, 0, 0) });
    };
    const [year, number] = month.split("-").map(Number);
    text("Residence Inn", 22.5, 221.3, 127, 9);
    text("Champaign", 221.3, 321.3, 127, 9);
    text(new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, number - 1, 1))), 321.3, 396.4, 127, 9);
    text(year, 396.4, 427.3, 127, 9);
    text("Pool", 427.3, 589.6, 127, 9);
    text("48", 302, 319, 171, 6);
    const notes: string[] = [];
    const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      const log = byDate.get(`${month}-${String(day).padStart(2, "0")}`);
      if (!log) continue;
      const remarks = [log.remarks, log.closure_reason ? `Closure / actions: ${log.closure_reason}` : log.closure_condition === true ? "CLOSED" : ""].filter(Boolean).join("; ");
      // Long notes remain readable in a continuation instead of shrinking or clipping.
      let note = remarks;
      if (clean(remarks).length > 65) { notes.push(`Day ${day}: ${remarks}`); note = `See remarks ${notes.length} on continuation`; }
      const values = [
        reportReading(log, "ph", "shallow", "am"), reportReading(log, "ph", "shallow", "pm"),
        reportReading(log, "ph", "deep", "am"), reportReading(log, "ph", "deep", "pm"),
        yesNo(log.main_drain_visible),
        reportReading(log, "sanitizer", "shallow", "am"), reportReading(log, "sanitizer", "shallow", "pm"),
        reportReading(log, "sanitizer", "deep", "am"), reportReading(log, "sanitizer", "deep", "pm"),
        log.flow_rate_gpm, yesNo(log.filter_backwashed), log.temperature_f,
        log.combined_chlorine, log.cyanuric_acid, log.completed_by_initials, note,
      ];
      values.forEach((value, index) => text(value, columns[index], columns[index + 1], 189 + (day - 1) * 16.7, index === 15 ? 5 : 6));
    }
    if (notes.length) {
      let continuation = pdf.addPage([612, 792]);
      let y = 750;
      const heading = () => { continuation.drawText(`Residence Inn - Champaign - Pool - ${month} - Remarks`, { x: 30, y, font, size: 11 }); y -= 25; };
      heading();
      for (const [index, note] of notes.entries()) {
        const words = clean(`${index + 1}. ${note}`).split(/\s+/);
        let line = "";
        const draw = () => {
          if (y < 35) { continuation = pdf.addPage([612, 792]); y = 750; heading(); }
          continuation.drawText(line, { x: 30, y, font, size: 9 }); y -= 13; line = "";
        };
        for (const word of words) {
          for (const char of `${word} `) {
            if (font.widthOfTextAtSize(line + char, 9) > 550) draw();
            line += char;
          }
        }
        if (line) draw();
        y -= 8;
      }
    }
  }
  return pdf.save();
}
