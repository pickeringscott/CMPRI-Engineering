# On-device OCR integration

CMPRI's reusable OCR reads a selected image or PDF **in the browser**. It produces editable, unverified text and does not itself save, submit, approve, or import a record. Recognition can misread characters, omit entire rows, or fail to interpret tables, checkboxes, handwriting, and low-quality scans. A user must compare the result with the original; confidence values do not prove completeness or accuracy.

## Reuse the review component

For a client-side screen, render `LocalOcrReview` from `@/components/LocalOcrReview`. Without a callback it is a reference and copy tool. To offer reviewed text to a screen's existing editor, provide `onUseText` and, optionally, `useTextLabel`:

```tsx
<LocalOcrReview
  useTextLabel="Use reviewed text in editor"
  onUseText={({ fileName, pages }) => {
    setReference({ fileName, pages });
  }}
/>
```

The callback receives `{ fileName, pages: [{ page, text }] }` only after the user checks the comparison acknowledgement. Editing extracted text resets that acknowledgement. The callback is not permission to save a record: use it to populate a visible, editable field or a clearly marked reference, and keep the screen's normal validation, authorization, confirmation, and save workflow. On sign-out, account change, or unmount, the component cancels pending recognition and clears its local selection.

The Room Operations reader is **reference-only**. It does not turn recognized text into an import. Staff must prepare a supported CSV and use the existing validation, preview, and confirmation flow. In purchasing, OCR does not establish purchase-order acceptance, quantities, receipts, or inventory. Preventive-maintenance and equipment integrations likewise require normal human review and their existing save or verification steps.

## Use the engine directly

The browser-only `recognizeLocalDocument(file, options)` export in `@/lib/ocr/local-ocr` returns `{ fileName, pages, totalPages }`. Each page has its source page number, extracted `text`, overall `confidence`, and `words` containing text, confidence, and bounding boxes. The optional `onProgress` callback receives status, progress, source page, and document page count. Pass an `AbortSignal` to cancel; always handle an `AbortError` and other initialization, file, or recognition errors. Use an `AbortController` and cancel when the user stops, changes document or account, or leaves the screen.

File selection accepts nonempty, signature-validated PNG, JPEG, WebP, and PDF files without an application byte-size or document-page-count cap. The OCR engine decodes an image once at a working resolution no larger than 6,000 pixels per dimension and 20 megapixels, retaining the original only for local comparison. Large originals are not eagerly displayed in the review component. PDF pages are rendered and recognized sequentially at a bounded resolution, with at most 10 pages per batch. By default, the first batch is read; pass a 1-based `pageRange: { start, end }` to select another batch, or use the review component's next-batch action. `maxPages` can reduce the per-batch bound. Results retain the source page numbers and document page count. Copy or use reviewed text before advancing, because a new batch replaces the current text and requires a new review acknowledgement.

A supported file can still exceed a particular device's memory or decoder capacity. PDF bytes are read inside the engine when recognition starts; PDF parsing still requires memory for the document, even though only the selected pages are rendered. Byte-read, decode, or render failures remain visible and do not save records. PDFs are rendered locally for recognition; the review component does not embed PDFs in an iframe and asks users to compare them in a trusted PDF viewer.

## Privacy and assets

The engine reads the selected file locally and does not submit its contents to OpenAI or another OCR service. It fetches the OCR worker, WebAssembly runtime, English language model, and PDF worker from **versioned same-origin application paths**. There is no configured CDN fallback; a missing model or worker must produce an error rather than send the document elsewhere. The public model can be cached in the browser and versioned static assets receive immutable cache headers to reduce repeat requests. OCR is not guaranteed to work offline: assets may need to be loaded from the application first, and browser storage may be unavailable or evicted.

The extracted text becomes data in the relevant workflow if the user copies it or chooses to use and save it. That later action follows the destination's normal data handling and permissions. The optional ChatGPT connection remains a separate, user-authorized integration; supplying text or images to it can send that information to ChatGPT.

Pinned OCR dependencies are installed with the project's normal dependency installation. `npm run build:local-ocr` copies the selected worker, runtime variants, model, PDF worker, and license notices into generated `public/local-ocr/` assets; `predev` and `prebuild` run this script automatically. Do not commit the generated files or replace them with external CDN URLs. The build script checks exact package versions. When changing a runtime, model, PDF worker, or custom bootstrap, update the versioned asset path consistently in the build script, engine, and `next.config.ts` cache headers, then verify notices and browser behavior.

## Checks for future integrations

- Run `node tests/local-ocr.test.mjs` and the tests for the target screen and its domain adapter.
- Run `tests/browser/local_ocr_privacy.py` against a local fixture server with synthetic data and the required browser tooling. It blocks non-local requests, exercises PNG and PDF recognition, checks missing worker/model failures, and verifies that image-extraction server routes are not called.
- Add domain-specific tests for missing or ambiguous fields, omitted rows, user correction, save authorization, cancellation, and conflict or failed-save behavior. Do not infer that a passing synthetic fixture establishes accuracy on all real reports.
- Confirm OCR does not trigger automatic imports, purchases, approvals, checklist completion, or other actions without the existing explicit workflow and review.
