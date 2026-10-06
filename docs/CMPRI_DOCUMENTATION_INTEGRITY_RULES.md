# CMPRI Documentation Integrity Rules
Date: 2026-09-16

CMPRI must not treat a file as verified manufacturer guidance merely because its filename, Drive index row, or database metadata says it belongs to an asset.

## Verification chain
Before a document can supply verified troubleshooting, all applicable identities must agree:

1. **Asset identity**
   - manufacturer
   - equipment type
   - model/model family when the document is model-specific

2. **CMPRI document index metadata**
   - title
   - manufacturer
   - equipment
   - model pattern
   - document type

3. **Actual document content**
   - cover/title text
   - manufacturer named in the document
   - equipment family named in the document
   - listed applicable models

4. **Structured troubleshooting**
   - extract it from the verified PDF itself,
   - retain the source PDF and page references,
   - refresh the stored structure when the source PDF or equipment identity changes.
   - A pre-existing cache entry is not required.

5. **Verification state**
   - verification must be explicit after the identities above are checked.

If these disagree, CMPRI must fail closed: the file may remain visible as an uploaded/reference document, but its extracted procedures must not be presented as verified troubleshooting.

## Defect found: UniMac dryer document
CMPRI's Drive/index contains files titled:

`BoH Dryer UTF75RUF6A2W01.pdf`

and the technical-document index describes that entry as:

- Alliance / UniMac Commercial Dryer
- Service & Parts Manual
- model `UTF75RUF6A2W01` (75 lb)

However, multiple duplicate Drive files carrying that dryer filename were inspected and their actual content begins as:

- Alliance Laundry Systems
- **Washer-Extractor**
- **Pocket Hardmount**
- Parts manual `F8453401`
- applicable washer models including NWL/UWH/UWL/UWN/UWU families

Therefore:

- The indexed dryer file is mislabeled or points to incorrect content.
- It must **not** be used to create a dryer troubleshooting cache.
- It must **not** be linked as verified guidance to the live UniMac dryer assets.
- The correct UTF75RUF6A2W01 dryer manual must be obtained/identified before structured dryer troubleshooting is built from that document.

## Scotsman C0330 status
CMPRI historical work-order/specification data identifies the ice machine as a Scotsman Prodigy C0330 / Prodigy Plus family.

Scotsman's OEM service-manual catalog independently lists C0330 in the Prodigy Series Modular Cuber Technical Service Manual, including Prodigy Plus.

This is useful model-family corroboration, but structured CMPRI troubleshooting should still be built from a readable, traceable OEM source and retain its source reference.

## Required system behavior
### Upload / document association
When a PDF is uploaded to an asset:
- populate candidate manufacturer/model/document fields from the PDF only as **unverified extracted metadata**,
- compare extracted identity to the selected asset,
- surface mismatches to Engineering,
- require explicit verification before extracted service procedures become trusted.

### Existing indexed documents
A document verifier should detect at least:
- filename says Dryer but content says Washer,
- indexed manufacturer differs from document manufacturer,
- indexed model pattern is absent from the document's applicable-model list,
- troubleshooting cache source title differs materially from the indexed document,
- one Drive file reused under conflicting equipment identities.

### Fail-closed rule
On mismatch:
- do not silently select the document,
- do not mark it verified,
- do not use its codes/specifications in the troubleshooting panel,
- do not generate or show generic troubleshooting or substitute an unrelated manual,
- display an Engineering-only documentation mismatch notice.

### Exact-match refresh
- A verified PDF is eligible only when its text contains the equipment's exact manufacturer and either its exact model family or exact model number.
- On an exact match, automatically extract/update structured troubleshooting from that PDF; the PDF remains the sole source of truth.
- Do not use an existing troubleshooting-cache entry to establish a match. Cache entries may only store a structure generated from the currently matched verified PDF.
- When no verified PDF matches exactly, show no documentation or troubleshooting guidance for that equipment.

## Go-live acceptance additions
- A deliberately mislabeled PDF must be rejected as verified guidance.
- Model-specific troubleshooting must not activate for an asset with an unknown model unless the document explicitly covers the broader verified family.
- Duplicate Drive files with the same title must not be assumed identical or correct based on title alone.
- A document title/index row alone is never sufficient evidence of equipment identity.
- Friedrich Verdepac documentation must match Friedrich + Verdepac VTAC; it must not match another Friedrich family.
- Adding or updating a verified exact-match PDF must create or refresh its structured troubleshooting without requiring a prior cache entry.
- If no verified exact-match PDF exists, no generic troubleshooting or unrelated documentation is shown.
