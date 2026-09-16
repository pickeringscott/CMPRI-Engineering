# CMPRI Troubleshooting Acceptance Matrix
Version: 2026-09-16

This matrix turns the refined troubleshooting guide into concrete go-live tests.

| ID | Scenario | Ticket / Context | Expected Result | Must Not Happen |
|---|---|---|---|---|
| T01 | Issue beats bad category | Asset: Vanity Base; Category: Electrical; Issue: vanity base is cracked | Cabinet/vanity inspection and repair guidance | Electrical supply troubleshooting appears just because category is Electrical |
| T02 | Already tried — outlet | TV no power; notes say outlet verified working | Outlet check removed; remaining TV checks remain | Whole troubleshooting list disappears |
| T03 | Already tried — root cause field | HVAC complaint; Actions Taken / Root Cause says thermostat reset and filter checked | Those basic steps are suppressed even if not in Notes | App repeats thermostat/filter checks because it only reads Notes |
| T04 | Explicit ruled-out code | Friedrich ticket notes say "not code 1" | Code 1 excluded from active/relevant code suggestions | Code 1 returns through keyword ranking |
| T05 | Reported code preserved | Ticket explicitly reports Code 10 or Code 12 | Reported code remains visible; exact unit/control revision verification is requested | Code silently discarded because current manual says Not Applicable |
| T06 | Friedrich Code 3 | Matching verified Vert-I-Pak equipment/manual; ticket reports Code 3 | Show code meaning, fallback behavior, sensor/wiring diagnostic path, source/manual reference | Generic HVAC code from another model/manufacturer |
| T07 | Friedrich Code 5 | Matching verified Vert-I-Pak equipment/manual; ticket reports Code 5 | Show outdoor coil sensor condition, diagnostic path, fallback/heating behavior, source | Immediate control-board replacement without evidence |
| T08 | Friedrich Code 15 | Matching verified Vert-I-Pak equipment/manual; ticket reports Code 15 | Show heat-pump error condition, manual-supported likely causes, electric heat fallback when applicable | Unverified refrigerant/part diagnosis presented as fact |
| T09 | Wrong-manufacturer protection | Non-Friedrich asset reports Code 3 | Use that asset's verified manual if available; otherwise say no verified matching code | Friedrich Code 3 is silently applied |
| T10 | Physical TV damage | Television; issue: cracked/broken LCD | Replacement guidance; asset can move to retirement/salvage workflow | Generic fastener/component repair guidance |
| T11 | TV vs Enseo separation | TV has no signal but powers on | Check input/HDMI/STB/provisioning and scope of outage | Physically replace TV before isolating signal/STB issue |
| T12 | STB sub-location | Room has Living Room and Bedroom TV/STB | Troubleshooting references exact assigned sub-location | TV/STB assignments treated as room-level only |
| T13 | Sink leak | Plumbing; water under sink | Isolate supply, faucet, strainer/disposal, discharge, P-trap/trap arm, wall connection | Replace unrelated plumbing parts without finding source |
| T14 | Disposal jam | Disposal humming/jammed | Safe jam-clearing, reset, leak test, replacement if motor remains seized/housing leaks | Hand-in-chamber instruction or blind part replacement |
| T15 | Manual unavailable | Selected asset but manual/API lookup fails | Issue-based troubleshooting stays visible and usable | Blank troubleshooting pane or permanent loading spinner |
| T16 | Unverified upload | PDF uploaded but verification marker absent | PDF visible as reference, extracted guidance not treated as verified | Upload automatically becomes trusted manufacturer procedure |
| T17 | Verified upload | Correct equipment PDF explicitly verified | Verified source title/PDF/pages may enrich troubleshooting | Unrelated document wins over documentation_key/equipment match |
| T18 | Asset changed | Technician changes selected equipment | Troubleshooting/manual reloads for newly selected asset | Previous asset's codes/manual remain on screen |
| T19 | No asset selected | Issue present, no equipment selected | Useful issue-based general troubleshooting shown | App requires an asset before giving any guidance |
| T20 | Front Desk profile | Front Desk troubleshooting view | Short, non-invasive checks and better-information prompts only | Measurements, electrical disassembly, internal repair procedures |
| T21 | Maintenance Technician profile | Maintenance Technician troubleshooting view | Full diagnostic flow, codes, readings, manual links, parts implications | Front-desk-only shallow guidance replaces technical detail |
| T22 | Chief Engineer profile | Chief Engineer troubleshooting view | Technician depth plus ability to correct asset/document associations | Chief Engineer blocked from equipment/document correction |
| T23 | Relevant history | Same asset has prior completed repair | Prior repair may appear in separate Relevant History context | Historical repair is presented as proof of current root cause |
| T24 | Salvage implication | TV physically broken and retired after diagnosis | Replacement can hand off retained parts to Salvage Inventory linked to source asset | Salvaged parts lose provenance |
| T25 | Manual page references | Verified manual entry contains source pages | Page buttons/reference point to exact source pages when available | Fabricated page numbers |
| T26 | Code card structure | Verified code contains sufficient structured data | Meaning/condition, unit response, checks, expected result, corrective action, source shown separately | Everything collapsed into one ambiguous Solution paragraph |
| T27 | No invented measurements | Verified manual has no voltage/resistance/range for a step | No numeric range is displayed | Model invents a measurement/specification |
| T28 | Diagnostic relevance | Cooling complaint with no reported code | Relevant manual codes may be shown as reference and clearly labeled as possibilities | Suggested code is labeled as the actual displayed fault |
| T29 | Ticket notes update | Technician submits a new diagnostic note | Troubleshooting updates so completed checks no longer repeat | User must reload the whole app manually |
| T30 | Concise presentation | Typical ticket with manual + general guidance | Next useful checks visible quickly; source available without dominating page | Repetitive lockout/safety boilerplate overwhelms troubleshooting |

## Go-live blocking failures
The following failures block troubleshooting go-live:

- Manufacturer/model code leakage across equipment.
- A blank troubleshooting panel when documentation loading fails.
- Uploaded but unverified PDFs being treated as verified manufacturer guidance.
- Already-completed checks repeatedly suggested despite clear technician documentation.
- Physical TV damage routed to generic repair instead of replace/salvage.
- Front Desk being shown invasive technician-only procedures.
- Diagnostic measurements/specifications being invented rather than sourced.
