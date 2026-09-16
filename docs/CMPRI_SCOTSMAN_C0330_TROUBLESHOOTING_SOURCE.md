# CMPRI Scotsman C0330 Troubleshooting Source
Date: 2026-09-16
Status: OEM model family verified; structured cache not yet loaded

## CMPRI identity evidence
CMPRI historical/specification records identify the BOH ice machine as a Scotsman Prodigy / Prodigy Plus C0330 family machine, with B530S bin references in the equipment directory.

## OEM verification
Scotsman Ice Systems' own technical-service material identifies the **C0330** as part of the Prodigy Series Modular Cuber family and explicitly includes Prodigy Plus.

Scotsman OEM product/service material also identifies these relevant features for the C0330 Prodigy Plus family:

- AutoAlert indicator lights,
- one-touch cleaning,
- WaterSense purge control,
- Harvest Assist,
- optional Smart-Board diagnostic module,
- front-service access.

The OEM service material includes separate wiring/revision information for C0330/C0530 C and D series, so CMPRI must not assume a specific internal revision from the family name alone.

## Model-family-safe maintenance / troubleshooting guidance
For the C0330 family, CMPRI can safely organize troubleshooting around the following issue groups while keeping revision-specific electrical/refrigeration procedures gated by the exact unit revision.

### Reduced ice production
Before assuming a refrigeration fault, check:

- mineral scale in the water system,
- water distributor/orifice restriction,
- ice-thickness sensor cleanliness/condition,
- water-level sensing condition,
- condenser cleanliness on air-cooled models,
- air filter condition on applicable air-cooled units,
- water supply/flow,
- harvest behavior,
- active machine status/diagnostic indicators.

### Cleaning / scale / sanitation
Scotsman's C0322-through-C1030 E-series user manual describes the maintenance categories as:

- remove mineral scale from the water system and sensors,
- sanitize the water system and bin/dispenser,
- clean/replace the air filter and clean the air-cooled condenser where applicable.

For C0330 in that manual, the automated cleaning sequence calls for **8 ounces of Scotsman Clear 1 scale remover** when the display prompts for cleaner. This dose is series/manual specific and must only be displayed when the selected unit is confirmed to match that applicable series/procedure.

The same OEM procedure includes inspection/cleaning of the water distributor and restricted orifice holes, plus removal/cleaning of the ice-thickness sensor.

### Diagnostic/status behavior
CMPRI should record visible AutoAlert/status indications and any diagnostic display before clearing/resetting the machine. If Smart-Board is installed, its diagnostic data may be used as additional source context.

Do not translate a light/display condition into a root cause unless the applicable Scotsman service manual for that revision supports the interpretation.

## Historical CMPRI relevance
A completed historical CMPRI work order for `ICE-01 (Scotsman Prodigy C0330)` reported reduced ice production and mineral scaling. The recorded work included:

- automated descaling/sanitation,
- clearing the water-level sensor,
- cleaning the air-cooled condenser coil,
- verifying nominal harvest timing afterward.

This may be shown as **Relevant History** when a future C0330 complaint resembles it, but it must not be treated as proof that scale or the water sensor is the current fault.

## Required live-asset cleanup before direct model-specific linkage
Record or verify on the live Scotsman asset:

- full model from serial plate,
- series/revision where identifiable,
- serial number,
- condenser type (air/water/remote),
- installed optional diagnostic modules if relevant.

After that, ingest the matching Scotsman service-manual troubleshooting into `troubleshooting_cache` with exact source identity and page references.

## Source integrity rule
The existing CMPRI document index entry describes a Scotsman C0330/C0530/B530S service/sanitation reference, but it does not currently resolve to a verified Drive PDF. Use the OEM Scotsman service source as the authority until a correct on-file PDF is attached and verified.
