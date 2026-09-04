#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const CONFIG_DIR = path.join(os.homedir(), '.zuey');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {
    apiUrl: process.env.ZUEY_API_URL || 'https://zuey.me',
    apiKey: process.env.ZUEY_API_KEY || '',
  };
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

async function requestApi(endpoint, method = 'GET', body = null) {
  const config = loadConfig();
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const url = `${config.apiUrl.replace(/\/$/, '')}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
  }
  return data;
}

function printHelp() {
  console.log(`
Zuey.me CLI — Manage Duy Nguyen /zuey/ profile, links, themes & MCP server

USAGE:
  zuey <command> [options]

COMMANDS:
  login --key <API_KEY> [--url <URL>]   Save API key credentials
  profile view                         Inspect active profile & bio
  profile update [options]             Update profile name, intro, avatar
  links list [--section <name>]        List link cards by section
  links add [options]                  Add a new link card
  links update <id> [options]          Update an existing link card
  links delete <id>                    Remove a link card
  links reorder <id1> <id2> ...        Reorder sequence of links
  theme view                           View current theme preset
  theme set <name>                     Switch theme (ivory | dark | minimal | glass)
  mcp                                  Start standard input/output (STDIO) MCP server

OPTIONS:
  --help, -h                           Show this help message
  --version, -v                        Show version
`);
}

async function startStdioMcp() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const rpcReq = JSON.parse(line);
      const res = await requestApi('/api/mcp', 'POST', rpcReq);
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message },
        id: null,
      }) + '\n');
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const cmd = args[0];

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log('zuey-cli v1.0.0');
    return;
  }

  if (cmd === 'login') {
    const keyIdx = args.indexOf('--key');
    const urlIdx = args.indexOf('--url');
    if (keyIdx === -1 || !args[keyIdx + 1]) {
      console.error('Error: --key <API_KEY> is required.');
      process.exit(1);
    }
    const apiKey = args[keyIdx + 1];
    const apiUrl = urlIdx !== -1 ? args[urlIdx + 1] : (process.env.ZUEY_API_URL || 'https://zuey.me');
    saveConfig({ apiKey, apiUrl });
    console.log('✓ Successfully logged in to Zuey.me API!');
    console.log(`Config saved to: ${CONFIG_FILE}`);
    return;
  }

  if (cmd === 'mcp') {
    await startStdioMcp();
    return;
  }

  if (cmd === 'profile') {
    const sub = args[1] || 'view';
    if (sub === 'view') {
      const res = await requestApi('/api/v1/profile');
      console.log('\n--- ZUEY.ME PROFILE ---');
      console.log(`Name:   ${res.data.name} (${res.data.handle})`);
      console.log(`Email:  ${res.data.email}`);
      console.log(`Avatar: ${res.data.avatar_url}`);
      console.log(`Theme:  ${res.data.theme}`);
      console.log(`Bio EN: ${res.data.intro_en}`);
      console.log(`Bio VI: ${res.data.intro_vi}\n`);
      return;
    }

    if (sub === 'update') {
      const updates = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--name' && args[i + 1]) updates.name = args[++i];
        if (args[i] === '--intro-en' && args[i + 1]) updates.intro_en = args[++i];
        if (args[i] === '--intro-vi' && args[i + 1]) updates.intro_vi = args[++i];
        if (args[i] === '--avatar' && args[i + 1]) updates.avatar_url = args[++i];
        if (args[i] === '--theme' && args[i + 1]) updates.theme = args[++i];
      }
      const res = await requestApi('/api/v1/profile', 'PUT', updates);
      console.log('✓ Profile updated successfully:', res.data.name);
      return;
    }
  }

  if (cmd === 'links') {
    const sub = args[1] || 'list';
    if (sub === 'list') {
      const res = await requestApi('/api/v1/links');
      const secIdx = args.indexOf('--section');
      const targetSec = secIdx !== -1 ? args[secIdx + 1] : null;
      const list = targetSec ? res.data.filter(l => l.section === targetSec) : res.data;

      console.log(`\n--- LINKS (${list.length}) ---`);
      list.forEach((l, idx) => {
        console.log(`[${idx + 1}] (${l.section.toUpperCase()}) ${l.title_en}`);
        console.log(`    ID:   ${l.id}`);
        console.log(`    URL:  ${l.url}`);
        if (l.subtitle_en) console.log(`    Desc: ${l.subtitle_en}`);
      });
      console.log();
      return;
    }

    if (sub === 'add') {
      const item = { section: 'products', title_en: '', url: '', subtitle_en: '', title_vi: '', icon: '' };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--section' && args[i + 1]) item.section = args[++i];
        if (args[i] === '--title' && args[i + 1]) item.title_en = args[++i];
        if (args[i] === '--title-vi' && args[i + 1]) item.title_vi = args[++i];
        if (args[i] === '--url' && args[i + 1]) item.url = args[++i];
        if (args[i] === '--subtitle' && args[i + 1]) item.subtitle_en = args[++i];
        if (args[i] === '--icon' && args[i + 1]) item.icon = args[++i];
      }
      if (!item.title_en || !item.url) {
        console.error('Error: --title and --url are required.');
        process.exit(1);
      }
      const res = await requestApi('/api/v1/links', 'POST', item);
      console.log('✓ Link card created:', res.data.id, `(${res.data.title_en})`);
      return;
    }

    if (sub === 'delete') {
      const id = args[2];
      if (!id) {
        console.error('Error: Link ID required.');
        process.exit(1);
      }
      await requestApi(`/api/v1/links/${id}`, 'DELETE');
      console.log('✓ Link card deleted successfully:', id);
      return;
    }

    if (sub === 'reorder') {
      const orderIds = args.slice(2);
      if (orderIds.length === 0) {
        console.error('Error: Please provide link IDs in desired order.');
        process.exit(1);
      }
      await requestApi('/api/v1/links/reorder', 'POST', { order: orderIds });
      console.log('✓ Links reordered successfully.');
      return;
    }
  }

  if (cmd === 'theme') {
    const sub = args[1] || 'view';
    if (sub === 'view') {
      const res = await requestApi('/api/v1/theme');
      console.log(`Current theme: ${res.data.theme}`);
      return;
    }
    if (sub === 'set') {
      const theme = args[2];
      if (!theme) {
        console.error('Error: Theme name required (ivory | dark | minimal | glass)');
        process.exit(1);
      }
      await requestApi('/api/v1/theme', 'PUT', { theme });
      console.log(`✓ Theme changed to: ${theme}`);
      return;
    }
  }

  console.error(`Unknown command: ${cmd}. Run "zuey --help" for available commands.`);
  process.exit(1);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
