/** Shared, pure CMPRI workflow guidance. External MCP descriptions remain verbatim.
 * These statements describe workflow and data integrity, not an authorization layer.
 * Native operations keep their native role/ownership/validation rules; external
 * connection scope or adapter syntax does not create a new native restriction.
 */
export const CMPRI_WRITE_ACTION_GUIDANCE = Object.freeze({
  "hours_tracker.save_period": "Only on explicit request: save your own complete 14-day timesheet period. Read hours_tracker first; preserve every unchanged day and use its current revision. Never infer attendance, overnight work, or historical rate changes. confirmRateChange requires explicit confirmation for that period. No leave-policy/baseline edits or imports.",
  "hours_tracker.clock_in": "Only on explicit user request: start the authenticated actor's own private CMPRI shift now (America/Chicago, minute precision). Not Paycom. Supply unique request_id, reuse it unchanged on retry. Returns shiftId; does not create default attendance. Requires separately activated owner access.",
  "hours_tracker.clock_out": "Only on explicit user request: close the actor's own open shift now. Supply unique request_id and shift_id from clock-in; reuse identical inputs for retry. For a next-day finish ask for confirm_overnight=true; hours belong to the start date. Never overwrite manual data. For DST/forgotten shifts, first read back the recorded start and ask the user for the exact end with timezone offset, elapsed minutes and reason; only after confirmation supply reconciliation {resolution: finish, confirmed: true, reason, end_at, elapsed_minutes}. Alternatively explicitly confirm reconciliation {resolution: discard, confirmed: true, reason}, which closes the timer without recording hours. Never guess ambiguous times or truncate shifts. Not Paycom.",
  "work_orders.create": "Submit one or more CMPRI work orders, using the same validation and attribution as the CMPRI form.",
  "work_orders.import": "Import validated CMPRI work orders from SafetyCulture or a spreadsheet.",
  "room_operations.import": "For Daily Room Ops CSVs from the approved Drive folder, read the import contract and use source: drive with validate_only: true for preview. Confirmation requires validate_only: false and the preview previousId/source_digest; only save on an explicit import request. Read room_operations first for its import_contract. ChatGPT reads all supplied photos and extracts the complete report_data using that contract; never send images to server OCR. Include every active room with its exact room_status. Occupied rows require guest name, code, room type, arrival date, departure date, and length of stay; keep incoming guest fields separate. Preserve printed dates, times, and pages; ask for unreadable fields instead of guessing. Older-than-today reports are accepted when newer than stored source data. Validate with validate_only: true, then submit the same data without validate_only only when explicitly asked to import/save. Never claim success from validation alone.",
  "work_orders.update": "Edit an authorized work order by supplying its UUID as id, expected_revision from the latest work-order read, and editable fields. Fields may be flat or nested under changes, updates, or fields. Editable fields include notes, status, technician_name (assignment), category, issue, priority, asset_id, cost, hours, due_by, parts, and action_root_cause. Use the exact status 'In Progress' or 'Completed' when reopening a closed work order; reopening to Open is rejected. An In Progress order must have an assigned technician.",
  "work_orders.delete": "Cancel a work order by marking it Will Not Do. The ticket and its history are retained. Include its UUID.",
  "work_order_drafts.update": "Update your CMPRI work-order draft using its current revision.",
  "work_order_drafts.delete": "Delete a draft allowed by CMPRI draft ownership and supervisory policy.",
  "assets.create": "Create equipment under CMPRI equipment-management validation.",
  "assets.update": "Update equipment under CMPRI equipment-management validation. Verified records require an explicit revision: id, begin_documentation_revision: true, expected_updated_at, revision_reason. Prior verification and files are retained; save corrections with expected_updated_at, then verify again.",
  "engineering_catalog.create": "Create a supported CMPRI engineering catalog record.",
  "engineering_catalog.update": "Update a supported CMPRI engineering catalog record.",
  "engineering_operations.update": "Update a permitted CMPRI purchase or shipment operation.",
  "integrations.email.scan": "Run the authorized mailbox scan and import eligible operational records into CMPRI.",
  "corporate_pm.update": "Write an allowed verified cell through CMPRI's Corporate PM integration.",
  "pool_log.save": "Save pool readings. Required: date (YYYY-MM-DD, use the date from the pool read) and pool (exact active pool name such as Indoor Pool, or its id from the pool read). One water sample is taken per AM or PM test: every save must include that sample's pH (ph_am/ph_pm), bromine range (sanitizer_band_am/sanitizer_band_pm: 0, 1-2, 2-4, 3-6, 5-10, 7.5-15, 10-20). CMPRI records one shared sample for both shallow and deep, with collection location unspecified; do not ask for or invent a shallow/deep collection location. Historical sample attribution is preserved. Daily checks are recorded once per day: temperature_f, flow_rate_gpm, main_drain_visible (true/false), and filter_backwashed (true/false). Before saving, read the log: read.status.daily_checks_missing lists any daily check still needed—ask the user for each one and include it; if none are missing, they may be omitted. Keep asking until every required value is provided before calling save. A new complete passing test automatically updates current status using the existing daily checks, unless an independent manual closure remains. Historical failed readings and closure reasons are retained. For an additional test after AM/PM is recorded, submit retest: {id: a new UUID, ph: number, sanitizer_band: accepted band}; keep that UUID unchanged only when retrying the same submission. Corrections and remarks are not new tests. Use manual_closure: true for an unrelated reason to keep the pool closed; do not clear that flag as part of a retest. Legacy unclassified closures require source review and must not be guessed from free text. Saving the PM sample later adds it to the same day's log and never erases saved AM readings; do not resend values you did not collect. Only System Administrators can change a value that is already saved. Out-of-range readings (pH outside 7.2–7.8, bromine 0, 1–2, 7.5–15 or 10–20 ppm, main drain not visible, water above 104°F) mean the pool MUST BE CLOSED: tell the user clearly, and include closure_reason describing why it is closed and what was done. The response lists closure_reasons and warnings (such as flow below the required 48 GPM); always read them back to the user. requires_attention is optional true/false. Current closure_condition is derived from the submitted test and independent holds; use manual_closure to record an unrelated closure. Chlorine and cyanuric-acid readings are not used. For a retest, include the revision returned by the read as expected_revision and retain the submission UUID on retries. AM/PM additions do not require expected_revision. For an explicitly requested test entry, set test_entry: true; CMPRI adds 'Test entry' to remarks, but the sample and daily checks are still required. The pool name is resolved to the active facility id before saving.",
  "feedback.submit": "Submit feedback to CMPRI. Provide feedback_type as Problem, Bug, or Suggestion and description. page_route is optional; if supplied it must be a site path starting with /. The MCP connection records /mcp when no valid site path is provided. Feedback type matching is case-insensitive.",
  "feedback.review": "Review or update CMPRI feedback when permitted.",
  "feedback.delete": "Delete CMPRI feedback when permitted.",
  "profile.update": "Update your own CMPRI profile preferences or display name.",
  "users.create": "Create a CMPRI user under the current account-management policy.",
  "users.update": "Update a CMPRI user under the current account-management policy.",
  "rooms.update": "Update a CMPRI room or location.",
  "enseo_assignments.update": "Update a validated batch of CMPRI Enseo assignments.",
} as const);

export const ROOM_OPERATIONS_REPORTING_INSTRUCTIONS = "When a user reports a daily room-operations import, read the room_operations view for that date and tell the user every room marked out of order (including OOO) and every detected room move. Include each room number and its out-of-order status, and report every move as move_from to move_to room numbers. Do not omit or summarize away these room numbers.";

export const CMPRI_DATA_READ_GUIDANCE = `Read manager and engineering data from CMPRI using the connected user's current role and permissions. Choose a view from the allowed views listed for this account. For the Preventative Maintenance (PM) modal, use preventive_maintenance with week set to the Monday starting the requested week (YYYY-MM-DD). It returns the modal's saved entries, task states, review queue, current permissions, locations, and form templates. Optional id opens the same work-order-linked PM context as the modal. For older connections, corporate_pm without sheet also reads the PM modal: date selects its week, or defaults to the current week in America/Chicago; room optionally selects that room's PM entries. Only an explicit sheet requests the legacy Corporate PM spreadsheet. Report saved task/review states as returned; do not treat the empty workbook placeholder as completed or missing inspections. Supply record ids, dates, rooms, or asset ids when other views require them. ${ROOM_OPERATIONS_REPORTING_INSTRUCTIONS}`;

/** Exact source: docs/CMPRI_DOCUMENTATION_INTEGRITY_RULES.md.
 * Dated examples are historical integrity findings, not current live asset status.
 * The source-equality test prevents this shared rendering drifting from the document.
 */
export const CMPRI_DOCUMENTATION_INTEGRITY_RULES = [
  "# CMPRI Documentation Integrity Rules",
  "Date: 2026-09-16",
  "",
  "CMPRI must not treat a file as verified manufacturer guidance merely because its filename, Drive index row, or database metadata says it belongs to an asset.",
  "",
  "## Verification chain",
  "Before a document can supply verified troubleshooting, all applicable identities must agree:",
  "",
  "1. **Asset identity**",
  "   - manufacturer",
  "   - equipment type",
  "   - model/model family when the document is model-specific",
  "",
  "2. **CMPRI document index metadata**",
  "   - title",
  "   - manufacturer",
  "   - equipment",
  "   - model pattern",
  "   - document type",
  "   - shared-catalog documents must be explicitly active and have completed ingestion",
  "",
  "3. **Actual document content**",
  "   - cover/title text",
  "   - manufacturer identity agrees with the curated catalog entry",
  "   - equipment family named in the document",
  "   - listed applicable models",
  "   - the exact cataloged family or model identifier appears in the PDF text",
  "",
  "4. **Structured troubleshooting**",
  "   - extract it from the verified PDF itself,",
  "   - retain the source PDF and page references,",
  "   - refresh the stored structure when the source PDF or equipment identity changes.",
  "   - A pre-existing cache entry is not required.",
  "",
  "5. **Verification state**",
  "   - verification must be explicit after the identities above are checked.",
  "",
  "If these disagree, CMPRI must fail closed: the file may remain visible as an uploaded/reference document, but its extracted procedures must not be presented as verified troubleshooting.",
  "",
  "Shared manufacturer PDFs stored in `asset-documentation/Asset Docs` are surfaced from",
  "`maintenance_documents`, not copied into each equipment folder. A catalog entry is",
  "eligible only when `active = true` and `ingestion_status = 'complete'`; the",
  "manufacturer must match exactly, and the cataloged `model_pattern` must equal the",
  "equipment's model family or be the exact leading family identifier of its full",
  "model number. The PDF itself must contain that exact family/model token. Filename",
  "similarity, manufacturer-only matching, inactive entries, and incomplete ingestion",
  "never establish a match. These same checks gate both the equipment documentation",
  "panel and open-work-order troubleshooting.",
  "",
  "## Defect found: UniMac dryer document",
  "CMPRI's Drive/index contains files titled:",
  "",
  "`BoH Dryer UTF75RUF6A2W01.pdf`",
  "",
  "and the technical-document index describes that entry as:",
  "",
  "- Alliance / UniMac Commercial Dryer",
  "- Service & Parts Manual",
  "- model `UTF75RUF6A2W01` (75 lb)",
  "",
  "However, multiple duplicate Drive files carrying that dryer filename were inspected and their actual content begins as:",
  "",
  "- Alliance Laundry Systems",
  "- **Washer-Extractor**",
  "- **Pocket Hardmount**",
  "- Parts manual `F8453401`",
  "- applicable washer models including NWL/UWH/UWL/UWN/UWU families",
  "",
  "Therefore:",
  "",
  "- The indexed dryer file is mislabeled or points to incorrect content.",
  "- It must **not** be used to create a dryer troubleshooting cache.",
  "- It must **not** be linked as verified guidance to the live UniMac dryer assets.",
  "- The correct UTF75RUF6A2W01 dryer manual must be obtained/identified before structured dryer troubleshooting is built from that document.",
  "",
  "## Scotsman C0330 status",
  "CMPRI historical work-order/specification data identifies the ice machine as a Scotsman Prodigy C0330 / Prodigy Plus family.",
  "",
  "Scotsman's OEM service-manual catalog independently lists C0330 in the Prodigy Series Modular Cuber Technical Service Manual, including Prodigy Plus.",
  "",
  "This is useful model-family corroboration, but structured CMPRI troubleshooting should still be built from a readable, traceable OEM source and retain its source reference.",
  "",
  "## Required system behavior",
  "### Upload / document association",
  "When a PDF is uploaded to an asset:",
  "- populate candidate manufacturer/model/document fields from the PDF only as **unverified extracted metadata**,",
  "- compare extracted identity to the selected asset,",
  "- surface mismatches to Engineering,",
  "- require explicit verification before extracted service procedures become trusted.",
  "",
  "### Existing indexed documents",
  "A document verifier should detect at least:",
  "- filename says Dryer but content says Washer,",
  "- indexed manufacturer differs from document manufacturer,",
  "- indexed model pattern is absent from the document's applicable-model list,",
  "- troubleshooting cache source title differs materially from the indexed document,",
  "- one Drive file reused under conflicting equipment identities.",
  "",
  "### Fail-closed rule",
  "On mismatch:",
  "- do not silently select the document,",
  "- do not mark it verified,",
  "- do not use its codes/specifications in the troubleshooting panel,",
  "- do not generate or show generic troubleshooting or substitute an unrelated manual,",
  "- display an Engineering-only documentation mismatch notice.",
  "",
  "### Exact-match refresh",
  "- A verified PDF is eligible only when its text contains the equipment's exact manufacturer and either its exact model family or exact model number.",
  "- On an exact match, automatically extract/update structured troubleshooting from that PDF; the PDF remains the sole source of truth.",
  "- Do not use an existing troubleshooting-cache entry to establish a match. Cache entries may only store a structure generated from the currently matched verified PDF.",
  "- When no verified PDF matches exactly, show no documentation or troubleshooting guidance for that equipment.",
  "",
  "## Go-live acceptance additions",
  "- A deliberately mislabeled PDF must be rejected as verified guidance.",
  "- Model-specific troubleshooting must not activate for an asset with an unknown model unless the document explicitly covers the broader verified family.",
  "- Duplicate Drive files with the same title must not be assumed identical or correct based on title alone.",
  "- A document title/index row alone is never sufficient evidence of equipment identity.",
  "- Friedrich Verdepac documentation must match Friedrich + Verdepac VTAC; it must not match another Friedrich family.",
  "- Shared-catalog manuals in `Asset Docs` appear on equipment only after the active/complete catalog record and exact manufacturer/family plus PDF-content checks pass.",
  "- An exact shared-catalog match appears on the equipment record and is used to generate or refresh its open-work-order guidance; unmatched or content-mismatched manuals remain excluded.",
  "- Adding or updating a verified exact-match PDF must create or refresh its structured troubleshooting without requiring a prior cache entry.",
  "- If no verified exact-match PDF exists, no generic troubleshooting or unrelated documentation is shown.",
  "",
].join("\n");

/** Existing native business rules used by features not exposed as MCP writes. */
export const CMPRI_NATIVE_WORKFLOW_GUIDANCE = Object.freeze({
  preventive_maintenance: "Read the native PM workspace and actual template before a change. Preserve its current revision, correct period/scope, original form responses and actor attribution. Routine task transitions use the existing task ledger; submitted forms use the review flow. Never turn a missing/empty compatibility workbook into claimed missed or completed PM. Do not manufacture inspection results, approval, historical attendance or completed work. Native routine pool tasks require the matching actual daily Pool Log. Record deficiencies from reported observations; keep approved evidence and work-order links. Use only the native confirmation/review flow for recorded issues and preserve source references.",
  purchasing: "Read the current purchase order, inventory mapping and received comparison before editing. Ordered, shipped, carrier-delivered and physically received are different states. Stock is added only for actual confirmed physical receipt; email/import acceptance is not receipt evidence. Receive totals save only the additional quantity. Preserve package/unit conversion and loaded expected quantities/mapping when supplied. Reuse a stable operation ID only for an identical retry. Company approval needs the user's reviewed company evidence/reference, not an invented approval. Review an import before committing the same reviewed evidence; preserve native digest/cursor, source identifiers and explicit incomplete/error states.",
  inventory: "Physical stock counts, adjustments, returns, chemical consumption and ticket usage require actual user-supplied quantities and reasons where the native form requires them. Keep stock units, exact item/location IDs, current revision and stable retry ID. Never convert a shipping notice, order idea or requested part into consumed or received stock. Received/on-order part status is derived from its native PO link. Read current stock and preserve unrelated item details.",
  native_policy: "These shared workflow rules also serve the external MCP connection. For signed-in Ask CMPRI, the native route alone decides role/account/property permissions and accepted fields. External connection activation/scope limits and historical role summaries are not additional native gates. Use the native operation contract for transport names: external wrappers such as work-order changes/updates/fields, date/pool aliases or source:drive apply only through an explicitly supported normalizer/adapter. Full source/review/confirmation, no-guessing and readback rules still apply. A native save or validation error is never success.",
});

/** Preserve the workflow verbatim while keeping current native role policy authoritative. */
export const CMPRI_NATIVE_POOL_LOG_GUIDANCE = CMPRI_WRITE_ACTION_GUIDANCE["pool_log.save"].replace(
  "Only System Administrators can change a value that is already saved.",
  "Use the current native can_edit_saved and role permissions to decide whether an already saved value can be changed.",
);

const NATIVE_WRITE_GUIDANCE: Readonly<Record<string, keyof typeof CMPRI_WRITE_ACTION_GUIDANCE>> = Object.freeze({
  "work_orders.create": "work_orders.create", "work_orders.import": "work_orders.import", "work_orders.update": "work_orders.update", "work_orders.cancel": "work_orders.delete",
  "work_order_drafts.update": "work_order_drafts.update", "work_order_drafts.delete": "work_order_drafts.delete",
  "assets.create": "assets.create", "assets.update": "assets.update",
  "engineering_catalog.create": "engineering_catalog.create", "engineering_catalog.update": "engineering_catalog.update",
  "purchasing.operations_update": "engineering_operations.update", "operational_email.scan": "integrations.email.scan",
  "pool.log_save": "pool_log.save", "room_operations.import": "room_operations.import",
  "room_operations.validate": "room_operations.import", "room_operations.guest_reports_validate": "room_operations.import", "room_operations.drive_preview": "room_operations.import", "room_operations.drive_commit": "room_operations.import",
  "room_operations.guest_reports_import": "room_operations.import", "room_operations.drive_reports": "room_operations.import", "room_operations.drive_import": "room_operations.import",
  "feedback.submit": "feedback.submit", "feedback.review": "feedback.review", "feedback.delete": "feedback.delete",
  "profile.update": "profile.update", "users.create": "users.create", "users.update": "users.update", "rooms.update": "rooms.update", "enseo.move": "enseo_assignments.update",
});

/** Full shared guidance accompanies the selected native operation, never a summary. */
export function nativeOperationGuidance(key: string): string {
  const rules: string[] = [];
  if (["room_operations.files_validate", "room_operations.files_import"].includes(key)) rules.push(CMPRI_WRITE_ACTION_GUIDANCE["room_operations.import"]);
  const shared = NATIVE_WRITE_GUIDANCE[key];
  if (shared) rules.push(shared === "pool_log.save" ? CMPRI_NATIVE_POOL_LOG_GUIDANCE : CMPRI_WRITE_ACTION_GUIDANCE[shared]);
  if (key === "hours.save") rules.push(CMPRI_WRITE_ACTION_GUIDANCE["hours_tracker.save_period"].replace("No leave-policy/baseline edits or imports.", "The native configuration branch is separately available under current native role permissions and its source-evidence validation; do not invent leave policy or historical baseline evidence."));
  if (key === "hours.clock") rules.push(CMPRI_WRITE_ACTION_GUIDANCE["hours_tracker.clock_in"], CMPRI_WRITE_ACTION_GUIDANCE["hours_tracker.clock_out"]);
  if (key.startsWith("room_operations.")) rules.push(ROOM_OPERATIONS_REPORTING_INSTRUCTIONS);
  if (key.startsWith("preventive_maintenance.") || key === "corporate_pm.read") rules.push(CMPRI_DATA_READ_GUIDANCE, CMPRI_NATIVE_WORKFLOW_GUIDANCE.preventive_maintenance);
  if (key.startsWith("manuals.") || key.startsWith("troubleshooting.") || key.startsWith("assets.") || key === "maintenance_reference.read") rules.push(CMPRI_DOCUMENTATION_INTEGRITY_RULES);
  if (key.startsWith("purchase_orders.") || key.startsWith("purchasing_history.") || key.startsWith("purchasing.")) rules.push(CMPRI_NATIVE_WORKFLOW_GUIDANCE.purchasing);
  if (key.startsWith("engineering_catalog.") || key.startsWith("supply_use.") || key.startsWith("work_order_parts.") || key === "pool.log_save") rules.push(CMPRI_NATIVE_WORKFLOW_GUIDANCE.inventory);
  return rules.length ? [CMPRI_NATIVE_WORKFLOW_GUIDANCE.native_policy, ...rules].join("\n\n") : "";
}
