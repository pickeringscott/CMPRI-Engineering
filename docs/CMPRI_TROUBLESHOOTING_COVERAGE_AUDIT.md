# CMPRI Troubleshooting Coverage Audit
Date: 2026-09-16

This audit separates troubleshooting knowledge that is already live and safely linked from manuals/knowledge that exist but still require equipment identity confirmation.

## Live structured knowledge confirmed in Supabase

| Knowledge key | Manufacturer / equipment | General checks | Manual tests | Error codes | Symptom rules |
|---|---|---:|---:|---:|---:|
| `friedrich-vert-i-pak-manual-knowledge-v1` | Friedrich Vert-I-Pak | 27 | 25 | 15 | 26 |
| `ge-zoneline-az95-manual-knowledge-v1` | GE Zoneline VTAC/PTAC | 19 | 21 | 23 | 24 |
| `navien-npe-service-manual-knowledge-v1` | Navien NPE tankless water heater | 61 | 62 | 60 | 46 |
| `unimac-uwn065t4v-troubleshooting-knowledge-v1` | Alliance/UniMac washer-extractor | 7 | 28 | 4 | 17 |
| `unimac-uwn065t4v-programming-guide-knowledge-v1` | UniMac commercial washer | 22 | 11 | 33 | 33 |
| `symmons-temptrol-troubleshooting-knowledge-v1` | Symmons Temptrol shower valve | 1 | 1 | 0 | 7 |
| `curtis-coffee-server-parts-knowledge-v1` | Curtis coffee server | 5 | 3 | 0 | 5 |
| `ge-thermostat-wiring-diagram-knowledge-v1` | GE Zoneline thermostat wiring | 1 | 0 | 1 | 1 |

Additional parts-only knowledge exists for Alliance/UniMac and Navien but should not be treated as full troubleshooting guidance.

## Assets safely linked now

### Friedrich Vert-I-Pak
- Asset: `Friedrich Vert-I-Pak`
- Manufacturer: Friedrich
- Documentation key: `friedrich-vert-i-pak-manual-knowledge-v1`
- Status: linked.

### Navien NPE
- Asset: `Navien NPE Tankless Water Heaters`
- Manufacturer: Navien
- Documentation key: `navien-npe-service-manual-knowledge-v1`
- Status: linked.

### Symmons Temptrol
- Asset: `Symmons Temptrol Shower Valve`
- Manufacturer: Symmons
- Documentation key: `symmons-temptrol-troubleshooting-knowledge-v1`
- Status: linked.

### UniMac washers
- Assets: `UniMac Washer #1`, `UniMac Washer #2`
- Manufacturer: UniMac
- Documentation key: `unimac-uwn065t4v-troubleshooting-knowledge-v1`
- Status: linked in current database.
- Follow-up: model number is not populated on the asset rows; verify the physical units are UWN065T4V before treating that model identity as permanently confirmed.

## Knowledge/document exists but asset identity is not yet sufficient for safe direct linking

### GE Zoneline VTAC / PTAC
- Asset exists: `GE Zoneline VTAC / PTAC`
- Manufacturer recorded: GE
- Model number: not recorded
- Service guide exists: `GE AZ95E12DACK1 Technical Service Guide`
- Document model pattern: `AZ95%`
- Structured knowledge exists: `ge-zoneline-az95-manual-knowledge-v1`
- Status: **do not directly assign the AZ95 knowledge key until installed model identity is confirmed.**
- A separate GE thermostat wiring diagram is model-generic and may remain available as a document reference where appropriate.

### UniMac dryers
- Assets exist: `UniMac Dryer #1`, `UniMac Dryer #2`
- Manufacturer recorded: UniMac
- Model number: not recorded
- Manual exists: `BoH Dryer UTF75RUF6A2W01`
- Document model pattern: `UTF75RUF6A2W01`
- Structured troubleshooting cache: not yet created for that dryer manual
- Status: **confirm dryer model before linking; then ingest structured troubleshooting knowledge from the verified dryer manual.**

### Generic Commercial Washers #1-3
- Manufacturer/model not recorded.
- Do not assume these are the same UWN065T4V units as the named UniMac washers.

### Generic Commercial Dryers #1-3
- Manufacturer/model not recorded.
- Do not map them to the UniMac UTF75RUF6A2W01 manual without physical/model confirmation.

## Assets currently lacking linked troubleshooting knowledge

The following active equipment families currently have no documentation key on their asset record and require either manual ingestion, identity cleanup, or both:

- Air Compressor 0210371B
- Carrier 48FEEM08 WeatherMaster Rooftop Unit
- Carrier 48TCEA06 Rooftop Unit
- Commercial Dryer #1/#2/#3
- Commercial Washer #1/#2/#3
- DormaKaba Saflok RFID Lock
- Edwards EST3X fire alarm system
- Enseo TV System
- Hayward Commercial Pool Sand Filter & Bromine System
- Maritime Geothermal Nordic PC-55 Pool Conditioner & Heat Pump
- Scotsman Commercial Modular Ice Maker
- UniMac Dryer #1/#2 (manual exists but model verification/structured ingestion remains)
- Verdant Energy Management Thermostat

## Current application-level defect
Even when the correct structured manual knowledge is linked, the Next.js ticket page currently normalizes only `error_codes` and `symptom_rules`. It drops `general_checks` and `manual_tests`.

This means CMPRI currently loses verified information such as:
- GE Service Mode tests and fan resistance checks,
- Navien diagnostic/history procedures,
- UniMac emergency-stop / transformer / control tests,
- other verified model-specific manual procedures.

Fixing that normalization/display gap is higher priority than adding more generic fallback text.

## No-guessing rule
Do not populate a model number, generation, or model-specific documentation key merely because the manufacturer/equipment category looks similar.

Safe linkage requires one of:
- exact model already recorded on the asset,
- exact model verified from equipment label/photo,
- clearly model-independent manufacturer documentation,
- explicit Chief Engineer confirmation.
