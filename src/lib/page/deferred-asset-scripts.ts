/**
 * Inline scripts that keep decorative and font downloads off the critical path (used by Layout.astro).
 * They live here so tests can run them against a stub `window` instead of matching source text.
 */

// The ambient video (~3 MB) is decorative: it starts once the page has loaded so it never competes with
// first paint, and is skipped on phones, under Save-Data and for reduced motion, where the static backdrop stays.
export const AMBIENT_VIDEO_SCRIPT = `(function(){var c=navigator.connection;if(!matchMedia('(min-width: 768px)').matches||matchMedia('(prefers-reduced-motion: reduce)').matches||(c&&c.saveData))return;function go(){var v=document.querySelector('video[data-ambient]');if(!v)return;v.preload='auto';var p=v.play();if(p&&p.catch)p.catch(function(){})}function idle(){'requestIdleCallback' in window?requestIdleCallback(go,{timeout:2000}):setTimeout(go,200)}document.readyState==='complete'?idle():addEventListener('load',idle,{once:true})})();`;
export const FONTS_URL = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,400..900&family=Plus+Jakarta+Sans:ital,wght@0,300..800;1,300..800&display=swap';
// Web fonts (~450 KB of woff2) are requested after the load event so they never compete with the LCP image;
// the metric-matched fallbacks in global.css keep the later swap from shifting layout.
export const FONT_LOADER_SCRIPT = `(function(){function f(){var l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(FONTS_URL)};document.head.appendChild(l)}document.readyState==='complete'?f():addEventListener('load',f,{once:true})})();`;
