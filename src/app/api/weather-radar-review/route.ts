// Review-only catalog fallback for browsers that cannot read NOAA WMS directly.
export async function GET(request: Request) {
  if (process.env.VERCEL_ENV === 'production') return new Response(null, {status: 404});
  const search = new URL(request.url).searchParams;
  const region = search.get('region');
  const product = search.get('product');
  const conus = ['bref_qcd', 'cref_qcd', 'pcpn_typ', 'neet_v18'];
  const kilx = ['sr_bref', 'sr_bvel', 'bdhc', 'boha', 'bdsa'];
  if (!(region === 'conus' && conus.includes(product ?? '') || region === 'kilx' && kilx.includes(product ?? ''))) {
    return new Response(null, {status: 400});
  }
  const path = region === 'kilx' ? 'kilx/ows' : 'conus/conus_' + product + '/ows';
  try {
    const source = await fetch('https://opengeo.ncep.noaa.gov/geoserver/' + path + '?service=WMS&version=1.3.0&request=GetCapabilities', {
      redirect: 'error', signal: AbortSignal.timeout(8000), next: {revalidate: 60}
    });
    if (!source.ok) return new Response(null, {status: 502});
    return new Response(source.body, {headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    }});
  } catch {
    return new Response(null, {status: 502});
  }
}
