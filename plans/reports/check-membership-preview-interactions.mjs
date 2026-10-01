#!/usr/bin/env node
// Direct Chrome/CDP acceptance for the offline membership artifact.
// Uses the real clipboard, file picker, downloads and explicit public GitHub refresh.
// Closes its owned browser and removes its temporary profile in finally.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    join(pf, 'Google/Chrome/Application/chrome.exe'),
    join(pf86, 'Google/Chrome/Application/chrome.exe'),
    join(local, 'Google/Chrome/Application/chrome.exe'),
    join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p) return p;
    } catch { /* not installed */ }
  }
  return null;
}

function launch(browserPath, profileDir) {
  const proc = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((ok, fail) => {
    let buf = '';
    const timer = setTimeout(() => fail(new Error('browser did not expose a DevTools endpoint within 20s')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok({ proc, wsUrl: m[1] }); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); fail(new Error(`browser exited early (code ${code})`)); });
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return new Promise((ok, fail) => {
    ws.onopen = () => ok({ send, on: (fn) => listeners.push(fn), close: () => ws.close() });
    ws.onerror = () => fail(new Error('could not connect to the browser'));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out=resolve('plans/reports/zuey-membership-ux-render-check');mkdirSync(out,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'zuey-preview-ux-'));let browser,cdp;const results=[],errors=[],requests=[];
const assertion=(name,pass,detail)=>{results.push({name,pass:!!pass,detail});if(!pass)process.exitCode=1;};
try {
 browser=await launch(findBrowser(),profile);cdp=await connect(browser.wsUrl);
 const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
 const send=(method,params={})=>cdp.send(method,params,sessionId);
 cdp.on(m=>{if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url))requests.push(m.params.request.url);});
 await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
 const run=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const resize=async(w,h)=>send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});
 const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 await resize(1440,900);await send('Page.navigate',{url:pathToFileURL(resolve('plans/visuals/explain-zuey-membership.html')).href});await sleep(900);
 await run(`localStorage.clear()`);
 assertion('Controls collapsed; no legacy locale/access dropdown',await run(`document.getElementById('knowledge-controls').hidden&&!document.querySelector('#locale,#access,#category,#sort')`));
 assertion('15 branded thumbnail images load',await run(`document.querySelectorAll('.post-thumbnail').length===15&&[...document.querySelectorAll('.post-thumbnail')].every(i=>i.complete&&i.naturalWidth>0)`));
 const localeCounts=await run(`['vi','en','zh','ko','ja'].map(locale=>{document.querySelector('.locale-option[data-locale='+locale+']').click();return {locale,count:[...document.querySelectorAll('.post-card')].filter(x=>!x.hidden).length,label:document.getElementById('knowledge-locale').textContent,root:document.documentElement.lang,greeting:document.getElementById('chat-greeting').lang};})`);
 assertion('Global locale controls all five article sets',localeCounts.every(x=>x.count===3&&x.label===x.locale.toUpperCase()&&x.root===x.locale&&x.greeting===x.locale),localeCounts);
 await run(`document.querySelector('.locale-option[data-locale=vi]').click();document.getElementById('search-toggle').click();document.getElementById('search').value='no-matching-query';document.getElementById('search').dispatchEvent(new Event('input'))`);
 assertion('Useful empty search state',await run(`!document.getElementById('empty').hidden&&!document.getElementById('filter-dot').hidden`));
 await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 assertion('Escape closes tools and restores trigger focus',await run(`document.getElementById('knowledge-controls').hidden&&document.activeElement.id==='search-toggle'`));
 await run(`document.getElementById('empty-reset').click();document.querySelector('[data-category-filter=ai]').click();document.querySelector('[data-sort=title]').click()`);
 assertion('Category and sort retain actual matching results',await run(`document.querySelector('[data-category-filter=ai]').getAttribute('aria-pressed')==='true'&&[...document.querySelectorAll('.post-card')].filter(x=>!x.hidden).every(x=>x.dataset.category==='ai')`));
 await run(`document.getElementById('clear-filters').click();document.querySelector('.post-card:not([hidden]) .read-demo').click()`);
 assertion('Article activation moves focus to reader heading',await run(`document.activeElement.id==='article-heading'`));
 assertion('MCP disclosure links to controlled content',await run(`document.getElementById('mcp-example').getAttribute('aria-controls')==='mcp-status'`));
 await run(`document.getElementById('member').click()`);
 assertion('Paid article and row read icons unlock together',await run(`document.getElementById('locked').hidden&&!document.getElementById('full-content').hidden&&[...document.querySelectorAll('.read-state')].every(x=>x.getAttribute('aria-label')==='Có quyền đọc toàn bài')`));
 await run(`document.getElementById('free').click();document.querySelector('[data-open-policy]').click()`);
 assertion('Detailed privacy dialog discloses admin access',await run(`document.getElementById('policy-dialog').open&&document.getElementById('policy-dialog').textContent.includes('tất cả chat sessions còn lưu')`));
 await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(100);
 assertion('Policy Escape closes and restores focus',await run(`!document.getElementById('policy-dialog').open&&document.activeElement.hasAttribute('data-open-policy')`),await run(`({open:document.getElementById('policy-dialog').open,active:document.activeElement.outerHTML.slice(0,180)})`));
 await run(`document.getElementById('session-query').value='sản phẩm';document.getElementById('session-query').dispatchEvent(new Event('input'))`);
 assertion('Admin session demo queries all samples',await run(`document.querySelectorAll('.session-result').length===1&&document.getElementById('session-results').textContent.includes('demo-03')`));
 await run(`document.getElementById('session-query').value='';document.getElementById('session-query').dispatchEvent(new Event('input'));document.getElementById('pause-companion').click();document.getElementById('character').focus();`);
 const before=await run(`document.getElementById('companion').getBoundingClientRect().x`);
 await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
 assertion('Companion supports keyboard movement',await run(`document.getElementById('companion').getBoundingClientRect().x`)<before);
 const pos=await run(`({x:document.getElementById('character').getBoundingClientRect().x+50,y:document.getElementById('character').getBoundingClientRect().y+50})`);
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...pos});await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:430,y:250});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:430,y:250});
 assertion('Pointer dragging moves cutout through page',await run(`document.getElementById('companion').getBoundingClientRect().x<500`));
 await run(`document.getElementById('character').click()`);await sleep(50);
 assertion('Overhead interactive bubble remains in viewport',await run(`(()=>{const r=document.getElementById('companion-bubble').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`));
 await run(`document.getElementById('dismiss-bubble').click();document.getElementById('announcement-message').value='<img src=x onerror=alert(1)>';document.getElementById('announcement-ttl').value='5';document.getElementById('announcement-expression').value='surprised';document.activeElement.blur();document.getElementById('announcement-form').requestSubmit()`);
 assertion('Announcement identifies Duy, expression and safe text',await run(`document.getElementById('bubble-source').textContent.includes('Duy thật')&&document.getElementById('companion').dataset.state==='surprised'&&!document.getElementById('bubble-message').querySelector('img')&&!document.getElementById('bubble-expiry').hidden`));
 await run(`document.getElementById('dismiss-bubble').click();document.getElementById('hide-companion').click();document.getElementById('restore-companion').click()`);await sleep(1100);
 assertion('Dismissed announcement never replays on restore',await run(`document.getElementById('companion-bubble').hidden`));
 await run(`document.getElementById('announcement-message').value='Thông báo TTL mẫu';document.activeElement.blur();document.getElementById('announcement-form').requestSubmit()`);await sleep(6200);
 assertion('Announcement expires automatically',await run(`document.getElementById('companion-bubble').hidden&&document.getElementById('announcement-status').textContent.includes('hết hạn')`));
 await run(`document.getElementById('weather-mode').value='rain';document.getElementById('weather-mode').dispatchEvent(new Event('change'))`);
 assertion('Weather changes background and mascot expression',await run(`document.body.dataset.weather==='rain'&&document.getElementById('companion').dataset.state==='thinking'`));
 assertion('Restore control stays in document flow',await run(`getComputedStyle(document.getElementById('restore-companion')).position==='static'`));
 assertion('Enterprise exact price and credit, requested embeds',await run(`document.getElementById('business').textContent.includes('$1,999')&&document.getElementById('business').textContent.includes('trừ trực tiếp')&&['YouTube','SoundCloud','Vimeo','Spotify','Instagram','TikTok','LinkedIn'].every(p=>document.body.textContent.includes(p))`));
 await run(`window.scrollTo(0,420);document.getElementById('hide-companion').click()`);await shot('desktop-home');
 for(const [w,h] of [[768,1024],[375,812],[320,812]]){await resize(w,h);await run(`document.querySelector('[data-panel=knowledge]').click();document.getElementById('shell').scrollIntoView();`);await sleep(150);assertion(w+'px page reflows without horizontal overflow',await run(`document.documentElement.scrollWidth<=innerWidth+1`));await shot('knowledge-'+w);}
 await resize(375,812);await run(`document.querySelector('[data-panel=ai]').click();document.getElementById('shell').scrollIntoView();document.getElementById('restore-companion').click();document.getElementById('character').click()`);await shot('mobile-ai');
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await sleep(200);
 const frame=await run(`document.getElementById('sprite').style.backgroundPosition`);await sleep(650);
 assertion('Reduced motion stops sprites and respects pause state',await run(`document.getElementById('sprite').style.backgroundPosition`)===frame&&await run(`document.getElementById('pause-companion').getAttribute('aria-pressed')==='true'`));
 await send('Emulation.setEmulatedMedia',{features:[]});
 await run(`document.getElementById('announcement-message').value='Tin Duy đang chờ';document.getElementById('announcement-ttl').value='20';document.getElementById('chat-input').focus();document.getElementById('announcement-form').requestSubmit()`);await sleep(1100);
 assertion('Incoming announcement waits while visitor types',await run(`document.getElementById('companion-bubble').hidden||!document.getElementById('bubble-source').textContent.includes('Duy thật')`));
 await run(`document.activeElement.blur();document.getElementById('dismiss-bubble').click()`);
 await resize(1440,900);await run(`document.getElementById('hide-companion').click();document.getElementById('business').scrollIntoView()`);await shot('desktop-business');
 await resize(375,812);await run(`document.getElementById('business').scrollIntoView()`);await shot('mobile-business');
 await run(`document.getElementById('weather-preview').scrollIntoView()`);await shot('mobile-weather');
 // New pricing/sharing browser acceptance. Clipboard exercises the real browser API.
 await resize(1440,900);await send('Page.bringToFront');
 await cdp.send('Browser.grantPermissions',{permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
 await run(`document.getElementById('free').click();document.getElementById('knowledge-subscribe').click()`);
 assertion('Knowledge CTA opens pricing with matching plan',await run(`document.getElementById('pricing-dialog').open&&document.querySelector('[data-plan-card=knowledge]').classList.contains('selected')`));
 const choices=await run(`['knowledge','ai','combo','community'].map(id=>{document.querySelector('[data-choose-plan='+id+']').click();return {id,text:document.getElementById('selected-plan').textContent,free:!document.getElementById('locked').hidden};})`);
 assertion('Four pricing plans preserve price and never grant entitlement',choices.every((p,i)=>p.free&&p.text.includes('$'+[9,9,19,29][i]+'/tháng')),choices);
 await shot('desktop-pricing');
 await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(100);
 assertion('Pricing Escape closes and returns CTA focus',await run(`!document.getElementById('pricing-dialog').open&&document.activeElement.id==='knowledge-subscribe'`));
 await run(`document.getElementById('open-markdown').click()`);
 assertion('Markdown display contains only text and free preview',await run(`document.getElementById('share-dialog').open&&document.getElementById('markdown-view').open&&document.getElementById('markdown-content').children.length===0&&document.getElementById('markdown-content').textContent.startsWith('# ')&&!document.getElementById('markdown-content').textContent.includes('Subscriber có Knowledges')`));
 await run(`document.getElementById('copy-markdown').click()`);await sleep(250);
 const clipboard=await run(`document.getElementById('manual-copy').hidden?navigator.clipboard.readText():document.getElementById('manual-copy-text').value`);
 assertion('Copy Markdown delivers actual entitled preview',clipboard.startsWith('# ')&&!clipboard.includes('Subscriber có Knowledges'),{mode:await run(`document.getElementById('manual-copy').hidden?'clipboard':'manual fallback'`)});
 await run(`document.getElementById('copy-markdown-url').click()`);await sleep(150);
 const mdurl=await run(`document.getElementById('manual-copy').hidden?navigator.clipboard.readText():document.getElementById('manual-copy-text').value`);
 assertion('Copy Markdown URL uses .md with no credential/query',mdurl==='https://zuey.me/vi/knowledges/lam-viec-voi-ai.md'&&!mdurl.includes('?'));
 const destinations=await run(`[...document.querySelectorAll('[data-send-ai]')].map(a=>({name:a.dataset.sendAi,url:a.href,rel:a.rel}))`);
 assertion('AI destinations are official links with safe opener behavior',destinations.length===3&&destinations.every((a,i)=>a.url===['https://chatgpt.com/','https://claude.ai/','https://gemini.google.com/'][i]&&a.rel.includes('noopener')),destinations);
 // Cancel navigation in this browser test only; dispatch still invokes the real copy handler.
 await run(`document.querySelector('[data-send-ai=ChatGPT]').addEventListener('click',e=>e.preventDefault(),{once:true});document.querySelector('[data-send-ai=ChatGPT]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);await sleep(200);
 const aiPrompt=await run(`document.getElementById('manual-copy').hidden?navigator.clipboard.readText():document.getElementById('manual-copy-text').value`);
 assertion('AI prompt references public URL without paid content',aiPrompt.includes(mdurl)&&!aiPrompt.includes('Subscriber có Knowledges')&&!aiPrompt.includes('token='));
 await run(`document.getElementById('close-share').click();document.getElementById('member').click();document.getElementById('open-markdown').click()`);
 assertion('Knowledges export includes authorized full sample',await run(`document.getElementById('markdown-content').textContent.includes('Subscriber có Knowledges')`));
 await shot('desktop-sharing');
 await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(100);
 assertion('Share Escape closes and restores opener focus',await run(`!document.getElementById('share-dialog').open&&document.activeElement.id==='open-markdown'`));
 for(const [w,h] of [[375,812],[320,812]]){await resize(w,h);await run(`document.getElementById('open-share').click()`);assertion(w+'px share dialog fits viewport',await run(`(()=>{const r=document.getElementById('share-dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`));await shot('sharing-'+w);await run(`document.getElementById('close-share').click();document.getElementById('knowledge-subscribe').click()`);assertion(w+'px pricing dialog fits viewport',await run(`(()=>{const r=document.getElementById('pricing-dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`));await shot('pricing-'+w);await run(`document.getElementById('close-pricing').click()`);}
 await run(`document.getElementById('open-share').click()`);
 if(!await run(`!!navigator.share`)){await run(`document.getElementById('native-share').click()`);await sleep(200);assertion('Native share gracefully falls back to actual URL copy',await run(`navigator.clipboard.readText()`)==='https://zuey.me/vi/knowledges/lam-viec-voi-ai');}
 await cdp.send('Browser.setPermission',{permission:{name:'clipboard-read'},setting:'denied'});
 await cdp.send('Browser.setPermission',{permission:{name:'clipboard-write'},setting:'denied'});
 await run(`document.getElementById('copy-markdown').click()`);await sleep(200);
 assertion('Denied clipboard shows selected manual-copy fallback',await run(`!document.getElementById('manual-copy').hidden&&document.getElementById('manual-copy-text').value.startsWith('# ')&&document.getElementById('manual-copy-text').selectionStart===0&&document.getElementById('manual-copy-text').selectionEnd===document.getElementById('manual-copy-text').value.length`));
 await run(`document.getElementById('close-share').click()`);

 // Motion, command palette, account and public GitHub acceptance.
 assertion('GSAP runtime is embedded and current',await run(`window.gsap?.version==='3.15.0'`));
 await resize(1440,900);await run(`window.scrollTo(0,0);document.getElementById('open-command').focus()`);
 const key=async(key,code,vk,modifiers=0)=>{await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,modifiers});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers});};
 await key('k','KeyK',75,4);await sleep(100);
 assertion('Cmd K opens palette and focuses searchable combobox',await run(`document.getElementById('command-dialog').open&&document.activeElement.id==='command-query'&&document.querySelectorAll('.command-option').length===9`));
 await key('ArrowDown','ArrowDown',40);await key('Enter','Enter',13);await sleep(100);
 assertion('Palette arrows and Enter open article search with focus',await run(`!document.getElementById('command-dialog').open&&!document.getElementById('knowledge-controls').hidden&&document.activeElement.id==='search'`));
 await key('k','KeyK',75,2);await run(`document.getElementById('command-query').value='khongcoaction';document.getElementById('command-query').dispatchEvent(new Event('input'))`);
 assertion('Ctrl K works from input and search has useful empty state',await run(`document.getElementById('command-dialog').open&&!document.getElementById('command-empty').hidden&&!document.getElementById('command-query').hasAttribute('aria-activedescendant')`));
 await run(`document.getElementById('command-query').value='cau hinh';document.getElementById('command-query').dispatchEvent(new Event('input'))`);await key('Enter','Enter',13);await sleep(150);
 assertion('Accent insensitive command executes MCP OAuth view',await run(`document.getElementById('mcp-dialog').open&&document.getElementById('mcp-dialog').textContent.includes('PKCE S256')&&document.getElementById('mcp-endpoint').value==='https://zuey.me/mcp'`));
 await run(`document.getElementById('copy-mcp-endpoint').click()`);await sleep(100);
 assertion('MCP denied clipboard exposes selected endpoint fallback',await run(`!document.getElementById('mcp-manual-copy').hidden&&document.getElementById('mcp-manual-copy').value==='https://zuey.me/mcp'&&document.getElementById('mcp-manual-copy').selectionEnd===document.getElementById('mcp-manual-copy').value.length`));
 await cdp.send('Browser.setPermission',{permission:{name:'clipboard-read'},setting:'granted'});await cdp.send('Browser.setPermission',{permission:{name:'clipboard-write'},setting:'granted'});
 await run(`document.getElementById('copy-mcp-endpoint').click()`);await sleep(120);
 assertion('MCP endpoint copies through real Clipboard API',await run(`navigator.clipboard.readText()`)==='https://zuey.me/mcp'&&await run(`document.getElementById('mcp-manual-copy').hidden`));
 await key('Escape','Escape',27);await sleep(100);
 assertion('MCP Escape closes and restores palette trigger focus',await run(`!document.getElementById('mcp-dialog').open&&document.activeElement.id==='open-command'`));
 for(const action of ['chat','pricing','subscribe','account','activity']){
  await run(`document.getElementById('open-command').click();document.getElementById('command-${action}').click()`);await sleep(120);
  const expr=action==='chat'?`document.activeElement.id==='chat-input'`:action==='pricing'||action==='subscribe'?`document.getElementById('pricing-dialog').open`:action==='account'?`!document.getElementById('account-page').hidden&&document.getElementById('website-preview').hidden&&document.activeElement.id==='account-heading'`:`document.activeElement.id==='activity-heading'&&!document.getElementById('website-preview').hidden`;
  assertion('Palette action '+action+' selects correct surface',await run(expr));
  await run(`document.querySelectorAll('dialog[open]').forEach(d=>d.close())`);await sleep(40);
 }
 await run(`document.getElementById('open-command').click()`);await key('Escape','Escape',27);await sleep(100);
 assertion('Palette Escape restores trigger focus',await run(`!document.getElementById('command-dialog').open&&document.activeElement.id==='open-command'`));
 await run(`document.getElementById('open-account').click();document.getElementById('account-name').value='Tên thử <script>';document.getElementById('account-email').value='test@example.invalid';document.getElementById('account-bio').value='Giới thiệu mẫu';document.getElementById('account-form').requestSubmit()`);
 assertion('Profile saves safe text in tab with honest persistence status',await run(`document.getElementById('account-name-label').textContent==='Tên thử <script>'&&!document.getElementById('account-name-label').children.length&&document.getElementById('account-save-status').textContent.includes('chưa lưu server')`));
 await run(`document.getElementById('account-memory').click();document.getElementById('clear-account-memory').click()`);
 assertion('User can disable and reset separate memory preference',await run(`!document.getElementById('account-memory').checked&&document.getElementById('account-memory-status').textContent.includes('reset')`));
 await send('DOM.enable');const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'#avatar-file'});
 await send('DOM.setFileInputFiles',{nodeId,files:[resolve('plans/visuals/assets/zuey-companion-sprites.png')]});await sleep(200);
 assertion('Real avatar upload decodes locally without request',await run(`!!document.querySelector('#account-avatar img')&&document.querySelector('#account-avatar img').complete&&document.querySelector('#account-avatar img').src.startsWith('blob:')`));
 assertion('Uploaded avatar updates accessible wrapper name',await run(`document.getElementById('account-avatar').getAttribute('aria-label').includes('vừa chọn')`));await run(`document.getElementById('reset-avatar').click()`);
 assertion('Avatar reset releases displayed image',await run(`!document.querySelector('#account-avatar img')`));
 await run(`document.querySelector('[data-account-section=chats]').click();document.getElementById('account-chat-search').value='san pham';document.getElementById('account-chat-search').dispatchEvent(new Event('input'));document.querySelector('.own-chat').click()`);
 assertion('Own chat search opens only matching demo session',await run(`document.querySelectorAll('.own-chat').length===1&&document.getElementById('account-chat-title').textContent==='Ý tưởng sản phẩm'&&!document.getElementById('account-chat-detail').hidden`));
 await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:join(out,'downloads')});
 await run(`document.getElementById('export-account-chat').click()`);await sleep(200);
 assertion('Own chat exports Markdown file',existsSync(join(out,'downloads','own-02.md'))&&readFileSync(join(out,'downloads','own-02.md'),'utf8').includes('Hội thoại mẫu'));
 await run(`document.getElementById('delete-account-chat').click()`);
 assertion('Deleting own demo session refreshes list and detail',await run(`!document.querySelector('.own-chat')&&document.getElementById('account-chat-detail').hidden&&document.getElementById('account-chat-status').textContent.includes('chưa xoá dữ liệu backend')`));
 await run(`document.querySelector('[data-account-section=activity]').click()`);
 assertion('Account activity shows actual preview operations',await run(`document.getElementById('account-activity-log').textContent.includes('Đã xuất session mẫu')&&document.getElementById('account-activity-log').textContent.includes('Đã cập nhật hồ sơ mẫu')`));
 await run(`document.querySelector('[data-account-section=subscription]').click();document.querySelector('#account-page [data-open-pricing]').click()`);
 assertion('Subscription management opens real pricing demo, keeps Free',await run(`document.getElementById('pricing-dialog').open&&document.querySelector('#account-view-subscription').textContent.includes('Free')`));
 await run(`document.getElementById('close-pricing').click();document.querySelector('[data-account-section=info]').click();document.getElementById('account-name').value='Visitor demo';document.getElementById('account-email').value='visitor@example.invalid';document.getElementById('account-bio').value='';document.getElementById('account-form').requestSubmit()`);await sleep(300);await shot('account-desktop');
 for(const [w,h] of [[768,1024],[375,812],[320,812]]){await resize(w,h);await sleep(100);assertion(w+'px account fits without horizontal overflow',await run(`document.documentElement.scrollWidth<=innerWidth+1`));await shot('account-'+w);}
 await run(`document.getElementById('account-back').click()`);await sleep(80);
 assertion('Account back restores homepage and opener focus',await run(`document.getElementById('account-page').hidden&&!document.getElementById('website-preview').hidden&&document.activeElement.id==='open-account'`));
 await run(`document.getElementById('open-command').click()`);await sleep(250);await shot('command-320');assertion('Palette reports all nine actions and a scroll cue',await run(`document.getElementById('command-count').textContent.includes('9 hành động')&&document.getElementById('command-count').textContent.includes('cuộn')`));
 assertion('Mobile palette is accessible and bounded',await run(`(()=>{const r=document.getElementById('command-dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`));
 await run(`document.getElementById('close-command').click();document.getElementById('public-activity').scrollIntoView()`);await sleep(100);await shot('github-320');assertion('Mobile graph initially exposes latest days',await run(`document.getElementById('github-graph').parentElement.scrollLeft>0`),await run(`({left:document.getElementById('github-graph').parentElement.scrollLeft,scrollWidth:document.getElementById('github-graph').parentElement.scrollWidth,clientWidth:document.getElementById('github-graph').parentElement.clientWidth})`));
 assertion('Graph has 84 dated cells with explicit event counts',await run(`document.querySelectorAll('.github-day').length===84&&[...document.querySelectorAll('.github-day')].every(b=>b.getAttribute('aria-label').includes('public events'))`));
 await run(`document.querySelector('.github-day[data-level="3"]').click()`);
 assertion('Graph day selection opens genuine public repo events',await run(`document.getElementById('github-event-list').querySelectorAll('a').length>0&&[...document.querySelectorAll('.github-event a')].every(a=>a.href.startsWith('https://github.com/'))`));
 await resize(1440,900);await run(`document.getElementById('public-activity').scrollIntoView()`);await sleep(300);await shot('github-desktop');
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await run(`document.getElementById('open-command').click()`);await sleep(60);
 assertion('Reduced motion leaves dialog content visible',await run(`getComputedStyle(document.getElementById('command-dialog').firstElementChild).opacity==='1'&&!gsap.isTweening(document.getElementById('command-dialog').firstElementChild)`));
 await run(`document.getElementById('close-command').click()`);await send('Emulation.setEmulatedMedia',{features:[]});

 await run(`document.getElementById('restore-companion').click();document.getElementById('dismiss-bubble').click();if(document.getElementById('pause-companion').getAttribute('aria-pressed')==='true')document.getElementById('pause-companion').click();document.activeElement.blur()`);
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
 let walked=false;
 for(let i=0;i<155;i++){if(await run(`document.getElementById('companion').dataset.state==='walking'&&gsap.globalTimeline.getChildren(false,true,false).some(t=>t.duration()===1.1)`)){walked=true;break;}await sleep(200);}
 assertion('Autonomous mascot movement uses actual GSAP tween',walked);
 if(walked){await run(`document.getElementById('open-account').click();document.getElementById('account-name').focus()`);const held=await run(`document.getElementById('companion').style.transform`);await sleep(250);assertion('Typing cancels active mascot GSAP motion',await run(`document.getElementById('companion').style.transform===${JSON.stringify(held)}&&document.getElementById('companion').dataset.state==='idle'`));await run(`document.getElementById('account-back').click()`);}
 await run(`document.getElementById('hide-companion').click()`);

 // Proposed taxonomy/interview behavior is a local editorial preview, never an AI/API call.
 await run(`document.getElementById('knowledge-label').value='tool:agentkit';document.getElementById('knowledge-label').dispatchEvent(new Event('change'))`);
 assertion('Label facet filters real matching sample metadata',await run(`[...document.querySelectorAll('.post-card')].filter(c=>!c.hidden).length===1&&document.getElementById('applied-summary').textContent.includes('AgentKit')`));
 await run(`document.querySelector('[data-category-filter=ai]').click()`);
 assertion('Label and category filters compose rather than override',await run(`!document.getElementById('empty').hidden`));
 await run(`document.getElementById('clear-filters').click()`);
 assertion('Reset clears taxonomy facet and restores locale list',await run(`document.getElementById('knowledge-label').value==='all'&&[...document.querySelectorAll('.post-card')].filter(c=>!c.hidden).length===3`));
 await run(`document.getElementById('taxonomy-demo').open=true;document.getElementById('propose-labels').click()`);
 const beforeLabels=await run(`document.getElementById('article-labels').textContent`);
 assertion('AI demo proposal opens interview without changing approved labels',await run(`!document.getElementById('taxonomy-interview').hidden&&document.getElementById('taxonomy-review').hidden&&document.getElementById('article-label-status').textContent.includes('chưa phải')`));
 await run(`document.getElementById('taxonomy-nature').value='fact';document.getElementById('taxonomy-reason').value='Rà soát đúng phiên bản';document.getElementById('taxonomy-interview').requestSubmit()`);
 assertion('Fact proposal is blocked without source, claim scope and date',await run(`document.getElementById('taxonomy-review').hidden&&document.getElementById('taxonomy-validation').textContent.includes('Fact cần')`));
 await run(`document.getElementById('taxonomy-scope').value='claim-demo-01 ở block mẫu';document.getElementById('taxonomy-evidence').value='https://example.invalid/evidence';document.getElementById('taxonomy-as-of').value='2024-01-01';document.getElementById('taxonomy-freshness').value='outdated';document.getElementById('taxonomy-tool').value='agentkit';document.getElementById('taxonomy-model').value='model-example v1';document.getElementById('taxonomy-workflow').value='build';document.getElementById('taxonomy-mindset').value='evidence';document.getElementById('taxonomy-interview').requestSubmit()`);
 assertion('Fact and outdated coexist in review with before/after evidence',await run(`!document.getElementById('taxonomy-review').hidden&&document.getElementById('taxonomy-after').textContent.includes('Fact')&&document.getElementById('taxonomy-after').textContent.includes('Outdated')&&document.getElementById('taxonomy-before').textContent.includes('Hiện tại')&&document.getElementById('taxonomy-review-context').textContent.includes('2024-01-01')&&document.getElementById('apply-labels').disabled`));
 assertion('Review receives keyboard focus',await run(`document.activeElement.id==='taxonomy-review-title'`));
 assertion('Review alone never updates visible article labels',await run(`document.getElementById('article-labels').textContent`)===beforeLabels);
 await run(`document.getElementById('taxonomy-approved').click();document.getElementById('taxonomy-reason').value='Sửa ý kiến admin';document.getElementById('taxonomy-reason').dispatchEvent(new Event('input',{bubbles:true}))`);
 assertion('Changing interview answers invalidates previous approval',await run(`document.getElementById('taxonomy-review').hidden&&!document.getElementById('taxonomy-approved').checked&&document.getElementById('apply-labels').disabled`));
 await run(`document.getElementById('taxonomy-interview').requestSubmit();document.getElementById('taxonomy-approved').click();document.getElementById('apply-labels').click()`);
 assertion('Explicit admin demo approval updates labels and warns local-only',await run(`document.getElementById('article-labels').textContent.includes('Fact')&&document.getElementById('article-labels').textContent.includes('Outdated')&&document.getElementById('article-labels').querySelector('.outdated')&&document.getElementById('taxonomy-apply-status').textContent.includes('API/MCP')`));
 await run(`document.getElementById('knowledge-label').value='fact';document.getElementById('knowledge-label').dispatchEvent(new Event('change'))`);
 assertion('Approved VI classification updates matching list without certifying other locales',await run(`[...document.querySelectorAll('.post-card')].filter(c=>!c.hidden).length===1&&document.querySelector('.post-card[data-order="3"][data-locale="vi"]').dataset.labels.includes('fact')&&[...document.querySelectorAll('.post-card[data-order="3"]:not([data-locale="vi"])')].every(c=>!c.dataset.labels.includes('fact')&&c.dataset.labels.includes('needs-review'))`));
 await run(`document.getElementById('clear-filters').click();document.getElementById('open-markdown').click()`);
 assertion('Markdown export carries approved public label metadata without private claim evidence',await run(`document.getElementById('markdown-content').textContent.includes('Nhãn (metadata mẫu)')&&document.getElementById('markdown-content').textContent.includes('Outdated')&&!document.getElementById('markdown-content').textContent.includes('claim-demo-01')&&!document.getElementById('markdown-content').textContent.includes('example.invalid/evidence')`));
 await run(`document.getElementById('close-share').click();document.getElementById('propose-labels').click();document.getElementById('cancel-labels').click()`);
 assertion('Cancel proposal retains last approved classification',await run(`document.getElementById('taxonomy-interview').hidden&&document.getElementById('article-labels').textContent.includes('Outdated')&&document.getElementById('taxonomy-apply-status').textContent.includes('giữ nguyên')`));

 await run(`document.getElementById('propose-labels').click();document.getElementById('taxonomy-scope').value='claim-demo-02';document.getElementById('taxonomy-evidence').value='https://example.invalid/new-evidence';document.getElementById('taxonomy-as-of').value='2025-02-02';document.getElementById('taxonomy-reason').value='Nguồn và thời điểm mới';document.getElementById('taxonomy-interview').requestSubmit()`);
 assertion('Subsequent review compares old and new evidence/scope/date/reason',await run(`['claim-demo-01','https://example.invalid/evidence','2024-01-01','Sửa ý kiến admin'].every(v=>document.getElementById('taxonomy-before-context').textContent.includes(v))&&['claim-demo-02','https://example.invalid/new-evidence','2025-02-02','Nguồn và thời điểm mới'].every(v=>document.getElementById('taxonomy-review-context').textContent.includes(v))`));
 await run(`document.getElementById('cancel-labels').click()`);
 for(const [w,h] of [[1440,900],[375,812],[320,812]]){await resize(w,h);await run(`document.getElementById('taxonomy-demo').open=true;document.getElementById('propose-labels').click();document.getElementById('taxonomy-interview-title').scrollIntoView()`);await sleep(260);assertion(w+'px classification interview fits page',await run(`document.documentElement.scrollWidth<=innerWidth+1`));await shot('taxonomy-'+w);await run(`document.getElementById('cancel-labels').click()`);}
 await resize(1440,900);await run(`document.getElementById('taxonomy-demo').open=false;document.getElementById('article-taxonomy').scrollIntoView()`);await shot('taxonomy-overview');

 // User developer views use explicitly nonfunctional specimens and an offline request evaluator.
 await run(`document.querySelector('#website-preview [data-developer-open="api-docs"]').click()`);
 assertion('Main MCP area discovers docs in user account with focus',await run(`!document.getElementById('account-page').hidden&&!document.querySelector('[data-account-view="api-docs"]').hidden&&document.activeElement.id==='api-docs-heading'`));
 await run(`document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Anonymous sandbox requests return structured 401',await run(`document.getElementById('api-response-status').textContent.includes('401')&&JSON.parse(document.getElementById('api-response').textContent).error==='credential_invalid'&&document.activeElement.id==='api-response-heading'`));
 await run(`document.querySelector('[data-account-section="api-keys"]').click();document.getElementById('api-key-create').open=true;document.getElementById('api-key-name').value='Laptop';document.querySelector('#api-key-scopes input:checked').checked=false;document.getElementById('api-key-form').requestSubmit()`);
 assertion('Key form rejects empty scope selection',await run(`document.getElementById('api-key-validation').textContent.includes('ít nhất')&&!document.querySelector('.api-key-card')`));
 await run(`document.querySelector('#api-key-scopes input[value="knowledge:search"]').checked=true;document.getElementById('api-key-form').requestSubmit()`);
 assertion('User key creation shows nonfunctional specimen once and only metadata in list',await run(`!document.getElementById('api-key-once').hidden&&document.getElementById('api-key-specimen').type==='password'&&document.getElementById('api-key-specimen').value.startsWith('DEMO_ONLY_NOT_A_CREDENTIAL_')&&!document.getElementById('api-key-list').textContent.includes('DEMO_ONLY')&&document.activeElement.id==='api-key-once-title'`));
 assertion('User scopes never include admin and generation does not change Free account',await run(`[...document.querySelectorAll('#api-key-scopes input')].every(x=>!x.value.includes('admin'))&&document.querySelector('[data-account-view="subscription"] strong').textContent.includes('Free')`));
 await run(`document.getElementById('reveal-api-key').click();document.getElementById('copy-api-key').click()`);await sleep(100);
 assertion('Specimen reveal and clipboard work without credential issuance',await run(`(async()=>document.getElementById('reveal-api-key').getAttribute('aria-pressed')==='true'&&document.getElementById('api-key-copy-status').textContent.includes('chuỗi mẫu')&&(await navigator.clipboard.readText()).startsWith('DEMO_ONLY_NOT_A_CREDENTIAL_'))()`));
 await run(`document.querySelector('[data-account-section="api-docs"]').click()`);
 assertion('Leaving key view clears one-time specimen from DOM',await run(`document.getElementById('api-key-once').hidden&&document.getElementById('api-key-specimen').value===''`));
 await run(`document.getElementById('api-credential').value='demo-key-01';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Free key can search only preview metadata and records simulated last use',await run(`JSON.parse(document.getElementById('api-response').textContent).data[0].access==='preview'&&document.getElementById('api-key-list').textContent.includes('giả lập')`));
 await run(`document.getElementById('api-operation').value='read';document.getElementById('api-operation').dispatchEvent(new Event('change'));document.getElementById('api-demo-plan').value='combo';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Upgraded membership cannot bypass missing key scope',await run(`JSON.parse(document.getElementById('api-response').textContent).error==='scope_missing'`));
 await run(`document.querySelector('[data-account-section="api-keys"]').click();document.getElementById('api-key-name').value='CLI';document.querySelectorAll('#api-key-scopes input').forEach(x=>x.checked=true);document.getElementById('api-key-form').requestSubmit();document.getElementById('dismiss-api-key').click()`);
 assertion('Per-key action accessible names include key identity',await run(`[...document.querySelectorAll('.api-key-card button')].every(button=>button.getAttribute('aria-label').includes(button.closest('.api-key-card').dataset.keyId))&&new Set([...document.querySelectorAll('.api-key-card button')].map(button=>button.getAttribute('aria-label'))).size===4`));
 assertion('Dismiss destroys specimen and does not expose a reveal-again control in list',await run(`document.getElementById('api-key-specimen').value===''&&document.getElementById('api-key-once').hidden&&document.querySelectorAll('.api-key-card').length===2&&[...document.querySelectorAll('.api-key-card button')].every(x=>['Rotate','Thu hồi'].includes(x.textContent))`));
 await run(`document.querySelector('[data-account-section="api-docs"]').click();document.getElementById('api-credential').value='demo-key-02';document.getElementById('api-demo-plan').value='free';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Scoped read key cannot bypass Free membership',await run(`JSON.parse(document.getElementById('api-response').textContent).error==='membership_required'&&!document.getElementById('api-response').textContent.includes('nguyên bài MẪU')`));
 await run(`document.getElementById('api-demo-plan').value='knowledge';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Knowledges plus read scope permits sample full article',await run(`document.getElementById('api-response-status').textContent.includes('200')&&JSON.parse(document.getElementById('api-response').textContent).data.revision===1`));
 await run(`document.getElementById('api-demo-plan').value='ai';document.getElementById('api-demo-plan').dispatchEvent(new Event('change',{bubbles:true}))`);
 assertion('Changing request context hides prior successful response',await run(`document.getElementById('api-response-panel').hidden`));
 await run(`document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('AI-only key cannot read full paid article',await run(`JSON.parse(document.getElementById('api-response').textContent).error==='membership_required'`));
 await run(`document.getElementById('api-operation').value='ask';document.getElementById('api-operation').dispatchEvent(new Event('change'));document.getElementById('api-demo-plan').value='knowledge';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Knowledges-only key cannot run AI chat',await run(`JSON.parse(document.getElementById('api-response').textContent).error==='membership_required'`));
 await run(`document.getElementById('api-demo-plan').value='ai';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('AI scope and AI plan return explicit sample answer and citations',await run(`JSON.parse(document.getElementById('api-response').textContent).data.usage.demo&&JSON.parse(document.getElementById('api-response').textContent).data.citations.length===1`));
 await run(`document.getElementById('api-demo-limit').value='exceeded';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Quota exhaustion returns structured 429 and Retry-After',await run(`JSON.parse(document.getElementById('api-response').textContent).retry_after_seconds===60&&document.getElementById('api-response-status').textContent.includes('429')`));
 await run(`document.getElementById('api-demo-limit').value='normal';document.getElementById('api-operation').value='checkout';document.getElementById('api-operation').dispatchEvent(new Event('change'));document.getElementById('api-input').value='invalid-plan';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Invalid checkout body returns structured validation error',await run(`JSON.parse(document.getElementById('api-response').textContent).error==='invalid_input'`));
 await run(`document.getElementById('api-input').value='combo';document.getElementById('api-input').dispatchEvent(new Event('input'));document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Checkout example does not pay or change membership',await run(`JSON.parse(document.getElementById('api-response').textContent).data.payment_performed===false&&JSON.parse(document.getElementById('api-response').textContent).data.membership_changed===false`));
 await run(`document.querySelector('[data-api-example="cli"]').click()`);
 assertion('CLI examples are explicitly proposed and use credential variable rather than value',await run(`document.getElementById('api-code').textContent.includes('chưa có trong CLI')&&document.getElementById('api-code').textContent.includes('ZUEY_API_KEY')&&document.getElementById('api-code').textContent.includes('--provider polar')&&!document.getElementById('api-code').textContent.includes('DEMO_ONLY')`));
 await run(`document.querySelector('[data-api-example="mcp"]').click()`);
 assertion('MCP examples supply tool arguments without credential',await run(`document.getElementById('api-code').textContent.includes('create_checkout')&&!document.getElementById('api-code').textContent.includes('DEMO_ONLY')`));
 await run(`document.querySelector('[data-api-example="rest"]').click();document.getElementById('copy-api-example').click()`);await sleep(100);
 assertion('Docs clipboard copies current request with placeholder only',await run(`(async()=>{const text=await navigator.clipboard.readText();return text.includes('$ZUEY_API_KEY')&&!text.includes('DEMO_ONLY');})()`));
 rmSync(join(out,'downloads','zuey-membership-proposed-openapi.json'),{force:true});
 await run(`document.getElementById('download-user-openapi').click()`);await sleep(200);
 assertion('Proposed OpenAPI export is named distinctly from deployed spec',await run(`document.getElementById('api-export-status').textContent.includes('chưa phải spec deployed')`));
 const exportedApi=JSON.parse(readFileSync(join(out,'downloads','zuey-membership-proposed-openapi.json'),'utf8'));
 assertion('OpenAPI download declares real parameter/request/error schemas without credential',exportedApi.openapi==='3.1.0'&&exportedApi.paths['/api/v1/articles/{article_id}'].get.parameters[0].in==='path'&&exportedApi.paths['/api/v1/checkouts'].post.requestBody.content['application/json'].schema.required.includes('provider')&&exportedApi.paths['/api/v1/articles/search'].get.responses['200'].content['application/json'].schema.properties.data.type==='array'&&!JSON.stringify(exportedApi).includes('DEMO_ONLY'));
 await cdp.send('Browser.setPermission',{permission:{name:'clipboard-write'},setting:'denied'});
 await run(`document.getElementById('copy-api-example').click()`);await sleep(100);
 assertion('Docs denied clipboard offers selected placeholder-only manual fallback',await run(`!document.getElementById('api-copy-fallback').hidden&&document.getElementById('api-copy-fallback').selectionEnd===document.getElementById('api-copy-fallback').value.length&&document.getElementById('api-copy-fallback').value.includes('$ZUEY_API_KEY')`));
 await run(`document.querySelector('[data-api-example="mcp"]').click()`);
 assertion('Changing example clears stale clipboard fallback',await run(`document.getElementById('api-copy-fallback').hidden&&document.getElementById('api-copy-fallback').value===''`));
 await cdp.send('Browser.setPermission',{permission:{name:'clipboard-write'},setting:'granted'});
 await run(`document.querySelector('[data-account-section="api-keys"]').click();document.querySelector('.api-key-card[data-key-id="demo-key-02"] [data-key-action="revoke"]').click()`);
 assertion('Revocation confirmation names exact user key',await run(`document.getElementById('key-action-dialog').open&&document.getElementById('key-action-body').textContent.includes('CLI · demo-key-02')`));
 await run(`document.getElementById('cancel-key-action').click()`);await sleep(100);
 assertion('Cancel revocation keeps key active and restores trigger focus',await run(`document.querySelector('.api-key-card[data-key-id="demo-key-02"]').textContent.includes('active')&&document.activeElement.dataset.keyAction==='revoke'`));
 await run(`document.querySelector('.api-key-card[data-key-id="demo-key-02"] [data-key-action="rotate"]').click();document.getElementById('confirm-key-action').click()`);
 assertion('Rotation creates replacement while retaining old key until migration',await run(`document.querySelectorAll('.api-key-card').length===3&&document.querySelector('.api-key-card[data-key-id="demo-key-02"]').textContent.includes('active')&&!document.getElementById('api-key-once').hidden&&document.getElementById('api-key-status').textContent.includes('Key cũ vẫn active')`));
 await run(`document.querySelector('.api-key-card[data-key-id="demo-key-02"] [data-key-action="revoke"]').click();document.getElementById('confirm-key-action').click()`);
 assertion('Targeted revoke leaves other keys active and hides specimen',await run(`document.querySelector('.api-key-card[data-key-id="demo-key-02"]').textContent.includes('revoked')&&document.querySelector('.api-key-card[data-key-id="demo-key-03"]').textContent.includes('active')&&document.getElementById('api-key-specimen').value===''`));
 await run(`document.querySelector('[data-account-section="api-docs"]').click();document.getElementById('api-credential').value='demo-key-02';document.getElementById('api-explorer-form').requestSubmit()`);
 assertion('Revoked credential cannot invoke sandbox endpoint',await run(`JSON.parse(document.getElementById('api-response').textContent).error==='credential_invalid'`));
 for(const [w,h] of [[1440,900],[768,1024],[375,812],[320,812]]){await resize(w,h);await run(`document.getElementById('api-docs-heading').scrollIntoView()`);await sleep(260);assertion(w+'px user docs fit viewport',await run(`document.documentElement.scrollWidth<=innerWidth+1`));await shot('user-api-docs-'+w);await run(`document.querySelector('[data-account-section="api-keys"]').click();document.getElementById('api-keys-heading').scrollIntoView()`);await sleep(260);assertion(w+'px user key management fits viewport',await run(`document.documentElement.scrollWidth<=innerWidth+1`));await shot('user-api-keys-'+w);await run(`document.querySelector('[data-account-section="api-docs"]').click()`);}
 await run(`document.getElementById('account-back').click();document.getElementById('open-command').click();document.getElementById('command-query').value='api keys';document.getElementById('command-query').dispatchEvent(new Event('input'));document.getElementById('command-api-keys').click()`);
 assertion('Command palette discovers key view with heading focus',await run(`!document.querySelector('[data-account-view="api-keys"]').hidden&&document.activeElement.id==='api-keys-heading'`));
 await run(`document.getElementById('account-back').click()`);


 // Public topic tags are visible to free readers and never alter membership.
 await run(`document.getElementById('free').click()`);
 assertion('Free readers see public tags on article and all sample rows',await run(`document.querySelectorAll('.post-tags').length===15&&document.getElementById('article-public-tags').textContent.includes('#AI')&&[...document.querySelectorAll('.post-tags')].every(tags=>tags.children.length===2)`));
 await run(`document.querySelector('.public-tag-editor').open=true;document.getElementById('public-tags-input').value='Agents, Workflow, Agents';document.getElementById('public-tag-form').requestSubmit()`);
 assertion('Tag editor deduplicates and publishes tags on sample reader/list',await run(`document.getElementById('article-public-tags').children.length===2&&document.getElementById('article-public-tags').textContent.includes('#Agents')&&document.querySelector('.post-card[data-order="3"][data-locale="vi"] .post-tags').textContent.includes('#Agents')&&document.getElementById('public-tags-status').textContent.includes('chưa lưu API/MCP')`));
 await run(`document.getElementById('search').value='Agents';document.getElementById('search').dispatchEvent(new Event('input'))`);
 assertion('Search finds public tag text without changing entitlement',await run(`[...document.querySelectorAll('.post-card')].filter(card=>!card.hidden).length===1&&document.getElementById('member').getAttribute('aria-pressed')==='false'&&document.getElementById('full-content').hidden`));
 await run(`document.getElementById('clear-filters').click();document.getElementById('public-tags-input').value='<img src=x onerror=alert(1)>';document.getElementById('public-tag-form').requestSubmit()`);
 assertion('Invalid tag input is rejected without unsafe markup or metadata change',await run(`document.getElementById('public-tags-status').textContent.includes('tối đa')&&document.getElementById('article-public-tags').textContent.includes('#Agents')&&!document.getElementById('article-public-tags').querySelector('img')`));
 await run(`document.getElementById('open-markdown').click()`);
 assertion('Public Markdown contains tags while free reader remains preview-only',await run(`document.getElementById('markdown-content').textContent.includes('Public tags: #Agents')&&document.getElementById('markdown-content').textContent.includes('Bản preview công khai')&&!document.getElementById('markdown-content').textContent.includes('## Nội dung sau paywall')`));
 await run(`document.getElementById('close-share').click();document.getElementById('public-tags-input').value='AI, Mindset';document.getElementById('public-tag-form').requestSubmit()`);

 assertion('Initial and offline interactions: zero external HTTP requests',requests.length===0,requests);
 // Only this explicit refresh phase accesses the real public API, without mocking.
 await run(`document.getElementById('refresh-github').click()`);
 for(let i=0;i<65;i++){if(!await run(`document.getElementById('refresh-github').disabled`))break;await sleep(200);}
 const liveStatus=await run(`document.getElementById('github-status').textContent`);
 assertion('Real public GitHub refresh succeeds',liveStatus.startsWith('Dữ liệu public')&&requests.some(url=>url.startsWith('https://api.github.com/users/mrgoonie/events/public')),liveStatus);
 const retained=await run(`document.getElementById('github-count').textContent`);
 await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await run(`document.getElementById('refresh-github').click()`);await sleep(250);
 assertion('Actual offline GitHub failure retains valid graph and gives retry status',await run(`document.getElementById('github-count').textContent` )===retained&&await run(`document.getElementById('github-status').textContent.includes('Giữ dữ liệu')&&!document.getElementById('refresh-github').disabled`),await run(`({status:document.getElementById('github-status').textContent,disabled:document.getElementById('refresh-github').disabled})`));
 await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 assertion('Network is confined to intentionally refreshed public GitHub endpoint',requests.every(url=>url.startsWith('https://api.github.com/users/mrgoonie/events/public')),requests);
 assertion('No runtime exceptions',errors.length===0,errors);

} catch(error){errors.push(error.message);assertion('Harness completes',false,error.message);}finally{
 writeFileSync(join(out,'interaction-report.json'),JSON.stringify({results,errors,requests},null,2));
 console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,total:results.length,failed:results.filter(x=>!x.pass)},null,2));
 if(cdp){try{await Promise.race([cdp.send('Browser.close'),sleep(1500)]);}catch{}cdp.close();}browser?.proc.kill('SIGTERM');await sleep(500);rmSync(profile,{recursive:true,force:true});
}
