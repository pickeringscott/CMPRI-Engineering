import './style.css';
export const metadata = {title:'CMPRI · Staff Notes preview', robots:{index:false,follow:false}};
export const viewport = {width:'device-width',initialScale:1,interactiveWidget:'resizes-content',themeColor:'#0b132b'};
export default function Layout({children}) { return <html lang="en"><body>{children}</body></html>; }
