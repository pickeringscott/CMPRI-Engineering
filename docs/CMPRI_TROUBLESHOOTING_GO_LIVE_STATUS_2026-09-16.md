# CMPRI Troubleshooting Go-Live Status
Date: 2026-09-16

This file records what is actually verified and linked in the live CMPRI Supabase data after the troubleshooting/documentation integrity audit.

## Verified / linked live

### Friedrich Vert-I-Pak
- Live asset: `Friedrich Vert-I-Pak`
- Model: `VEA12K34-RTL-B`
- Knowledge: `friedrich-vert-i-pak-manual-knowledge-v1`
- Source: verified Friedrich service/parts manual
- Coverage: general checks, manual tests, diagnostic codes, symptom rules

### UniMac Washer #1
- Model: `UWN065T4VXU4001`
- Serial: `1305000216`
- Knowledge: `unimac-uwn065t4v-programming-guide-knowledge-v1`
- Source applicability to UWN065T4V verified from Alliance F8434101 model list

### UniMac Washer #2
- Model: `UWN065T4VXU4001`
- Serial: `1305000017`
- Knowledge: `unimac-uwn065t4v-programming-guide-knowledge-v1`
- Source applicability to UWN065T4V verified from Alliance F8434101 model list

### Navien NPE tankless water heaters
- Knowledge: `navien-npe-service-manual-knowledge-v1`
- Source: verified Navien NPE service manual
- Manual covers the NPE family and retains model-specific A/S distinctions in the guidance

### Symmons Temptrol shower valve
- Knowledge: `symmons-temptrol-troubleshooting-knowledge-v1`
- Source: verified Temptrol parts/troubleshooting reference

### DormaKaba Saflok Quantum RFID / System 6000
- Live asset: `DormaKaba Saflok RFID Lock`
- Model/family: `Quantum RFID Locks & HH6 Handheld Programmer`
- Knowledge: `dormakaba-saflok-quantum-system6000-knowledge-v1`
- Sources: dormakaba Quantum RFID product documentation + System 6000 reference manual
- Coverage intentionally limited to RFID/System-6000-safe workflows: battery, clock/date reset, temporary emergency power, credential/access symptom separation
- Legacy magnetic-card-reader-only procedures are excluded

### Maritime Geothermal / Nordic PC-55 pool conditioner
- Model: `PC-55-P-15-T-KDERS-13`
- Generation: `Gen2 Series (Rev 13)`
- Knowledge: `maritime-nordic-pc55-specification-knowledge-v1`
- Source: exact-model engineering specification / technical submittal
- Coverage: humidity/dehumidification, pool-water heating, airflow, water flow/pressure drop, condensate, scale implications
- This source is intentionally labeled as a technical specification, not misrepresented as a full service manual

### Hayward ProSeries S310T2 pool filter
- Composite live asset also includes an EcoStar/TriStar pump family, but only the filter is currently verified
- Knowledge: `hayward-proseries-s310t2-filter-knowledge-v1`
- Source: Hayward S310T2/S360T2 OEM owner manual
- Coverage: low flow, high filter pressure, backwash trigger, short filter cycles, filtration checks
- Pump-specific repair guidance remains intentionally excluded until exact pump model is confirmed

## Source/data corrections completed during audit

### Bad UniMac dryer file quarantined
The CMPRI document record `boh-dryer-utf75ruf6a2w01` was disabled because every inspected Drive copy titled `BoH Dryer UTF75RUF6A2W01.pdf` actually contains Alliance Pocket Hardmount **washer-extractor** parts manual F8453401.

Live document state:
- `active = false`
- `ingestion_status = content_mismatch`
- audit explanation preserved in `ingestion_error`

Correct OEM dryer-family troubleshooting source has been identified separately (Alliance 70398301R2), but it is not being linked until the live dryer asset identity/control configuration is reconciled.

### Misrepresented UniMac UWN065 troubleshooting sources quarantined
The indexed troubleshooting source F8123401R2 does not establish UWN065T4V applicability; its model list is an older 35/60/80/100/125/150 family.

Actions taken:
- old `unimac-uwn065t4v-troubleshooting` document disabled
- old `unimac-uwn065t4v-quick-troubleshooting` document disabled
- old troubleshooting cache source verification downgraded
- installed UWN065 washers moved to the exact-model-compatible F8434101 programming/diagnostic knowledge

### Manual matching hardened in source
`src/app/api/maintenance-reference/route.ts` was corrected so a model-specific manual cannot activate merely because manufacturer/equipment wording is similar.

Rules now include:
- model-specific document requires confirmed asset-model match
- bare manufacturer match is not enough for last-resort structured-cache fallback
- exact `documentation_key` remains authoritative

## Identified but not yet verified/linked for model-specific troubleshooting

### Carrier 48TCEA06 rooftop unit
- Model: `48TCEA06A2A5A0A0A0`
- Serial: `3812C84056`
- Technical index has a reference/archive description but no actual readable Carrier service file is present in the connected Drive
- Do not claim model-specific troubleshooting coverage yet

### Carrier 48FEEM08 WeatherMaster rooftop unit
- Model: `48FEEM08A2A5A0A0A0`
- Serial: `0525P30255`
- Technical index has a takeout/reference entry but no actual readable service file is present in the connected Drive
- Do not claim model-specific troubleshooting coverage yet

### Verdant EMS thermostat
- Model: `VX2-VX-TR-U-W`
- Manufacturer confirmed: Verdant
- Exact model identity is recorded, but a sufficiently exact service/diagnostic source has not yet been verified
- Do not populate guessed reset/programming/error-code procedures

### Scotsman commercial modular ice maker
- Manufacturer: Scotsman
- CMPRI records strongly reference Prodigy/Prodigy Plus C0330, but the equipment directory has the broader `C0330 / C0530 on B530S Bin` description
- OEM C0330 family has been validated, but direct live model-specific linkage remains withheld until installed model/revision is unambiguous

### GE Zoneline VTAC / PTAC
- Manufacturer confirmed: GE
- CMPRI equipment directory references both `AZ9VAH12DAC` and `AZ95E12DACK1` across alternate suites
- Existing exact service knowledge is AZ95-family specific
- Generic live asset remains unlinked so AZ95-specific tests cannot leak onto an unconfirmed GE unit

### UniMac dryers
- Historical CMPRI record identifies `UTF75RUF6A2W01`
- Correct OEM UTF75 troubleshooting family has been identified
- The live `UniMac Dryer #1/#2` rows do not yet carry exact model/serial/control identity
- Do not link them until physical/live-asset reconciliation is complete

## Other active equipment still without structured documentation
- Edwards EST3X fire alarm
- Enseo TV system
- air compressor
- generic Commercial Washer #1/#2/#3
- generic Commercial Dryer #1/#2/#3
- Life Fitness exercise bike
- network/demarcation/phone/camera systems
- signage documentation remains pending

These do not all need deep manufacturer diagnostics to go live. Issue-first general guidance may cover basic work, but CMPRI must not label unsourced procedures as verified manufacturer guidance.

## Remaining application-layer gap
The current work-order page `ManualKnowledge` normalizer still drops structured:
- `general_checks`
- `manual_tests`

while preserving:
- `error_codes`
- `symptom_rules`

A safe refactor is still required so high-value verified procedures are not silently discarded. Do not solve this by converting every manual test to an unscoped symptom rule because empty-match symptom rules currently display for every issue.

## Go-live rule
Troubleshooting go-live is acceptable only when the UI clearly distinguishes:
1. issue-based CMPRI general guidance,
2. verified equipment/manufacturer guidance,
3. relevant historical context,
4. missing/unverified documentation.

A missing manual must never produce a blank troubleshooting panel, and an incorrect/mislabeled manual must never be treated as better than safe general guidance.
