# CMPRI troubleshooting guide audit

Date: November 12, 2026
Code reviewed: [main at 12c7a9e](https://github.com/pickeringscott/CMPRI-Engineering/tree/12c7a9e481dd83511a9b1becc0c02bdb92031d10)

CMPRI can read the existing manuals, but its structured guide captures only part of their troubleshooting content. The largest gaps are fault-code tables, preservation of cause columns, and recognition of pages with unusable text. New assets and manuals should use a common ingestion process that preserves the original files and their source conditions.

This PR adds this audit report only. Application code, tests, schema, asset associations, source PDFs, and production records are unchanged. The PR is for review and must remain unmerged. Recommendations below require a separate implementation decision. No AI service or model API was called.

## Evidence from the existing Supabase records

Read-only snapshots covered the current asset links, registered files, catalog processing states, reviewed-page records, OCR jobs, and 21 existing work orders associated with these assets. The original PDFs were downloaded through authorized signed storage links and analyzed locally, without editing their bytes. Signed links, credentials, customer details, and raw database snapshots are excluded from this PR.

- 26 active assets had document links. The snapshot contained 32 links: 20 confirmed-model links and 12 reference links, including a verification marker and links without a storage path.
- Those links identified 13 distinct PDF storage paths. Twelve original PDFs were readable, totaling 656 pages. The remaining linked Saflok PDF was empty.
- Eighteen assets had eligible PDFs in the local snapshot analysis.
- Four of the 21 existing work orders produced checklist steps; 19 produced matching source-page references. These counts describe the sampled records, not a universal success rate. A source-page reference is not an extracted procedure.
- The active catalog contained 17 complete and 5 pending entries. Catalog completion alone does not establish a selected asset association or usable guide.
- The snapshot contained no saved human-reviewed page records and no OCR jobs.

The local analysis ran the production PDF extraction, semantic parsing, coordinate-based parsing, applicability checks, source-page search, and checklist derivation against these actual records and manuals. It did not invoke production guide endpoints that can enqueue processing.

| Original PDF | Pages | Extracted symptom rules | Structured fault codes |
| --- | ---: | ---: | ---: |
| Parts Manual Unimac UWN065T4V | 70 | 0 | 0 |
| Programming Guide Unimac UWN065T4V | 82 | 0 | 0 |
| Enseo TV Troubleshooting Guide | 2 | 4 | 0 |
| Friedrich Service and Parts Manual | 66 | 4 | 0 |
| GE AZ95E12DACK1 Technical Service Guide | 68 | 8 | 0 |
| Lennox 507198-09a | 43 | 0 | 0 |
| Lennox EHB KGC CBOX 2308 | 42 | 0 | 0 |
| Lennox 100070 | 86 | 0 | 0 |
| Navien NPE Service Manual 2015 09 01 | 171 | 4 | 0 |
| Navien NPE Parts List | 14 | 0 | 0 |
| CMPRI Brand Sign LED Letter Installation Instructions | 8 | 0 | 0 |
| Shower Valve Temptrol Parts Diagram | 4 | 5 | 0 |

Counts are parser output, not a judgment that a manual ought to contain repair instructions. Installation manuals and parts lists remain useful references. Several rules contain multiple checks or chart branches.

## Findings and differences from the intended behavior

### High priority fault-code tables do not reach the structured guide

The original Friedrich PDF contains its Error Codes and Alarm Status table on PDF page 21, including codes 3, 5, and 15. GE contains its Fault Codes table on PDF page 64. Navien contains its Error Code List on PDF pages 74 through 76. The current reader produced zero structured error-code entries from all three originals.

The text parser recognizes narrow code headings and pipe-separated table rows; the coordinate parser returns symptom rules rather than structured error-code rows. Native PDF text does not reliably become either expected format. Friedrich and GE also describe automatic unit responses, which should not be discarded because they are not imperative repair actions.

Code: [uploaded-manual-actions.ts lines 63 through 94](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/uploaded-manual-actions.ts#L63), [pdf-troubleshooting-tables.ts](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/pdf-troubleshooting-tables.ts#L12).

Suggested improvement: support code, subcode, meaning, operating response, and corrective-action columns in the common layout reader. Keep the original page and qualifiers with each entry, and allow absent action fields. This should support new manuals without adding manufacturer-specific code meanings.

### High priority table causes are dropped and symptom matching can become too broad

The actual Symmons PDF page 4 has PROBLEM, CAUSE, and SOLUTION columns. For a valve leaking when shut off, the cause describes worn washers or foreign matter between washers and seats. The extracted checklist text omits that cause and combines the replacement instructions.

An existing work order reporting “Showerhead leaking” matched this valve-shutoff row through the generated “leaking” alias. The output retained the row's problem label, but the reported issue did not establish that the valve leaks when shut off.

The unbordered table path detects the cause column to calculate boundaries, then collects only symptom and action text. It also adds broad symptom aliases.

Code: [pdf-troubleshooting-tables.ts lines 37 through 61](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/pdf-troubleshooting-tables.ts#L37).

Suggested improvement: preserve all source columns and row boundaries, retain cause-to-remedy relationships, and distinguish a possible reference from a procedure whose conditions have been established. CMPRI should not decide the diagnosis from a shared word.

### Medium priority OCR eligibility misses unusable text and image content on searchable pages

The reader queues OCR only for pages whose extracted text is empty. Nonempty headers, footers, or damaged font mappings prevent that path.

This matters in the existing originals. Friedrich PDF page 40 contains a thermistor-resistance table whose native extraction includes damaged character mappings. Navien PDF page 57 contains an illustrated Electrical Diagnostic Points page with only 73 native text characters. Some Lennox wiring pages likewise expose a title but little searchable diagram content.

The original brand-sign manual has eight image-only pages. Local Tesseract recognition of its actual page 2 returned 94 confidence and 2,391 characters with outbound fetch disabled. Recognition of the actual Friedrich resistance-table page returned 68 confidence and visibly unreliable numeric text. OCR availability therefore does not make extracted measurements trustworthy.

Code: [uploaded-asset-guide.ts lines 199 through 226](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/uploaded-asset-guide.ts#L199), [manual-ocr-actions.ts](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/manual-ocr-actions.ts#L9).

Suggested improvement: assess text quality and image coverage per page, schedule local OCR for unreadable regions, and expose incomplete indexing. Keep uncertain measurements as original-page references until reviewed. Preserve the PDF unchanged and use no AI service calls.

### Medium priority existing source availability and selections limit several guides

The registered Saflok installation PDF returned zero bytes. Supabase storage metadata independently reported size and content length of zero. It cannot supply guidance in its present stored state; recovering its original source is a document-availability task.

The existing Navien exhaust-error work order is linked to an asset whose service-manual association is marked reference. That association is excluded by current applicability rules. Seven other Navien assets select a parts list, which produced no troubleshooting rules. The Lennox RTU's three linked manuals are also marked reference.

These are the recorded choices, not instructions to change them. The user must decide which manuals apply to each physical asset. CMPRI should clearly show whether a guide is absent because the source is empty, the association is reference-only, processing is pending, or the readable content has no supported extracted procedure.

Code: [manual-applicability.ts lines 61 onward](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/manual-applicability.ts#L61), [uploaded-asset-guide.ts lines 113 through 151](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/uploaded-asset-guide.ts#L113).

### Medium priority reviewed text still assumes one selected manual

The main reader combines multiple eligible manuals, as required for an asset with parts, programming, installation, and service documents. However, reviewed-text storage and retrieval still call a chooser that requires a preferred PDF or exactly one attachment. With multiple attachments and no preferred PDF, retrieval catches the chooser error and returns an empty reviewed-page list.

The cache identity also includes the preferred flag. Changing that flag can make corrections unavailable even when the document bytes have not changed. The main reader then permits native extraction again.

This is a code-inspection finding affecting future reviewed-text use; the actual snapshot had no reviewed-page records, so this is not a claim that existing corrections were lost.

Code: [reviewed-manual-text.ts lines 23 through 33](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/reviewed-manual-text.ts#L23), [lines 71 through 79](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/reviewed-manual-text.ts#L71).

Suggested improvement: address reviewed pages by the selected registered document, asset, PDF fingerprint, and page. Presentation preference and another attachment should not silently discard corrections. Recheck authorization and source changes independently.

## Improvements for future manuals and changing assets

1. Preserve one original file and process it in resumable page batches. Current readers reject more than 600 pages or more than two million extracted characters and tell the operator to split the document. CMPRI should partition its processing internally, retaining the original file, original page numbers, and document fingerprint.
2. Store reusable derivatives by PDF fingerprint and parser version, with asset authorization checked separately. Current warm-instance derivatives last five minutes; each guide request still downloads and hashes every eligible PDF. OCR recognizes all pages in five-page batches and hides results until the job completes. Persisting page progress and processing only necessary pages would scale better as the collection grows.
3. Track coverage explicitly: pages indexed, pages needing OCR or review, supported tables, unresolved chart branches, and source warnings. A verified association should not imply complete extraction.
4. Keep source scope and operating conditions in a common representation for tables, charts, codes, and procedures. The same representation should support any manufacturer. Asset changes should surface source-review information for the user to decide, without rewriting a manual or inventing compatibility.
5. Use authorized snapshots of the actual manuals and work-order language for regression coverage. Existing records demonstrate a meaningful difference between “AC not cooling” and “HVAC cooling issue; portable A/C deployed”: the latter produced references but no checks on the sampled GE and Friedrich assets. Improve discovery while preserving distinctions between an explicit failure, a conditional manual procedure, and a diagnosis.
6. Preserve immutable source references for every check and correction. Keep unsupported layouts available as complete original pages rather than claiming every future PDF can be fully converted.

## Documentation review

There is no repository-root troubleshooting README. The relevant current documentation is [CMPRI_ASSET_MANUAL_GUIDANCE.md](CMPRI_ASSET_MANUAL_GUIDANCE.md), alongside [CMPRI_REFINED_TROUBLESHOOTING_GUIDE.md](CMPRI_REFINED_TROUBLESHOOTING_GUIDE.md), the integrity rules, coverage audit, and acceptance matrix.

The refined guide already labels its older automatic manufacturer/model matching rules as historical and points to the asset-selection guidance. Keep that distinction clear in the remaining documents:

- The integrity rules still describe automatic exact matching and catalog gates without the same historical notice.
- The coverage audit says normalization drops general checks and manual tests; the current normalizer retains both fields. That old diagnosis should not be treated as the present defect.
- The current asset guidance should explain that the reader now detects empty pages in mixed PDFs, while sparse or damaged nonempty text can still miss OCR.
- The acceptance matrix reuses T40 for separate cases. Assign stable unique IDs.
- Document the actual original-PDF limits, multiple-manual reviewed-text behavior, and the difference between association verification and extraction coverage.

These are proposed documentation corrections; the existing guide documents are unchanged in this PR.

## Why the preloaded checkout was 37 commits behind

The local work branch reflog showed its last reset to commit 1f35ee7 on November 10 at 11:42 AM Central. The work branch had no configured upstream. Its local origin/main reference was older still, last refreshed on October 11.

A fresh fetch on November 12 found current main at 12c7a9e. Git reported work...origin/main as zero commits unique to work and 37 unique to main. This establishes a stale preloaded workspace and outdated local refs, with no local divergence or evidence of lost GitHub commits. It does not establish which environment snapshot-refresh mechanism caused the stale preload.

The audit used a separate worktree at the fetched main commit. GitHub main was rechecked and still matched that commit before preparing this report.

## Existing regression checks

An earlier run of the repository's existing guide-related checks returned 389 passing, 9 failing, and 8 skipped tests. The nine failures were all in shared-manual-upload.test.mjs: five still expected the old pending-identity behavior, and four could not load the newly imported manual-applicability dependency in their test harness. That file is also absent from the default npm test list.

The existing browser integrity check stopped at an expectation of zero page-specific source links; the current source-page viewer renders one. These fixture checks need maintenance and do not serve as acceptance evidence for the actual manuals audited above. They were left unchanged.

## Second pass findings

A second pass on November 12 rechecked the same main commit, read the existing work orders with their technician notes and Actions Taken / Root Cause fields, and reran extraction on the unchanged Friedrich and imported Enseo PDFs. Source fingerprints were checked before parsing, and outbound fetch was disabled during local checks. These findings extend the first pass.

The owner-authored Front Desk Quick Guides serve front desk associates and have a separate audience from maintenance troubleshooting. Their separation is intentional. The Enseo finding below concerns the reader's extraction of the PDF attached to an asset.

### High priority chart prerequisites are missing from the generated checks

The actual Friedrich cooling charts on PDF pages 41 and 42 include instructions to check the fuses or breakers and 208/230 supply, and to set the thermostat to Cool below room temperature. Fresh extraction produced 22 labels from each chart, including diagnostic branches, but none contained either the fuse prerequisite or the thermostat-setting instruction.

The chart branch reader records directly connected Yes/No edges. Its companion prerequisite reader recognizes a narrow “Before continuing” pattern ending in a page reference. Other starting instructions and connections labelled “O.K.” do not become prerequisite checks. Retaining a branch's immediate question does not preserve the earlier steps that lead to it.

Code: [pdf-flowchart-branches.ts lines 74 through 87](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/pdf-flowchart-branches.ts#L74), [pdf-flowchart-notes.ts lines 8 through 30](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/pdf-flowchart-notes.ts#L8).

Suggested improvement: preserve chart entry instructions and dependencies with the branches that rely on them. Where connections cannot be resolved reliably, present the original chart as the procedure rather than a checklist that omits its starting conditions. Apply this in the common reader for future manuals.

### Medium priority technician findings do not participate in guide selection

The active maintenance guide builds its diagnostic text from issue and reporter_notes. The shared checklist derivation accepts those fields and the asset, but does not read notes or action_root_cause. The existing completion-filter helper is used by retained generic helpers that the active guide does not invoke.

A fresh read found 19 source-eligible existing work orders with technician notes; one also had Actions Taken / Root Cause text. Passing the complete actual records to checklist derivation produced the same steps and context identities as passing only issue and reporter notes. An active record already documents a breaker reset and a replacement thermostat, but those observations are outside the guide's input.

This establishes that the context is ignored. It does not establish that every generated step repeats completed work.

Code: [work-order page lines 1347 through 1358](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/app/work-orders/%5Bid%5D/page.tsx#L1347), [troubleshooting-checklist.ts lines 53 through 63](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/work-orders/troubleshooting-checklist.ts#L53).

Suggested improvement: include explicit technician observations and Actions Taken / Root Cause in relevance and completion handling. Preserve uncertainty in imported history, distinguish completed work from planned work, and retain manual-required rechecks. The system should not invent a completion or diagnosis from an ambiguous note.

### Medium priority references to another procedure remain incomplete

The original imported Enseo PDF contains its four Quick Reset Steps, including a 30-second wait after unplugging and a full seven-minute reboot wait. Its Grey Screen scenario explicitly says to perform a Power Cycle.

Fresh extraction produced four symptom rules with nine checklist labels. One label says “Perform a Power Cycle,” but none includes either wait. The named reset procedure is outside the symptom/scenario structures that become checks, and the reader does not resolve that dependency.

The complete source page remains available, so the PDF itself has not lost content. The generated checklist can still omit essential details of an instruction it presents.

Code: [uploaded-manual-actions.ts lines 152 onward](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/uploaded-manual-actions.ts#L152), [uploaded-asset-guide.ts lines 219 through 231](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/uploaded-asset-guide.ts#L219).

Suggested improvement: retain explicit dependencies on named procedures. When the source target is unambiguous, show that procedure verbatim with its timing and page reference. Otherwise, clearly direct the reader to the complete source procedure. The original authored instructions already contain the needed details.

### Additional source-navigation considerations

- **Printed pages and PDF positions differ.** The Friedrich charts refer to printed page 16 for control diagnostics; that table is at physical PDF page 21. The PDF has no page-label metadata. CMPRI's source links use physical positions, while verbatim instructions retain printed numbers. Show both when known and preserve the distinction as new manuals arrive. No generated link to the wrong page was demonstrated.
- **Open source links can outlive their authorization URL.** The reader signs PDF links for 3,600 seconds. Source links and checklist iframes use that saved URL, while guide reloads depend on reference and visibility events rather than an expiry timer. A continuously open view without a refresh event can retain an expired link. Refresh authorization on opening a source document. This is a code-inspection risk; the audit did not wait an hour or report a reproduced production expiry failure.

Code: [uploaded-asset-guide.ts line 255](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/lib/server/uploaded-asset-guide.ts#L255), [WorkOrderSourcePages.tsx line 64](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/components/WorkOrderSourcePages.tsx#L64), [work-order page lines 1334 through 1345](https://github.com/pickeringscott/CMPRI-Engineering/blob/12c7a9e481dd83511a9b1becc0c02bdb92031d10/src/app/work-orders/%5Bid%5D/page.tsx#L1334).

### Second pass verification boundaries

The live schema has the OCR-job trigger that emits reference signals, so the refresh mechanism exists. The read-only check found no OCR jobs and no saved troubleshooting ledger contexts; this audit therefore does not claim a production completion/review or OCR-job lifecycle test.

The new findings rely on actual stored documents, actual work-order fields, and inspected production code. No fictional asset, work-order, or completion records were introduced. Recommendations concern CMPRI's reader and workflow; original manuals and owner-authored front desk guides remain unchanged.

## Review boundaries

Actual Supabase records and original manuals support the findings above. Local PDF.js parsing and Tesseract recognition made no AI API calls. No production guide request was used to enqueue OCR, and no Supabase write was performed.

The local replay verified extraction and selection behavior. It is not a claim that every catalog entry, production UI interaction, or future manual layout has passed end-to-end acceptance. A separate implementation PR can address the chosen findings and validate them against the same unchanged originals.
