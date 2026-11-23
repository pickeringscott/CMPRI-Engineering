import "server-only";
import { NextResponse } from "next/server";

const STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function privateJson(response: Response) {
  response.headers.set("Content-Type", "application/json; charset=utf-8");
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.delete("Content-Length");
  return response;
}

/** Preserve the JSON contract while keeping large originals outside Vercel's buffered response limit. */
export function askJsonResponse(body: unknown, init?: ResponseInit): Response {
  let serialized = JSON.stringify(body);
  if (serialized === undefined) throw new TypeError("The Ask response is not JSON serializable.");
  if (Buffer.byteLength(serialized, "utf8") <= STREAM_THRESHOLD_BYTES) {
    // Serialize caller-owned data once; getters/toJSON cannot change the result
    // between the byte-size check and NextResponse's normal JSON serialization.
    return privateJson(NextResponse.json(JSON.parse(serialized), init));
  }
  const encoder = new TextEncoder();
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = new Uint8Array(CHUNK_BYTES);
      // encodeInto never emits a partial UTF-8 code point; read counts UTF-16
      // source units, so even a surrogate pair at the boundary stays intact.
      const { read, written } = encoder.encodeInto(serialized.slice(offset), chunk);
      offset += read;
      controller.enqueue(written === chunk.byteLength ? chunk : chunk.subarray(0, written));
      if (offset === serialized.length) {
        serialized = "";
        controller.close();
      }
    },
    cancel() { serialized = ""; },
  }, { highWaterMark: 0 });
  return privateJson(new Response(stream, init));
}
