import {statusResponse} from '../../../../lib/provider-status.mjs';
export const dynamic = 'force-dynamic';
export function GET() {
  // Key presence is checked only on the server. No key or upstream URL is returned.
  return statusResponse('giphy', Boolean(process.env.GIPHY_API_KEY));
}
