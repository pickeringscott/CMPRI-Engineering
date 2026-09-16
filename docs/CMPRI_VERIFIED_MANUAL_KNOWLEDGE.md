# CMPRI Verified Manual Knowledge
Version: 2026-09-16

This document records verified structured troubleshooting knowledge already available to CMPRI and the fields the Next.js troubleshooting engine must preserve.

## Structured fields to support
The troubleshooting engine should preserve and display, when present:

- `general_checks`
- `manual_tests`
- `error_codes`
- `symptom_rules`
- source title/type/verified state
- source pages / PDF link when known

The current Next.js `ManualKnowledge` normalizer handles `error_codes` and `symptom_rules`, but currently drops `general_checks` and `manual_tests`. That causes verified technician procedures to disappear from the ticket even though they exist in the structured knowledge.

## Friedrich Vert-I-Pak
Verified knowledge already includes the manufacturer Error Code / Problem / Action table and known fallback behavior. Friedrich VPAK codes must only be applied when the selected asset/manual actually matches Friedrich Vert-I-Pak/VPAK equipment.

Important behavior:
- preserve explicitly reported codes,
- Codes 10 and 12 may be listed as Not Applicable in the on-file manual; if reported by the actual unit/tool, retain the report and verify the exact control revision,
- do not infer another manufacturer's code definition.

## GE Zoneline AZ95
Source: **GE AZ95E12DACK1 Technical Service Guide** — verified.

High-value structured knowledge already available:

### General checks
- Record active fault codes before replacing parts.
- Use Service Mode to command affected functions when appropriate.
- Disconnect power before fan binding, connector, or motor-resistance checks.

### Manual tests
- Read/clear fault codes: hold MODE and press AUX; record active faults before clearing.
- Enter Service Mode: hold `+` and `-` for 2 seconds; MODE selects the function; `+` commands on; `-` commands off; AUX exits.
- Indoor fan test: Service Mode `IF`.
- Outdoor fan test: Service Mode `OF`.
- Indoor fan resistance: J103 pin 6 red to pin 4 black, approximately **12.56 ohms ±15%**.
- Outdoor fan resistance: J104 pin 6 red to pin 4 black, approximately **7.5 ohms ±15%**.

These tests must not be lost during manual normalization.

## Navien NPE tankless water heater
Source: **Navien NPE Service Manual.2015.09.01** — verified.

Structured knowledge includes:
- error history and reset behavior,
- ignition failure,
- false flame detection,
- flame loss,
- heat-exchanger/exhaust overheating,
- exhaust thermistor,
- Dual Venturi,
- fan motor,
- exhaust blockage,
- water thermistors,
- circulation pump,
- flow sensor,
- water-adjustment/mixing valves,
- PCB communication,
- DIP switch and panel faults.

Important routing:
- record the displayed error code before reset,
- use diagnostic/error history where needed,
- verify the exact NPE A/S model before model-specific recirculation/pump checks.

## UniMac UWN065T4V commercial washer
Source: **Troubleshooting Guide Unimac UWN065T4V** — verified.

### Manual tests already structured
- Emergency-stop / no-display check: verify emergency stop is pulled out and check 24 VDC / loose connections.
- Transformer check: verify transformer plug and correct 208/240 connection and check specified input/output voltage.

### Symptom routing already structured
- blank/no display,
- no fill,
- no hot/cold spray rinse,
- door/lock error,
- drain error,
- motor/drum not rotating.

The washer engine should consult machine diagnostics/alarm history before replacing drive or motor components.

## Symmons Temptrol shower valve
Source: **Shower Valve Temptrol Parts Diagram** — verified.

Structured guidance includes:
- no-flow requires both hot and cold supplies/pressure,
- shutoff leakage: inspect hot/cold washers and seat surfaces,
- temperature/flow imbalance: inspect pressure-balancing piston/spindle for restriction/debris,
- service-chart procedure for spindle movement,
- TA-9 washer repair kit / TA-4 seat repair kit where applicable,
- TA-10 flow-control spindle where applicable,
- hot-water overdraw guidance.

## Required Next.js change
Before troubleshooting go-live, extend `ManualKnowledge` normalization and display so verified `general_checks` and `manual_tests` are not discarded. Manual tests should appear ahead of generic fallback steps when they match the selected verified equipment and reported symptom.

Do not synthesize measurements or procedures absent from the verified payload.
