export default {
  poweredByHeader: false,
  async headers() {
    return [{source: '/:path*', headers: [
      {key:'X-Robots-Tag',value:'noindex, nofollow'},
      {key:'Referrer-Policy',value:'no-referrer'},
      {key:'X-Content-Type-Options',value:'nosniff'},
      {key:'Content-Security-Policy',value:"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://*.giphy.com https://*.tenor.com; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"}
    ]}];
  }
};
