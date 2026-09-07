import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function loadEnv() {
  const envPath = path.resolve('.env');
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

const env = loadEnv();
const secretsToSet = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

for (const secretName of secretsToSet) {
  const val = env[secretName];
  if (!val) {
    console.log(`- Skipping ${secretName}: not found in .env`);
    continue;
  }

  console.log(`Setting Cloudflare Pages secret: ${secretName}...`);
  const proc = spawnSync('wrangler', [
    'pages',
    'secret',
    'put',
    secretName,
    '--project-name=zuey-me',
  ], {
    input: val + '\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: '7ac87c90789159ae1b10b7d78f5dcc08',
      CLOUDFLARE_API_TOKEN: '',
    },
  });

  if (proc.status === 0) {
    console.log(`✓ Successfully set ${secretName}`);
  } else {
    console.warn(`! Output for ${secretName}:`, proc.stdout?.trim() || proc.stderr?.trim());
  }
}
