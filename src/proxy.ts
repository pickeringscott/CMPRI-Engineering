import {NextResponse,type NextRequest} from 'next/server';
import {manualPreviewReadOnly} from './lib/server/manual-preview';

// Weather retains its existing static route. Other review files stay private
// to preview builds; an exact list prevents future prototypes being released.
const WEATHER_ASSETS=new Set([
  '/previews/cmpri-weather-preview.html',
  '/previews/cmpri-time-format.js',
  '/previews/weather/weather-preview.css',
  '/previews/weather/weather-visuals.css',
  '/previews/weather/weather-graphs.css',
  '/previews/weather/weather-astronomy.css',
  '/previews/weather/willard-airport.css',
  '/previews/weather/willard-tracker.css',
  '/previews/weather/weather-map.css',
  '/previews/weather/weather-manual-alert.css',
  '/previews/weather/notification-preview.css',
  '/previews/weather/weather-clock.js',
  '/previews/weather/weather-tooltips.js',
  '/previews/weather/alert-check-simulation.js',
  '/previews/weather/notification-preview.js',
  '/previews/weather/ground-map.js',
  '/previews/weather/weather-map.js',
  '/previews/weather/weather-visuals.js',
  '/previews/weather/weather-graphs.js',
  '/previews/weather/weather-astronomy.js',
  '/previews/weather/weather-astronomy-feed.js',
  '/previews/weather/nws-live-view.js',
  '/previews/weather/willard-airport.js',
  '/previews/weather/willard-tracker.js',
  '/previews/weather/weather-manual-alert.js',
  '/previews/weather/weather-preview.js',
  '/previews/weather/warning-siren.mp3',
  '/previews/weather/signs/interstate-route.svg',
  '/previews/weather/signs/illinois-route.svg',
]);

export function proxy(request:NextRequest){
  const path=request.nextUrl.pathname;
  // Released Weather files bypass the app shell; other reviews remain gated.
  if(path==='/previews'||path.startsWith('/previews/')){
    const response=process.env.VERCEL_ENV==='production'
      && (!WEATHER_ASSETS.has(path)||!['GET','HEAD'].includes(request.method))
      ?new Response('Not found.',{status:404})
      :NextResponse.next();
    response.headers.set('Cache-Control','no-store');
    response.headers.set('X-Robots-Tag','noindex, nofollow');
    return response;
  }
  if(!manualPreviewReadOnly())return NextResponse.next();
  if(path.startsWith('/api/') && (!['GET','HEAD','OPTIONS'].includes(request.method)
    || /^\/api\/(?:integrations|notifications\/dispatch|pool-status\/reconcile|mcp)(?:\/|$)/.test(path)
    || path==='/api/assets/documentation/ocr/dispatch'))return NextResponse.json({error:'This preview is read-only. No live record was changed.'},{status:403});
  const response=NextResponse.next();response.headers.set('X-CMPRI-Preview','read-only');return response;
}
export const config={matcher:['/api/:path*','/previews/:path*']};
