/** Browser lane: prints the checklist for a browser-driving agent. `bun run agent-eval:browser [--base URL] [--json template.json]`. */
import { writeFileSync } from 'node:fs';
import { parseArgs } from './lib/cli';
import { BROWSER_TASKS } from './tasks-browser';

const { base, json } = parseArgs(process.argv.slice(2));
const sub = (s: string) => s.replaceAll('BASE', base);

console.log(`# Browser agent checklist @ ${base}\n`);
for (const t of BROWSER_TASKS) {
  console.log(`## ${t.id}\nPrompt: ${sub(t.prompt)}\nSteps:\n${t.steps.map((s) => `  - ${sub(s)}`).join('\n')}\nExpected:\n${t.expected.map((e) => `  - [ ] ${sub(e)}`).join('\n')}\n`);
}
const template = { lane: 'browser', base, agent: '', signedIn: null, results: BROWSER_TASKS.map((t) => ({ id: t.id, passed: null, deviation: '', reason: '' })) };
console.log('## Results template (record model, whether signed in, and any deviation from the steps)');
console.log(JSON.stringify(template, null, 2));
if (json) writeFileSync(json, JSON.stringify(template, null, 2));
