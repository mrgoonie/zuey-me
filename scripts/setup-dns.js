import fs from 'node:fs';
import path from 'node:path';

// Parse .env securely without echoing secrets
function loadEnv() {
  const envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env file not found');
  }
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.substring(0, eqIdx).trim();
      let val = trimmed.substring(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.substring(1, val.length - 1);
      }
      env[key] = val;
    }
  }
  return env;
}

async function cfFetch(endpoint, method = 'GET', body = null, token) {
  const url = `https://api.cloudflare.com/client/v4${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`Cloudflare API Error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

async function main() {
  const env = loadEnv();
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error('CLOUDFLARE_API_TOKEN is missing in .env');
  }

  console.log('1. Locating Cloudflare Zone for zuey.me...');
  const zoneData = await cfFetch('/zones?name=zuey.me', 'GET', null, token);
  if (!zoneData.result || zoneData.result.length === 0) {
    throw new Error('Zone zuey.me not found with the provided token.');
  }
  const zone = zoneData.result[0];
  console.log(`✓ Found Zone: ${zone.name} (Status: ${zone.status})`);

  console.log('2. Inspecting Page Rules & Redirect Rules...');
  // Check Page Rules
  try {
    const pageRules = await cfFetch(`/zones/${zone.id}/pagerules`, 'GET', null, token);
    console.log(`Found ${pageRules.result.length} Page Rules.`);
    for (const rule of pageRules.result) {
      const isSubstack = JSON.stringify(rule).includes('substack');
      if (isSubstack) {
        console.log(`Disabling Substack redirect page rule: ${rule.id}...`);
        await cfFetch(`/zones/${zone.id}/pagerules/${rule.id}`, 'PATCH', { status: 'disabled' }, token);
        console.log(`✓ Page rule ${rule.id} disabled.`);
      }
    }
  } catch (err) {
    console.log('Page rules check note:', err.message);
  }

  // Check Rulesets (Single Redirects / Redirect Rules)
  try {
    const rulesets = await cfFetch(`/zones/${zone.id}/rulesets`, 'GET', null, token);
    for (const rs of rulesets.result) {
      if (rs.phase === 'http_request_dynamic_redirect') {
        const fullRs = await cfFetch(`/zones/${zone.id}/rulesets/${rs.id}`, 'GET', null, token);
        const rules = fullRs.result.rules || [];
        const filtered = rules.filter(r => !JSON.stringify(r).includes('substack'));
        if (filtered.length !== rules.length) {
          console.log(`Updating redirect ruleset ${rs.id} to remove Substack redirect...`);
          await cfFetch(`/zones/${zone.id}/rulesets/${rs.id}`, 'PUT', { rules: filtered }, token);
          console.log(`✓ Redirect ruleset updated.`);
        }
      }
    }
  } catch (err) {
    console.log('Redirect rulesets note:', err.message);
  }

  console.log('3. Inspecting DNS Records for zuey.me...');
  const dnsData = await cfFetch(`/zones/${zone.id}/dns_records?name=zuey.me`, 'GET', null, token);
  const records = dnsData.result || [];
  console.log(`Current DNS records for zuey.me count: ${records.length}`);

  let rootCname = records.find(r => r.type === 'CNAME' && r.name === 'zuey.me');
  let rootA = records.find(r => r.type === 'A' && r.name === 'zuey.me');

  if (rootA) {
    console.log(`Deleting existing A record (${rootA.id})...`);
    await cfFetch(`/zones/${zone.id}/dns_records/${rootA.id}`, 'DELETE', null, token);
    console.log('✓ Existing A record deleted.');
  }

  if (rootCname) {
    console.log(`Updating existing CNAME record (${rootCname.id}) to zuey-me.pages.dev...`);
    await cfFetch(`/zones/${zone.id}/dns_records/${rootCname.id}`, 'PUT', {
      type: 'CNAME',
      name: 'zuey.me',
      content: 'zuey-me.pages.dev',
      proxied: true,
      ttl: 1,
    }, token);
    console.log('✓ CNAME record updated to zuey-me.pages.dev (proxied).');
  } else {
    console.log('Creating new CNAME record for zuey.me -> zuey-me.pages.dev...');
    await cfFetch(`/zones/${zone.id}/dns_records`, 'POST', {
      type: 'CNAME',
      name: 'zuey.me',
      content: 'zuey-me.pages.dev',
      proxied: true,
      ttl: 1,
    }, token);
    console.log('✓ CNAME record created for zuey.me -> zuey-me.pages.dev (proxied).');
  }

  // Also ensure www.zuey.me CNAME exists
  const wwwDns = await cfFetch(`/zones/${zone.id}/dns_records?name=www.zuey.me`, 'GET', null, token);
  const wwwRec = (wwwDns.result || [])[0];
  if (wwwRec) {
    console.log('Updating www.zuey.me CNAME to zuey-me.pages.dev...');
    await cfFetch(`/zones/${zone.id}/dns_records/${wwwRec.id}`, 'PUT', {
      type: 'CNAME',
      name: 'www.zuey.me',
      content: 'zuey-me.pages.dev',
      proxied: true,
      ttl: 1,
    }, token);
  } else {
    console.log('Creating www.zuey.me CNAME to zuey-me.pages.dev...');
    await cfFetch(`/zones/${zone.id}/dns_records`, 'POST', {
      type: 'CNAME',
      name: 'www.zuey.me',
      content: 'zuey-me.pages.dev',
      proxied: true,
      ttl: 1,
    }, token);
  }

  console.log('4. Purging Cloudflare Cache for zuey.me...');
  try {
    await cfFetch(`/zones/${zone.id}/purge_cache`, 'POST', { purge_everything: true }, token);
    console.log('✓ Cache purged successfully.');
  } catch (err) {
    console.log('Purge cache note:', err.message);
  }

  console.log('\n✨ DNS Configuration Completed Successfully!');
}

main().catch(err => {
  console.error('Failed to configure DNS:', err.message);
  process.exit(1);
});
