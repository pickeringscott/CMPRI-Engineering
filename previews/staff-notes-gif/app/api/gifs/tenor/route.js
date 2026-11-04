import {statusResponse} from '../../../../lib/provider-status.mjs';
export const dynamic = 'force-dynamic';
export function GET() { return statusResponse('tenor'); }
