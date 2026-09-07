import { initialProfile, initialLinks } from '../src/db/data';
import fs from 'node:fs';

let sql = `-- Seed initial profile\n`;
sql += `INSERT INTO profiles (id, name, handle, email, avatar_url, intro_en, intro_vi, theme)\n`;
sql += `VALUES (\n`;
sql += `  '${initialProfile.id}',\n`;
sql += `  '${initialProfile.name.replace(/'/g, "''")}',\n`;
sql += `  '${initialProfile.handle}',\n`;
sql += `  '${initialProfile.email}',\n`;
sql += `  '${initialProfile.avatar_url}',\n`;
sql += `  '${initialProfile.intro_en.replace(/'/g, "''")}',\n`;
sql += `  '${initialProfile.intro_vi.replace(/'/g, "''")}',\n`;
sql += `  '${initialProfile.theme}'\n`;
sql += `) ON CONFLICT(id) DO UPDATE SET\n`;
sql += `  name = excluded.name,\n`;
sql += `  intro_en = excluded.intro_en,\n`;
sql += `  intro_vi = excluded.intro_vi;\n\n`;

sql += `-- Seed initial links\n`;
for (const link of initialLinks) {
  sql += `INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)\n`;
  sql += `VALUES (\n`;
  sql += `  '${link.id}',\n`;
  sql += `  '${link.section}',\n`;
  sql += `  '${link.title_en.replace(/'/g, "''")}',\n`;
  sql += `  '${link.title_vi.replace(/'/g, "''")}',\n`;
  sql += `  ${link.subtitle_en ? `'${link.subtitle_en.replace(/'/g, "''")}'` : 'NULL'},\n`;
  sql += `  ${link.subtitle_vi ? `'${link.subtitle_vi.replace(/'/g, "''")}'` : 'NULL'},\n`;
  sql += `  '${link.url.replace(/'/g, "''")}',\n`;
  sql += `  ${link.icon ? `'${link.icon}'` : 'NULL'},\n`;
  sql += `  ${link.order_index},\n`;
  sql += `  ${link.is_active ? 1 : 0},\n`;
  sql += `  ${link.click_count || 0}\n`;
  sql += `) ON CONFLICT(id) DO NOTHING;\n\n`;
}

fs.writeFileSync('scripts/seed.sql', sql, 'utf8');
console.log('✓ Generated scripts/seed.sql');
