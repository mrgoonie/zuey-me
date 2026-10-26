/**
 * Builds the `srcdoc` for an interactive block. Shared by the browser renderer and tests; pure strings only.
 *
 * Isolation model (enforced by the renderer, documented here):
 * - `<iframe sandbox="allow-scripts">` without allow-same-origin → opaque origin: no cookies,
 *   storage, parent DOM access, top navigation, popups or forms.
 * - The CSP below is the first element in <head>; later policies can only tighten it.
 *   connect-src 'none' blocks fetch/XHR/WebSocket, so network access must use `zuey.fetch`,
 *   which posts to the parent and goes through the server allowlist proxy. Images and media are
 *   limited to `data:` and `blob:` URLs, so a widget contacts no host by itself.
 * - The sandbox still lets a frame navigate itself (`location.href`, `<meta http-equiv=refresh>`), and
 *   the document it lands on carries none of this meta CSP. CSP has no shipped directive that stops it
 *   (`navigate-to` was dropped from the spec). Two layers cover it:
 *   1. The renderer also sets the iframe `csp` attribute to SANDBOX_CSP (CSP Embedded Enforcement,
 *      Chromium only): a page that does not opt into that policy fails to load, so the frame lands on an
 *      error page and no foreign script runs. Safari and Firefox ignore the attribute.
 *   2. The parent halts the frame: every bridge message carries a per-run nonce that only this document
 *      knows; the bridge reports this document's own trusted `load` (`loaded`) and non-bfcache trusted
 *      `pagehide` (`leave`) with it; the parent halts a frame that leaves, loads a second time, fires
 *      `load` for a document that never reported `loaded`, or never reports `loaded` after `ready`.
 */
import type { InteractiveBlock } from '../blocks/schema';

export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; " +
  "font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

/** Message channel tag used by the frame bridge and the parent. */
export const SANDBOX_CHANNEL = 'zuey-sandbox';
export const SANDBOX_SANDBOX_ATTR = 'allow-scripts';

/** Unguessable per-run token (128 bits, hex) that the parent requires on every frame message. */
export function createFrameNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Neutralises sequences that would end the surrounding element early. */
export function escapeForTag(source: string, tag: 'script' | 'style'): string {
  const re = new RegExp(`</(${tag})`, 'gi');
  let out = source.replace(re, '<\\/$1');
  if (tag === 'script') out = out.replace(/<!--/g, '<\\!--');
  return out;
}

/**
 * Bridge installed before user code: zuey.fetch, size reporting, heartbeat, error relay and the
 * `pagehide` report. The nonce lives only in this closure: every message is an object literal (no
 * property assignment that a setter on Object.prototype could observe), no function reachable from
 * widget code contains it, and the script element removes itself before widget code runs.
 */
function bridge(nonce: string): string {
  return `(function(){
var P=window.parent,C=${JSON.stringify(SANDBOX_CHANNEL)},N=${JSON.stringify(nonce)},seq=0,pending=Object.create(null);
function send(m){try{P.postMessage(m,'*');}catch(e){}}
window.addEventListener('message',function(e){
  if(e.source!==P)return;var d=e.data;if(!d||d.channel!==C||d.type!=='fetch:result')return;
  var p=pending[d.id];if(!p)return;delete pending[d.id];
  if(d.ok){var body=String(d.body||'');p.resolve({ok:d.status>=200&&d.status<300,status:d.status,contentType:d.contentType||'',text:function(){return Promise.resolve(body);},json:function(){return Promise.resolve().then(function(){return JSON.parse(body);});}});}
  else{p.reject(new Error(String(d.error||'zuey.fetch failed')));}
});
function request(u){return new Promise(function(resolve,reject){var id=++seq;pending[id]={resolve:resolve,reject:reject};send({channel:C,nonce:N,type:'fetch',id:id,url:u});});}
window.zuey={fetch:function(url){return request(String(url));}};
function size(){send({channel:C,nonce:N,type:'resize',height:Math.ceil(document.documentElement.scrollHeight)});}
window.addEventListener('load',function(e){size();if(e.isTrusted)send({channel:C,nonce:N,type:'loaded'});});
if(typeof ResizeObserver==='function'){new ResizeObserver(size).observe(document.documentElement);}
window.addEventListener('error',function(e){send({channel:C,nonce:N,type:'error',message:String(e&&e.message||'error').slice(0,300)});});
window.addEventListener('pagehide',function(e){if(e.isTrusted&&!e.persisted)send({channel:C,nonce:N,type:'leave'});},true);
setInterval(function(){send({channel:C,nonce:N,type:'heartbeat'});},1000);
send({channel:C,nonce:N,type:'ready'});
var s=document.currentScript;if(s&&s.parentNode)s.parentNode.removeChild(s);
})();`;
}

export function buildSandboxSrcdoc(block: Pick<InteractiveBlock, 'title' | 'html' | 'css' | 'js'>, nonce: string = createFrameNonce()): string {
  const title = block.title.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}body{padding:12px;box-sizing:border-box}*,*::before,*::after{box-sizing:inherit}img,svg,canvas,video{max-width:100%;height:auto}</style>',
    `<style>${escapeForTag(block.css, 'style')}</style>`,
    `<script>${bridge(nonce)}</script>`,
    '</head><body>',
    block.html,
    `<script>${escapeForTag(block.js, 'script')}</script>`,
    '</body></html>',
  ].join('');
}
