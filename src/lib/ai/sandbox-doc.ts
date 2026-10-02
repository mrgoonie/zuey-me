/**
 * Builds the `srcdoc` for an interactive block. Shared by the browser renderer and tests; pure strings only.
 *
 * Isolation model (enforced by the renderer, documented here):
 * - `<iframe sandbox="allow-scripts">` without allow-same-origin → opaque origin: no cookies,
 *   storage, parent DOM access, top navigation, popups or forms.
 * - The CSP below is the first element in <head>; later policies can only tighten it.
 *   connect-src 'none' blocks fetch/XHR/WebSocket, so network access must use `zuey.fetch`,
 *   which posts to the parent and goes through the server allowlist proxy.
 */
import type { InteractiveBlock } from '../blocks/schema';

export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; " +
  "font-src data:; media-src data: https:; form-action 'none'; base-uri 'none'";

/** Message channel tag used by the frame bridge and the parent. */
export const SANDBOX_CHANNEL = 'zuey-sandbox';
export const SANDBOX_SANDBOX_ATTR = 'allow-scripts';

/** Neutralises sequences that would end the surrounding element early. */
export function escapeForTag(source: string, tag: 'script' | 'style'): string {
  const re = new RegExp(`</(${tag})`, 'gi');
  let out = source.replace(re, '<\\/$1');
  if (tag === 'script') out = out.replace(/<!--/g, '<\\!--');
  return out;
}

/** Bridge installed before user code: zuey.fetch, size reporting, heartbeat and error relay. */
const BRIDGE = `(function(){
var P=window.parent,C=${JSON.stringify(SANDBOX_CHANNEL)},seq=0,pending={};
function post(m){m.channel=C;try{P.postMessage(m,'*');}catch(e){}}
window.addEventListener('message',function(e){
  if(e.source!==P)return;var d=e.data;if(!d||d.channel!==C||d.type!=='fetch:result')return;
  var p=pending[d.id];if(!p)return;delete pending[d.id];
  if(d.ok){var body=String(d.body||'');p.resolve({ok:d.status>=200&&d.status<300,status:d.status,contentType:d.contentType||'',text:function(){return Promise.resolve(body);},json:function(){return Promise.resolve().then(function(){return JSON.parse(body);});}});}
  else{p.reject(new Error(String(d.error||'zuey.fetch failed')));}
});
window.zuey={fetch:function(url){return new Promise(function(resolve,reject){var id=++seq;pending[id]={resolve:resolve,reject:reject};post({type:'fetch',id:id,url:String(url)});});}};
function size(){post({type:'resize',height:Math.ceil(document.documentElement.scrollHeight)});}
window.addEventListener('load',size);
if(typeof ResizeObserver==='function'){new ResizeObserver(size).observe(document.documentElement);}
window.addEventListener('error',function(e){post({type:'error',message:String(e&&e.message||'error').slice(0,300)});});
setInterval(function(){post({type:'heartbeat'});},1000);
post({type:'ready'});
})();`;

export function buildSandboxSrcdoc(block: Pick<InteractiveBlock, 'title' | 'html' | 'css' | 'js'>): string {
  const title = block.title.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}body{padding:12px;box-sizing:border-box}*,*::before,*::after{box-sizing:inherit}img,svg,canvas,video{max-width:100%;height:auto}</style>',
    `<style>${escapeForTag(block.css, 'style')}</style>`,
    `<script>${BRIDGE}</script>`,
    '</head><body>',
    block.html,
    `<script>${escapeForTag(block.js, 'script')}</script>`,
    '</body></html>',
  ].join('');
}
