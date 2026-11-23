import "server-only";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { inspectManualPdf } from "@/lib/manual-pdf-knowledge";

const LIMIT = 100 * 1024 * 1024;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function filename(disposition: string | null): string | undefined {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;\r\n]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return disposition?.match(/filename="([^"\r\n]+)"|filename=([^;\r\n]+)/i)?.slice(1).find(Boolean)?.trim();
}

function checkedName(value: string | undefined | null): string {
  if (!value || value.length > 180 || !/\.pdf$/i.test(value) || /[\\/\x00-\x1f\x7f]/.test(value)) {
    throw new Error("The original resume filename could not be verified.");
  }
  return value;
}

function privateLocation(value: string | null, applicationId: string) {
  const configured = new URL(SUPABASE_URL);
  const url = new URL(value || "");
  const path = decodeURIComponent(url.pathname);
  const prefix = `/storage/v1/object/sign/employment-resumes/${applicationId}/`;
  const key = path.slice(prefix.length);
  if (configured.protocol !== "https:" || url.protocol !== "https:" || url.origin !== configured.origin
    || url.username || url.password || url.hash || !path.startsWith(prefix)
    || !key || /[\\/\x00-\x1f\x7f]/.test(key) || !/\.pdf$/i.test(key) || !url.searchParams.get("token")) {
    throw new Error("The native resume download address could not be verified.");
  }
  return { url, expectedHash: /^([a-f0-9]{64})\.pdf$/i.exec(key)?.[1]?.toLowerCase() };
}

async function originalBytes(response: Response, signal: AbortSignal) {
  if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
    throw new Error("The native resume source did not return a PDF.");
  }
  const rawSize = response.headers.get("content-length");
  const expectedSize = rawSize === null ? null : Number(rawSize);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 5 || expectedSize > LIMIT)) {
    await response.body?.cancel();
    throw new Error("The native resume exceeds its file limit or has an invalid size.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The native resume is empty.");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) throw new Error("The native resume exceeds its file limit.");
      parts.push(value);
    }
    signal.throwIfAborted();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(parts, size);
  if (size < 5 || expectedSize !== null && size !== expectedSize || bytes.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("The original resume bytes could not be verified.");
  }
  return bytes;
}

/** Native application/department access is checked before any private file is retrieved. */
export async function readAskCandidateResume(request: NextRequest): Promise<Response> {
  const entries = [...request.nextUrl.searchParams];
  const applicationId = request.nextUrl.searchParams.get("id");
  if (!applicationId || !UUID.test(applicationId) || entries.length !== 1 || entries[0][0] !== "id") {
    return NextResponse.json({ error: "Choose an exact candidate application." }, { status: 400, headers: HEADERS });
  }
  const { GET } = await import("@/app/api/employment/resume/route");
  const authorization = request.headers.get("authorization");
  const url = new URL("/api/employment/resume", request.url);
  url.searchParams.set("id", applicationId);
  const native = await GET(new NextRequest(url, { headers: authorization ? { authorization } : {}, signal: request.signal }));
  if (!native.ok && native.status !== 303) return native;
  try {
    request.signal.throwIfAborted();
    let source = native;
    let expectedHash: string | undefined;
    let name: string | undefined | null;
    if (native.status === 303) {
      const location = privateLocation(native.headers.get("location"), applicationId);
      expectedHash = location.expectedHash;
      name = location.url.searchParams.get("download");
      source = await fetch(location.url, {
        headers: { Accept: "application/pdf" }, credentials: "omit", referrerPolicy: "no-referrer",
        redirect: "error", cache: "no-store", signal: request.signal,
      });
    }
    const fileName = checkedName(name || filename(source.headers.get("content-disposition")));
    const bytes = await originalBytes(source, request.signal);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expectedHash && expectedHash !== sha256) throw new Error("The stored resume differs from its original fingerprint.");
    const inspected = await inspectManualPdf(new Uint8Array(bytes), { includeEmptyPages: true });
    request.signal.throwIfAborted();
    const needsOcr = inspected.pages.filter(page => page.needs_ocr).map(page => page.page);
    const id = `candidate-resume:${applicationId}:${sha256}`;
    return NextResponse.json({
      applicationId,
      file: { id, name: fileName, mimeType: "application/pdf", size: bytes.length, sha256 },
      inspection: { text: inspected.text, pages: inspected.pages, totalPages: inspected.total_pages,
        needsOcr, warnings: inspected.warnings,
        complete: inspected.pages.length === inspected.total_pages && !needsOcr.length && !inspected.warnings.length },
      instruction: "This is the actual authorized candidate resume, not a filename or excerpt. Read all relevant source pages; incomplete or unreadable pages are not evidence of absent qualifications. The original PDF is available for download.",
      // The dispatcher extracts this exact operation's transport before constructing model context.
      originalDownload: { id, name: fileName, mimeType: "application/pdf", content: bytes.toString("base64"), encoding: "base64" },
    }, { headers: HEADERS });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return NextResponse.json({ error: "The original candidate resume could not be verified or inspected. Open the native candidate record to retry." }, { status: 503, headers: HEADERS });
  }
}
