# CMPRI Refined Troubleshooting Guide
Version: Go-Live Working Revision — 2026-09-16

> Historical revision: the later asset-selection requirement supersedes this document's separate manufacturer/model verification and shared-catalog lookup requirements. See [Asset-manual troubleshooting](CMPRI_ASSET_MANUAL_GUIDANCE.md) for the current source and workflow rules.

## Purpose
CMPRI may show manufacturer troubleshooting only from a verified PDF whose manufacturer and exact model family or model number match the selected equipment. The verified PDF is the source of truth: extract or refresh structured guidance from it automatically. If there is no exact verified match, show no troubleshooting fallback or unrelated manual.

## 1. Troubleshooting order
1. Start with the reported issue, not just the selected category.
2. Use the selected asset/equipment record when available.
3. Use room/location context when it changes likely causes.
4. Read Actions Taken / technician notes before suggesting anything.
5. Remove checks that are already documented as completed or ruled out.
6. If a diagnostic/error code is reported, surface that code immediately.
7. Match the verified PDF against both manufacturer and exact model family or exact model number; do not use `documentation_key` as a substitute for identity matching.
8. On an exact match, automatically extract or refresh structured guidance from that PDF, preserving source pages and PDF reference.
9. If no verified manual match exists, show no generic troubleshooting and do not borrow another equipment guide.
10. Do not invent a manufacturer procedure, code meaning, measurement, or part specification beyond the verified PDF.

## 2. Issue-first logic
The issue description wins over a bad or overly broad category assignment.

Example:
- Asset: Vanity Base
- Category: Electrical
- Issue: Vanity base is cracked

Result:
- Show cabinet/vanity repair inspection.
- Do not show electrical-supply troubleshooting merely because the category says Electrical.

## 3. Actions-already-taken logic
Actions Taken / Root Cause / technician notes are authoritative context.

If a technician already documented:
- breaker checked,
- thermostat reset,
- filter cleaned,
- outlet verified,
- bulb replaced,
- code ruled out,
- part swapped,
- connection reseated,

then CMPRI should not tell them to repeat that step unless a later manufacturer procedure specifically requires rechecking it for a different reason.

If a note says:
- "not code 1"
then Code 1 should be removed from the active diagnostic possibilities while other applicable codes remain.

## 4. Repairability-aware guidance
Troubleshooting must decide whether the reported condition is:
- diagnostic,
- repairable,
- replaceable,
- cosmetic,
- adjustment/alignment,
- consumable,
- or safety-related.

Do not give generic repair steps to equipment that is clearly non-repairable at hotel level.

Example — broken television:
- Verify power/source only if those checks have not already been completed.
- Inspect for obvious external/connection issues.
- If the LCD/panel is physically broken, treat the television as replacement/salvage, not a generic "repair the component" task.
- If parts are scavenged, send retained components into Salvage Inventory linked to the source asset.

## 5. Manufacturer documentation rules
Verified on-file manufacturer documentation is the highest technical source.

Display:
- document title,
- manufacturer/equipment,
- verified status,
- applicable PDF,
- applicable pages where known,
- issue-specific steps,
- error-code table only when relevant.

PDF/manual lookup is enrichment only. The troubleshooting panel must not sit blank or on a spinner waiting for documentation.

Uploaded documentation is not "verified manufacturer guidance" merely because a PDF exists. It must be associated with the correct equipment and explicitly verified.

## 6. Diagnostic/error-code behavior
When a code is typed or reported:
1. Show the reported code immediately.
2. Match the code to verified documentation for the selected equipment.
3. Show:
   - Code
   - Meaning / condition
   - What the unit does in response
   - Diagnostic checks
   - Expected result/range when the manual provides one
   - Corrective action
   - Manual/PDF source
4. Preserve the reported code in the ticket even if a specific manual revision lists the number as Not Applicable.
5. Never silently map a code from another manufacturer/model.

### Friedrich Vert-I-Pak
Use the verified Friedrich Vert-I-Pak table when the selected asset/manual is actually Friedrich VPAK/Vert-I-Pak.

Examples:
- Code 3 — Indoor Temperature Sensor Open/Shorted
  - Check the sensor connector and wiring.
  - Measure the sensor against the manufacturer's temperature/resistance table when that test is available in the verified manual.
  - Replace the sensor if it is open, shorted, or outside the specified value.
  - Include the unit's fallback operating behavior from the service manual.

- Code 5 — Outdoor Coil Temperature Sensor Open/Shorted
  - Check sensor wiring/connection.
  - Test the sensor using the verified manufacturer procedure.
  - Explain the unit's fallback behavior and heating logic.
  - Do not jump directly to control-board replacement without diagnostic evidence.

- Code 15 — Heat Pump Error
  - Show the manual condition that triggers the error.
  - Check likely causes such as reversing-valve operation and abnormal heat load as supported by the verified manual.
  - Keep electric-heat fallback behavior visible when applicable.

Codes 10 and 12:
- If the verified on-file manual says Not Applicable but the unit/diagnostic tool reports the code, retain the code in the ticket and verify the exact unit/control revision rather than inventing a repair.

## 7. General issue routes

### HVAC — no heat / no cooling / poor airflow
Use the actual symptom plus selected equipment.
Possible sequence when not already completed:
- Confirm the reported mode and room condition.
- Verify controls/thermostat call.
- Check power/control state appropriate to the unit.
- Check airflow restriction and blower operation.
- Read any active diagnostic code.
- Move into manufacturer-specific sensor/control/refrigeration testing only when supported by the matched manual.
- Distinguish "unit operating but not satisfying" from "unit will not operate."

Avoid repeating generic lockout warnings on every step.

### Plumbing — sink leak
- Dry the area so the source can be identified.
- Run faucet and inspect supply stops, hoses, faucet shanks, and faucet-body connections.
- Fill and drain the sink; inspect strainer/disposal flange, disposal, dishwasher connection, discharge tube, P-trap, trap arm, washers, and wall connection.
- Repair the confirmed source, not unrelated plumbing parts.
- Check cabinet/wall water damage after the leak is identified.

### Garbage disposal — humming/jammed/not spinning
- Use safe jam-clearing procedure.
- Check for obstruction without putting hands into the chamber.
- Use manufacturer-approved wrench/jam-clearing point when provided.
- Verify overload/reset after clearing the jam.
- Test for leaks.
- If motor remains seized, repeatedly trips, or housing leaks, move toward replacement.

### Television / Enseo
Separate:
- power,
- TV hardware,
- HDMI/input,
- STB,
- network/Enseo service,
- physical screen damage.

A physically broken LCD is not an Enseo troubleshooting problem.
Maintain TV and STB sub-location assignments separately.

### Doors / locks
Distinguish:
- hardware alignment,
- loose/failed fastener,
- latch/strike,
- closer,
- hinge,
- lock/electronic lock,
- door/frame damage.

Do not recommend replacing a lock when the symptom is clearly mechanical alignment unless testing supports it.

### Appliances
Identify whether the complaint is:
- no power,
- no operation,
- abnormal noise,
- leak,
- temperature,
- drainage,
- control/error code.

Use manufacturer documentation when the actual appliance model is known.

### Pool / pool-room equipment
Troubleshooting for pool equipment must be asset-specific.
Do not mix water-chemistry corrective actions with pump/heater/dehumidification equipment diagnostics.

## 8. Redundant guidance filter
Suppress generic steps that the ticket already says were completed.

Examples:
- "breaker is not tripped"
- "reset thermostat"
- "cleaned air filter"
- "replaced bulb"
- "verified outlet"

Keep a still-relevant deeper step even when the basic check was completed.

Example:
- Outlet already verified -> remove "verify outlet."
- Still keep "inspect fixture socket / internal connection" if applicable.

## 9. Troubleshooting display
The technician should see, in this order:

1. **Reported issue**
2. **What has already been tried**
3. **Recommended next checks**
4. **Detected/reported diagnostic code**
5. **Manufacturer-specific diagnostic procedure**
6. **Expected result**
7. **Corrective action**
8. **Verified source / PDF**
9. **Parts or replacement implication**, when supported

Keep the troubleshooting section concise. Do not bury the next useful action under long safety boilerplate or duplicate warnings.

## 10. Role-based depth
### Front Desk troubleshooting profile
Front Desk troubleshooting should be short, non-invasive, guest-facing/basic operational guidance only. It should help determine whether a work order is needed and collect better information.

### Maintenance Technician troubleshooting profile
Maintenance Technician gets the full diagnostic flow, codes, measurements, manual references, parts implications, and repair-vs-replace guidance.

### Chief Engineer
Chief Engineer gets the technician view plus equipment/documentation management and the ability to correct asset/manual associations.

## 11. What CMPRI should learn from ticket history
Historical completed work can help rank likely causes, but it must not override verified manufacturer information.

Useful examples:
- recurring failure on the same asset,
- same model repeatedly needing the same part,
- repair that already failed,
- unit previously rebuilt/replaced,
- known room-specific wiring/plumbing condition.

History should be shown as context, not as proof that the current problem has the same cause.

## 12. Go-live acceptance checks
Before go-live, verify:
- issue-first routing works,
- already-completed steps disappear,
- explicitly ruled-out codes disappear,
- reported codes remain preserved,
- Friedrich VPAK codes use the verified table only for matching equipment,
- PDF/manual enrichment does not block initial guidance,
- changing the selected asset reloads the correct documentation,
- broken TV routes to replacement/salvage rather than generic physical repair,
- no unrelated category guidance leaks into the result,
- no manual content is marked verified solely because it was uploaded,
- Front Desk and Maintenance Technician see different troubleshooting depth,
- troubleshooting remains usable if documentation lookup fails.

## 13. Live implementation gaps found during audit
The current Next.js work-order page already contains useful issue-first routing, a conservative "already done" filter, diagnostic-code extraction, verified Friedrich VPAK code data, and verified-document gating. The following refinements are still required before this guide is considered fully implemented:

### Actions Taken must participate in filtering
The current troubleshooting filter must use all relevant technician context, not just the Notes field.

Combine:
- Technician Notes
- Actions Taken / Root Cause
- structured diagnostic actions when available

A check documented in any of those places should be eligible for suppression from the next-step list.

### Diagnostic-code cards must be structured
Do not render a verified manufacturer code as only:
- Problem
- Solution / Action

Where the source provides enough information, render:
- Reported code
- Meaning / trigger condition
- Unit response / fallback behavior
- Diagnostic checks
- Expected reading / result
- Corrective action
- Source page / PDF

If the manual does not provide one of those fields, leave it absent rather than inventing it.

### Verified-document gate
Selecting or changing an asset clears prior equipment guidance while its PDF match is checked.
Show troubleshooting only after the verified PDF matches the manufacturer and exact model family or model number. If no exact match is available, keep the guide empty rather than showing generic or unrelated steps.

### Explicitly ruled-out diagnostic codes
If technician context clearly states a code is not present or has been ruled out, that code must not appear in the "potentially relevant" list simply because its keywords resemble the complaint.

### History-aware context
Recent completed work on the same asset may be shown separately as "Relevant history" but must not be mixed into manufacturer instructions or presented as a confirmed current diagnosis.
