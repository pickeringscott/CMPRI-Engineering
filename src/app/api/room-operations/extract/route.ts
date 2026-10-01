import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/server/auth";

export const maxDuration = 60; // Allow up to 60 seconds for AI vision extraction

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "edit_tickets");
  if (!auth) {
    return NextResponse.json({ error: "Engineering ticket-edit permission is required." }, { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI API key (OPENAI_API_KEY) is not configured in the server environment. Please configure OPENAI_API_KEY to enable automatic AI image extraction." },
      { status: 503 }
    );
  }

  const images: Array<{ data: string; mediaType: string }> = [];

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await request.formData();
      const files = formData.getAll("images")
        .concat(formData.getAll("files"))
        .concat(formData.getAll("file"))
        .concat(formData.getAll("image"));
      for (const item of files) {
        if (item instanceof File) {
          const buffer = await item.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          const mediaType = item.type || "image/jpeg";
          images.push({ data: base64, mediaType });
        }
      }
    } catch {
      return NextResponse.json({ error: "Failed to parse uploaded image files." }, { status: 400 });
    }
  } else {
    try {
      const body = await request.json();
      const rawList: unknown[] = Array.isArray(body.images)
        ? body.images
        : body.image
        ? [body.image]
        : [];
      for (const item of rawList) {
        if (typeof item === "string") {
          const match = item.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
          if (match) {
            images.push({ mediaType: match[1], data: match[2] });
          } else {
            images.push({ mediaType: "image/jpeg", data: item });
          }
        } else if (item && typeof item === "object") {
          const obj = item as { data?: string; mediaType?: string; url?: string };
          if (obj.data) {
            images.push({
              mediaType: obj.mediaType || "image/jpeg",
              data: obj.data.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, ""),
            });
          }
        }
      }
    } catch {
      return NextResponse.json({ error: "Invalid extraction request payload." }, { status: 400 });
    }
  }

  if (!images.length) {
    return NextResponse.json({ error: "At least one RoomStatus or Departures image must be provided." }, { status: 400 });
  }

  const contentParts: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `Extract and validate all room operations data from these hotel report image(s) (Room Status Report and/or Expected Departures Report).
Return ONLY valid CSV text in the exact format required:

Room,Room Status,Guest Name,Room Type,LOS,Reserved,Checkout Date,Checkout Time,Incoming Arrival Date,Incoming Arrival Time,Guest Code,Guest Arrival

Extraction rules:
1. Output ONLY the raw CSV text. Do not wrap in markdown backticks or commentary.
2. Include exactly one data row for EVERY room shown in the Room Status Report, including vacant, occupied, blocked, and out-of-order rooms. Do not limit rows to rooms with guests or departures. Ignore non-room summary/footer rows (e.g., Total Clean, Occupancy %, Grand Total, Page numbers).
3. Room: 2 to 4 digit room number or MGR (all uppercase).
4. Room Status: Transcribe the room-status/housekeeping-status cell exactly as shown, including abbreviations such as VR or VD. Never infer it from guest, arrival, or departure data. Leave it blank only if the cell is visibly blank or unreadable.
5. Guest Name: Full guest name, or blank if vacant/unoccupied.
6. Room Type: Room type code (e.g. KING, 2QUEEN, STNK, etc.) or blank.
7. LOS: Length of stay as a whole number (0 if empty/vacant).
8. Reserved: Yes or No (default No if vacant/blank).
9. Checkout Date: YYYY-MM-DD or MM/DD/YYYY if specified, or blank.
10. Checkout Time: HH:MM AM/PM or blank (default 11:00 AM for departures).
11. Incoming Arrival Date, Incoming Arrival Time, Guest Code, Guest Arrival: extract if present or leave blank.
12. Do not omit a room because any other field is blank. Ensure every active room shown in the report is included.`,
    },
  ];

  for (const img of images) {
    contentParts.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mediaType};base64,${img.data}`,
        detail: "high",
      },
    });
  }

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are an expert OCR system for hotel room operations reports. You transcribe hotel report images into the exact CSV format requested. Output only CSV.",
          },
          {
            role: "user",
            content: contentParts,
          },
        ],
        temperature: 0,
      }),
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      return NextResponse.json(
        { error: `OpenAI API error (${openaiResponse.status}): ${errText}` },
        { status: 502 }
      );
    }

    const data = await openaiResponse.json();
    const rawContent: string = data.choices?.[0]?.message?.content || "";
    const cleanCsv = rawContent
      .replace(/^```(?:csv|tsv|text)?\r?\n?/i, "")
      .replace(/\r?\n?```\s*$/i, "")
      .trim();

    if (!cleanCsv) {
      return NextResponse.json({ error: "ChatGPT returned empty extraction data." }, { status: 422 });
    }

    return NextResponse.json({ ok: true, csv: cleanCsv });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ChatGPT image extraction failed." },
      { status: 500 }
    );
  }
}
