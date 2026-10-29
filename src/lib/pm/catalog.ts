import source from "./source-catalog.json";
import roomSourceItems from "./room-source-items.json";

export type PmCadence = "daily" | "weekly" | "monthly" | "quarterly";
export type PmScope = "property" | "room" | "area" | "equipment";
export type PmFieldType = "text" | "textarea" | "date" | "number" | "yes-no" | "select";
export type PmFormField = {
  id: string;
  label: string;
  type: PmFieldType;
  options?: string[];
  required?: boolean;
};
export type PmChecklistItem = { id: string; label: string; category?: string; source?: string };
export type PmTemplate = {
  id: string;
  title: string;
  cadence: PmCadence;
  scope: PmScope;
  kind: "routine" | "inspection" | "room" | "log" | "meeting" | "drill";
  months?: number[];
  sourceFile: string;
  sourcePage?: number;
  sourceReference: string;
  instructions?: string;
  checklist: PmChecklistItem[];
  fields: PmFormField[];
  repeatableFields?: PmFormField[];
  repeatableLabel?: string;
};

type SourceCatalog = {
  workbook: string;
  daily: Array<{ id: string; category: string; label: string; source: string }>;
  weekly: Array<{ id: string; label: string; source: string; reference: string | null }>;
  months: Array<{ month: string; tasks: Array<{ id: string; number: number; section: string; label: string; source: string; references: string[] }> }>;
  roomNumbers: string[];
  pdfs: Array<{ file: string; pages: number; lines: string[] }>;
};

const data = source as SourceCatalog;
const monthNumber: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUG: 8, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};
const quarterMonths = [1, 4, 7, 10];
const coldQuarterMonths = [3, 6, 9, 12];
const alternateQuarterMonths = [2, 5, 8, 11];
const calendarMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const commonFields: PmFormField[] = [
  { id: "inspectedBy", label: "Inspected by", type: "text" },
  { id: "inspectionDate", label: "Inspection date", type: "date" },
];

const pdfMetadata: Record<string, {
  title: string;
  cadence: PmCadence;
  months?: number[];
  scope: PmScope;
  kind?: PmTemplate["kind"];
  instructions?: string;
  fields?: PmFormField[];
  repeatableFields?: PmFormField[];
  repeatableLabel?: string;
}> = {
  "Air Handlers Quarterly.pdf": { title: "Air Handlers Quarterly Checklist", cadence: "quarterly", months: coldQuarterMonths, scope: "equipment", fields: [{ id: "unitIdentifier", label: "Unit number / serial / identifier", type: "text", required: true }] },
  "Business Center.pdf": { title: "Business Center Quarterly Checklist", cadence: "quarterly", months: quarterMonths, scope: "area" },
  "Dining_Breakfast.pdf": { title: "Dining / Breakfast Area Quarterly Checklist", cadence: "quarterly", months: quarterMonths, scope: "area" },
  "Elevator Checklist.pdf": { title: "Elevator Quarterly Checklist", cadence: "quarterly", months: alternateQuarterMonths, scope: "equipment", fields: [{ id: "location", label: "Elevator number / location", type: "text", required: true }] },
  "Emergency lighting-Exit Sign log Master.pdf": { title: "Emergency Lighting & Exit Sign Monthly Log", cadence: "monthly", scope: "area", kind: "log", instructions: "Test each battery-powered emergency light and EXIT sign by depressing its test button. Record the nearest room or area, device type, actual functional result, date, notes, repair date and initials.", repeatableLabel: "Device inspections", repeatableFields: [
    { id: "location", label: "Location", type: "text", required: true },
    { id: "deviceType", label: "Type of device", type: "select", options: ["Exit sign", "Emergency light"] },
    { id: "functional", label: "Functional", type: "yes-no", required: true },
    { id: "date", label: "Date tested", type: "date" },
    { id: "notes", label: "Notes", type: "textarea" },
    { id: "dateRepaired", label: "Date repaired", type: "date" },
    { id: "initials", label: "Initials", type: "text" },
  ] },
  "Exterior_Site Maintenance.pdf": { title: "Building Exterior Quarterly Checklist", cadence: "quarterly", months: coldQuarterMonths, scope: "area" },
  "Fitness Center.pdf": { title: "Fitness Center Quarterly Checklist", cadence: "quarterly", months: alternateQuarterMonths, scope: "area" },
  "Front Office_Desk.pdf": { title: "Front Office / Desk Quarterly Checklist", cadence: "quarterly", months: quarterMonths, scope: "area" },
  "Hallway Checklist.pdf": { title: "Hallways Quarterly Checklist", cadence: "quarterly", months: alternateQuarterMonths, scope: "area" },
  "Ice Machine Areas.pdf": { title: "Ice Machine Area Quarterly Checklist", cadence: "quarterly", months: coldQuarterMonths, scope: "equipment", fields: [{ id: "location", label: "Ice machine location / number", type: "text", required: true }] },
  "Kitchen.pdf": { title: "Kitchen Quarterly Checklist", cadence: "quarterly", months: coldQuarterMonths, scope: "area" },
  "Laundry-Commercial.pdf": { title: "Commercial Laundry Quarterly Checklist", cadence: "quarterly", months: alternateQuarterMonths, scope: "equipment" },
  "Laundry-Guest.pdf": { title: "Guest Laundry Quarterly Checklist", cadence: "quarterly", months: alternateQuarterMonths, scope: "area" },
  "Lobby.pdf": { title: "Lobby Quarterly Checklist", cadence: "quarterly", months: quarterMonths, scope: "area" },
  "Market_Pantry.pdf": { title: "Market / Pantry Quarterly Checklist", cadence: "quarterly", months: quarterMonths, scope: "area" },
  "Meeting Room.pdf": { title: "Meeting Rooms Quarterly Checklist", cadence: "quarterly", months: alternateQuarterMonths, scope: "area", fields: [{ id: "location", label: "Meeting room name / location", type: "text", required: true }] },
  "Monthly fire Door log.pdf": { title: "Fire & Smoke Doors Monthly Log", cadence: "monthly", scope: "area", kind: "log", instructions: "Test fire and smoke doors, including storage, exit stairwell and mechanical room doors, for self-closing and self-latching. Record actual results and defects separately.", repeatableLabel: "Door inspections", repeatableFields: [
    { id: "location", label: "Location", type: "text", required: true },
    { id: "functional", label: "Self-closing and latching", type: "yes-no", required: true },
    { id: "date", label: "Date inspected", type: "date" },
    { id: "notes", label: "Notes", type: "textarea" },
    { id: "dateRepaired", label: "Date repaired", type: "date" },
    { id: "initials", label: "Initials", type: "text" },
  ] },
  "Monthly Fire Extinguisher Log.pdf": { title: "Portable Fire Extinguisher Monthly Log", cadence: "monthly", scope: "area", kind: "log", instructions: "Check charge, proper location, and cabinet glass / breakbar where applicable. Qualified third-party inspection is required annually.", repeatableLabel: "Extinguisher inspections", repeatableFields: [
    { id: "location", label: "Location", type: "text", required: true },
    { id: "passed", label: "Passed inspection", type: "yes-no", required: true },
    { id: "date", label: "Date inspected", type: "date" },
    { id: "notes", label: "Notes", type: "textarea" },
    { id: "dateRepaired", label: "Date repaired", type: "date" },
    { id: "initials", label: "Initials", type: "text" },
  ] },
  "Monthly Laundry Chute Log.pdf": { title: "Laundry Chute / Trash Doors Monthly Log", cadence: "monthly", scope: "area", kind: "log", instructions: "Doors must self-close and self-latch. If a fusible link or closing device fails, keep the door closed except while removing laundry.", repeatableLabel: "Chute / trash door inspections", repeatableFields: [
    { id: "location", label: "Location", type: "text", required: true },
    { id: "functional", label: "Self-closing and latching", type: "yes-no", required: true },
    { id: "date", label: "Date inspected", type: "date" },
    { id: "notes", label: "Notes", type: "textarea" },
    { id: "dateRepaired", label: "Date repaired", type: "date" },
    { id: "initials", label: "Initials", type: "text" },
  ] },
  "Monthly Sprinkler Valve Insp.pdf": { title: "Sprinkler Valve Monthly Inspection", cadence: "monthly", scope: "equipment", kind: "log", instructions: "Physically verify all listed valves are secured and open, with clear access and no damage or leaks.", fields: [
    { id: "valvesOperated", label: "Any valves operated since last inspection?", type: "yes-no", required: true },
    { id: "redTagsUsed", label: "Were red tags used?", type: "yes-no", required: true },
    { id: "reopenedAndDrainTested", label: "Reopened fully and drain-tested before relocking / resealing?", type: "yes-no", required: true },
  ], repeatableLabel: "Valve inspections", repeatableFields: [
    { id: "location", label: "Valve location", type: "text", required: true },
    { id: "areaControlled", label: "Area controlled", type: "text", required: true },
    { id: "clearAccess", label: "Clear access", type: "yes-no", required: true },
    { id: "position", label: "Valve open / shut", type: "select", options: ["Open", "Shut"], required: true },
    { id: "locked", label: "Locked / secured", type: "yes-no", required: true },
    { id: "redTag", label: "Red tag used", type: "yes-no" },
    { id: "date", label: "Date", type: "date" },
    { id: "initials", label: "Initials", type: "text" },
  ] },
  "Pool.pdf": { title: "Pool Quarterly Checklist", cadence: "quarterly", months: coldQuarterMonths, scope: "equipment", fields: [
    { id: "drainCoverExpiration", label: "Drain cover expiration date", type: "date" },
    { id: "licenseInformation", label: "License / compliance information", type: "textarea" },
  ] },
  "Property Walk Guide.pdf": { title: "Weekly Property Walk", cadence: "weekly", scope: "area", instructions: "Weekly Engineering / Housekeeping walk; walk with the General Manager monthly. Record deficiencies and create a work-order schedule." },
  "Public Restrooms.pdf": { title: "Public Restrooms Quarterly Checklist", cadence: "quarterly", months: quarterMonths, scope: "area" },
  "Quarterly Fire Drill.pdf": { title: "Quarterly Fire Drill Record", cadence: "quarterly", months: quarterMonths, scope: "property", kind: "drill", fields: [
    { id: "drillType", label: "Drill type", type: "select", options: ["Exercise only", "Alarm activation"], required: true },
    { id: "alarmTime", label: "Time of alarm", type: "text" },
    { id: "guestNotification", label: "Guests notified in advance", type: "yes-no" },
    { id: "departmentsNotified", label: "Departments notified", type: "text" },
    { id: "thirdPartyAlarmReport", label: "Third-party alarm inspection report", type: "textarea" },
    { id: "responseTime", label: "Response time", type: "text" },
    { id: "containment", label: "Containment", type: "textarea" },
    { id: "communication", label: "Communication", type: "textarea" },
    { id: "sequenceOfEvents", label: "Sequence of events", type: "textarea" },
    { id: "actionItems", label: "Action items and assigned to", type: "textarea" },
    { id: "attendees", label: "Attendees", type: "textarea" },
    { id: "allEmployeesAccountedFor", label: "All employees accounted for", type: "yes-no" },
    { id: "evacuationTime", label: "Time to full evacuation", type: "text" },
    { id: "supervisingManagerSignature", label: "Supervising manager signature", type: "text", required: true },
  ] },
  "Room PM Checklist.pdf": { title: "Guest Room Quarterly PM", cadence: "quarterly", months: quarterMonths, scope: "room", kind: "room", fields: [
    { id: "rank", label: "Room rank", type: "select", options: ["Green", "Clear", "Red"] },
  ], instructions: "Slash items needing revisit and create work orders. Mark items complete after repair. Do not start any task expected to take longer than 30 minutes." },
  "RTU Quarterly.pdf": { title: "RTU Quarterly Checklist", cadence: "quarterly", months: coldQuarterMonths, scope: "equipment", fields: [{ id: "unitIdentifier", label: "Unit number / serial / identifier", type: "text", required: true }], instructions: "Turn off all power before maintenance. Replace and date filters as required. Do not leave coil cleaner on for more than five minutes." },
  "Safety Checklist.pdf": { title: "Quarterly Safety Checklist", cadence: "quarterly", months: quarterMonths, scope: "property", fields: [{ id: "completedBy", label: "Checklist completed by", type: "text", required: true }] },
  "Split Unit Quarterly.pdf": { title: "Split Unit AC Quarterly Checklist", cadence: "quarterly", months: coldQuarterMonths, scope: "equipment", fields: [{ id: "unitIdentifier", label: "Unit number / serial / identifier", type: "text", required: true }], instructions: "Turn off all power before maintenance. Do not use acid coil cleaner or leave coil cleaner on for more than five minutes." },
  "Sprinkler Flow_Tamper Test.pdf": { title: "Quarterly Sprinkler Flow & Tamper Switch Test", cadence: "quarterly", months: quarterMonths, scope: "equipment", kind: "log", instructions: "Keep this record for authorities and insurance. Remove locks / chains / seals, physically turn each valve, then return it to the open position and relock / reseal.", repeatableLabel: "Sprinkler system tests", repeatableFields: [
    { id: "location", label: "Location", type: "text", required: true },
    { id: "controlValveType", label: "Type of control valve", type: "text" },
    { id: "flow", label: "Flow switch", type: "yes-no" },
    { id: "pressure", label: "Pressure switch", type: "yes-no" },
    { id: "tamper", label: "Tamper switch", type: "yes-no" },
    { id: "secondsToSignal", label: "Seconds to signal", type: "number" },
    { id: "repairDate", label: "Repair date", type: "date" },
    { id: "repairPerson", label: "Repaired by", type: "text" },
  ] },
  "Stairwell.pdf": { title: "Stairwells Quarterly Checklist", cadence: "quarterly", months: alternateQuarterMonths, scope: "area", fields: [{ id: "location", label: "Stairwell location / number", type: "text", required: true }] },
  "Storage.pdf": { title: "Storage Rooms Quarterly Checklist", cadence: "quarterly", months: quarterMonths, scope: "area", fields: [{ id: "location", label: "Storage room location", type: "text", required: true }] },
  "Weekly Meeting.pdf": { title: "Weekly Maintenance Department Meeting", cadence: "weekly", scope: "property", kind: "meeting", fields: [
    { id: "meetingLead", label: "Meeting lead", type: "text" },
    { id: "progress", label: "Progress / PM tracker review", type: "textarea" },
    { id: "upcomingDates", label: "Upcoming dates", type: "textarea" },
    { id: "goals", label: "Goals", type: "textarea" },
    { id: "attendees", label: "Attendees", type: "textarea" },
    { id: "meetingNotes", label: "Meeting notes", type: "textarea" },
  ] },
};

function slug(value: string) {
  return value.toLowerCase().replace(/\.pdf$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function makePdfTemplates(): PmTemplate[] {
  return data.pdfs.flatMap((pdf) => {
    if (pdf.file === "Fitness Center (1).pdf") return [];
    const metadata = pdfMetadata[pdf.file];
    if (!metadata) throw new Error(`PM source PDF has no form metadata: ${pdf.file}`);
    const checklist = pdf.file === "Room PM Checklist.pdf"
      ? Object.entries(roomSourceItems).map(([row, item]) => ({ id: `room-pm-scan-${row.toLowerCase()}`, label: item.label, source: `PM Scan.pdf room checklist ${row}` }))
      : pdf.lines
      .filter((line) => !/^(?:Q[1-4]|YES|NO|DATE|YEAR|NOTES|MAINTENANCE)$/i.test(line))
      .filter((line) => !/^The (?:[A-Z]|property|form|checklist)/.test(line) || line.length < 220)
      .map((label, index) => ({ id: `${slug(pdf.file)}-item-${index + 1}`, label, source: pdf.file }))
      // Printed instructions and column headers are not inspection answers.
      // Filter AFTER assigning IDs so every real saved answer retains its identity.
      .filter(item => !/^create work orders based off|^Q1 DATE Q2 DATE|^MAINTENANCE Q1 Q2/i.test(item.label));
    if (["Emergency lighting-Exit Sign log Master.pdf", "Monthly Fire Extinguisher Log.pdf", "Monthly Laundry Chute Log.pdf", "Monthly fire Door log.pdf"].includes(pdf.file)) {
      // These records use the actual per-device Yes/No log fields below, not
      // synthetic checkboxes for their printed instructions.
      checklist.length = 0;
    }
    // Append missing source definitions without renumbering any saved response ID.
    const supplements: Record<string, Array<{ id: string; label: string; source: string }>> = {
      "Kitchen.pdf": [
        { id: "kitchen-scan-walk-in-cooler", label: "Walk-in cooler preventive maintenance per manufacturer, if applicable", source: "PM Scan.pdf page 25" },
        { id: "kitchen-scan-dishwasher", label: "Dishwasher preventive maintenance per manufacturer", source: "PM Scan.pdf page 25" },
        { id: "kitchen-scan-cooking-equipment", label: "Cooking equipment (grills/stoves) preventive maintenance per manufacturer", source: "PM Scan.pdf page 25" },
      ],
      "Ice Machine Areas.pdf": [
        { id: "ice-machine-areas-scan-manufacturer-pm", label: "Maintain and clean the ice machine per manufacturer instructions, including sanitizer, cleaning solution and rinse cycles", source: "PM Scan.pdf page 26" },
      ],
    };
    checklist.push(...(supplements[pdf.file] || []));
    return [{
      id: `pdf:${slug(pdf.file)}`,
      title: metadata.title,
      cadence: metadata.cadence,
      scope: metadata.scope,
      kind: metadata.kind || "inspection",
      ...(metadata.months ? { months: metadata.months } : {}),
      sourceFile: pdf.file,
      sourceReference: pdf.file,
      instructions: metadata.instructions,
      checklist,
      fields: [
        ...commonFields,
        ...(metadata.scope === "equipment" && !(metadata.fields || []).some((field) => ["unitIdentifier", "location"].includes(field.id))
          ? [{ id: "location", label: "Equipment location / identifier", type: "text" as const, required: true }]
          : []),
        ...(metadata.fields || []),
        { id: "notes", label: "Inspection notes", type: "textarea" as const },
      ],
      repeatableFields: metadata.repeatableFields,
      repeatableLabel: metadata.repeatableLabel,
    }];
  });
}

const dailyTemplate: PmTemplate = {
  id: "workbook:daily",
  title: "Daily Maintenance Checklist",
  cadence: "daily",
  scope: "property",
  kind: "routine",
  sourceFile: data.workbook,
  sourceReference: `${data.workbook} · JAN!A6:A21`,
  checklist: data.daily.map((item) => ({ id: item.id, label: item.label, category: item.category, source: item.source })),
  fields: [],
};

const weeklyTemplate: PmTemplate = {
  id: "workbook:weekly",
  title: "Weekly Maintenance Checklist",
  cadence: "weekly",
  scope: "property",
  kind: "routine",
  sourceFile: data.workbook,
  sourceReference: `${data.workbook} · JAN!A23:E27`,
  checklist: data.weekly.map((item) => ({ id: item.id, label: item.label, source: item.reference || item.source })),
  fields: [],
};

const monthlyTemplates: PmTemplate[] = data.months.map((month) => ({
  id: `workbook:monthly:${month.month.toLowerCase()}`,
  title: `${calendarMonths[monthNumber[month.month] - 1]} Monthly PM`,
  cadence: "monthly",
  scope: "property",
  kind: "routine",
  months: [monthNumber[month.month]],
  sourceFile: data.workbook,
  sourceReference: `${data.workbook} · ${month.month}!B34:C`,
  checklist: month.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    category: task.section,
    source: task.references.length ? `${task.source} · ${task.references.join(", ")}` : task.source,
  })),
  fields: [{ id: "notes", label: "Monthly notes", type: "textarea" }],
}));

export const PM_TEMPLATES: PmTemplate[] = [dailyTemplate, weeklyTemplate, ...monthlyTemplates, ...makePdfTemplates()];
export const PM_ROOM_NUMBERS = data.roomNumbers;
export const PM_WORKBOOK_SOURCE = data.workbook;
export const PM_SUPPORTED_YEARS = [2022, 2023, 2024, 2025, 2026] as const;
export const PM_ROOM_TEMPLATE_ID = "pdf:room-pm-checklist";
export const PM_DAILY_TEMPLATE_ID = dailyTemplate.id;
export const PM_WEEKLY_TEMPLATE_ID = weeklyTemplate.id;

export function findPmTemplate(id: string) {
  return PM_TEMPLATES.find((template) => template.id === id) || null;
}

export function validPmPeriod(template: PmTemplate, value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  if (template.cadence === "daily") return true;
  if (template.cadence === "weekly") return date.getUTCDay() === 1;
  if (date.getUTCDate() !== 1) return false;
  if (template.cadence === "monthly") return !template.months || template.months.includes(date.getUTCMonth() + 1);
  return !template.months || template.months.includes(date.getUTCMonth() + 1);
}

export function pmWeekDates(weekStart: string) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${weekStart}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export function pmWeekStart(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function templatePeriodsForWeek(template: PmTemplate, weekStart: string) {
  const dates = pmWeekDates(weekStart);
  if (template.cadence === "daily") return dates;
  if (template.cadence === "weekly") return [weekStart];
  const monthStarts = Array.from(new Set(dates.map((date) => `${date.slice(0, 7)}-01`)));
  return monthStarts.filter((period) => {
    const month = Number(period.slice(5, 7));
    return (!template.months || template.months.includes(month))
      && validPmPeriod(template, period);
  });
}

export function quarterPeriodForDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  const month = Math.floor(date.getUTCMonth() / 3) * 3 + 1;
  return `${date.getUTCFullYear()}-${String(month).padStart(2, "0")}-01`;
}
