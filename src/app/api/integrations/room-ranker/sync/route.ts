import {NextResponse} from "next/server";
/** Retired legacy workbook integration. No provider or database calls. */
function retired(){return NextResponse.json({error:"The legacy Room Ranker has been retired. Use the current Room Ranker."},{status:410});}
export const GET=retired;
export const POST=retired;
export const PATCH=retired;
