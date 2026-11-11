# Asset-manual troubleshooting

The asset's selected PDF is the source for its work orders. The person attaching or selecting the PDF has already chosen the intended document; a second manufacturer/model identity check is not required to use that attachment. Continue to enforce the account, property, asset, and registered-file checks. Never substitute another PDF when the source is missing or ambiguous.

The shared reader works from the reported issue and uses source-backed content across equipment types. It supports explicit numbered symptom sections, diagnostic paragraphs, bounded problem/solution tables, and directly connected labelled chart branches. Keep source conditions, yes/no answers, warnings, model qualifiers, and page references with the checks. Search all readable source pages for possible references, including pages that do not use a troubleshooting heading. Parts diagrams can be shown as references without being represented as repair instructions.

In a work order, the technician may check and uncheck steps and add notes during troubleshooting. A technician's completion is pending red for the Chief and becomes green when reviewed; the technician sees that review. Closing the troubleshooting accordion saves a combined checklist summary to work-order notes. When a different technician opens that accordion, offer continuing the prior checklist or starting a new one while retaining history.

## Current limits

Image-only pages are not automatically OCR'd or searchable. The attached PDF remains available to open. The reader only converts structures and chart connections it can associate with source text; unsupported or ambiguous layouts remain in the original document. Source-page matches are possible references, not a claim that the manual has a matching procedure. These limits mean the current implementation does not guarantee that every future PDF will produce all applicable checks.

Automated checks include `tests/pdf-*.test.mjs`, `tests/work-order-source-pages.test.mjs`, `tests/uploaded-asset-guide.test.mjs`, and `tests/work-order-troubleshooting*.test.mjs`. The browser fixtures `tests/browser/troubleshooting-guide-integrity.py` and `tests/browser/troubleshooting-chart-layout.py` use fictional records and can be run against a local fixture-configured server.
