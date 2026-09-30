export const dynamic = "force-dynamic";

const REMOVED = {
  error: "The CMPRI dashboard assistant has been retired. Connect ChatGPT to the CMPRI MCP server instead.",
};

export function GET() {
  return Response.json(REMOVED, { status: 410, headers: { "Cache-Control": "no-store" } });
}

export function POST() {
  return Response.json(REMOVED, { status: 410, headers: { "Cache-Control": "no-store" } });
}
