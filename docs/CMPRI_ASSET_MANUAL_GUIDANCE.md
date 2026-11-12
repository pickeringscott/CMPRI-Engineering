# Asset-manual troubleshooting

The asset's selected PDF is the source for its work orders. The person attaching or selecting the PDF has already chosen the intended document; a second manufacturer/model identity check is not required to use that attachment. Continue to enforce the account, property, asset, and registered-file checks. Never substitute another PDF when the source is missing or ambiguous.

The shared reader works from the reported issue and uses source-backed content across equipment types. It supports explicit numbered symptom sections, diagnostic paragraphs, and bounded problem/cause/solution and fault-code tables. Partial chart branches remain references to the complete original page; they do not become isolated checkboxes. Keep source conditions, yes/no answers, warnings, model qualifiers, and page references with the source. Search all readable source pages for possible references, including pages that do not use a troubleshooting heading. Parts diagrams can be shown as references without being represented as repair instructions.

The reader also considers saved technician notes and Actions Taken / Root Cause when filtering completed checks or explicitly ruled-out codes. Automatic checklist summaries are excluded from that context. Repeated identical checks within one manual share their page citations; identical wording from different manuals retains separate provenance. Fault meanings and automatic unit responses are reference information, not completed technician actions. Explicit named procedures are expanded only when one complete numbered source procedure can be located.

Source-page ranking keeps the reported issue ahead of technician history. Issue-matching troubleshooting/diagnostic pages precede general references; technician findings break ties and can add references. Known import provenance and encoded change/system events do not become technician findings. The original note records remain intact.

In a work order, the technician may check and uncheck steps and add notes during troubleshooting. A technician's completion is pending red for the Chief and becomes green when reviewed; the technician sees that review. Closing the troubleshooting accordion saves a combined checklist summary to work-order notes. When a different technician opens that accordion, offer continuing the prior checklist or starting a new one while retaining history.

## Current limits

An image-only PDF is queued for OCR using CMPRI's installed Tesseract engine and English language data. Recognition runs on the server in batches of up to five pages; the source remains available while processing. The queued result is scoped to the asset and PDF fingerprint, and the original source is rechecked before recognized pages are saved. OCR-derived checks are labelled `OCR` and link to the original page because recognition can misread text. Jobs require the OCR migration, the scheduled dispatch route, and the existing `CRON_SECRET` configuration.

Image-only, sparse image/text, and damaged-character pages inside otherwise searchable PDFs are identified for recognition or review. Blank pages without images do not consume OCR. The reader reports coverage per manual and keeps physical PDF page positions separate from printed page labels. Reviewed text replaces its matching source page even when another attachment becomes preferred. Original PDFs are never rewritten or split to satisfy the reader.

Native indexing uses internal 25-page batches, a 10,000-page ceiling, and a 20-million-character text budget. Completed native batches can resume through fingerprinted derivatives in the existing cache; association and authorization are still rechecked. The existing OCR and reviewed-text workflows retain their 600-page limit. No schema migration is included. Unsupported or ambiguous layouts remain in the original document; no reader can guarantee that every future PDF will produce all applicable checks. Source-page matches are possible references, not a diagnosis.

Source controls request a fresh short-lived private URL when opened. The server rechecks the account, property, asset, registered-file association, quarantine acknowledgment, and original fingerprint. Source links in a long-lived guide no longer depend on the URL created when the guide first loaded.

Source controls are scoped to the selected document and account. A document switch hides the prior iframe immediately, pending opens are cancelled when the control changes or unmounts, and sign-out clears the embedded source. Completed standalone PDF windows stay open when the guide closes. Closing/reopening renews access and clears an earlier retryable error.

Pages explicitly labelled as troubleshooting/diagnostic/fault/flow charts show the original page image first. Their extracted text is collapsed separately because it cannot retain the chart's branch connections. The complete original remains available through the PDF link, including when the image preview is unavailable.

The displayed page uses native neutral surface/ink colors when safe. Full vector pages are identified from the PDF operators so antialiased text does not incorrectly disable native coloring. Colored source content and photographs retain their protection; the original PDF is never recolored or rewritten. Text spacing is compact throughout the troubleshooting guide only.

Acceptance uses authorized Supabase snapshots and unchanged original PDFs. Run `CMPRI_MANUAL_SNAPSHOT_DIR=/private/snapshot npm run test:manual-collection`; the command refuses to substitute fictional records when the private inputs are unavailable. Never commit private records, signed URLs, or manual originals. Existing synthetic unit/browser fixtures remain regression checks and are not evidence that a live manual works.

`CMPRI_MANUAL_SNAPSHOT_DIR=/private/snapshot npm run test:manual-source-controls` exercises document/account changes, renewal, retries, popup blocking and pending-window cancellation using the actual manual/account snapshots and recorded source URLs. It does not send requests or establish live authentication.

Vercel previews of this implementation are read-only (`VERCEL_ENV=preview`, or `CMPRI_MANUAL_PREVIEW_READ_ONLY=1` locally). API mutations, live database writes, OCR enqueueing, derivative-cache writes, and work-order view writes are disabled. Authenticated reads and fresh source signing remain available. Preview testing cannot establish production save/review/note persistence. See [implementation and PR #20 comparison](CMPRI_MANUAL_READER_PREVIEW_2026-11-12.md).
