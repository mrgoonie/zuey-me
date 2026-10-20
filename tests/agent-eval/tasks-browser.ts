import type { BrowserTask } from './lib/types';

/** Checklist for a browser-driving agent (desktop 1280x800 unless noted). Not automatable by the runners. */
const t = (id: string, prompt: string, steps: string[], expected: string[]): BrowserTask => ({ id, lane: 'browser', prompt, steps, expected });

export const BROWSER_TASKS: BrowserTask[] = [
  t('browser-open-pricing', 'Open the Pricing app from the home page and report the monthly price of the Combo plan.',
    ['Open BASE/', 'Open the Pricing app from the dock or desktop'], ['A Pricing window is visible', 'The Combo (Kết hợp) plan price is read as $19/month']),
  t('browser-open-zueytube', 'Open Zueytube and report the title of the first video.',
    ['Open BASE/', 'Open the Zueytube app'], ['A Zueytube window is visible', 'The first video title is reported']),
  t('browser-deeplink-pricing', 'Open BASE/#pricing and confirm the Pricing app opens automatically.',
    ['Navigate to BASE/#pricing'], ['The Pricing window opens without any click']),
  t('browser-standalone-pricing', 'Open BASE/pricing and confirm it is a normal page with the plans.',
    ['Navigate to BASE/pricing'], ['A page listing the four plans is shown']),
  t('browser-latest-article', 'Open the Knowledges app and report the title of the newest article.',
    ['Open BASE/', 'Open the Knowledges app'], ['An article list is visible', 'The newest article title is reported']),
  t('browser-read-article', 'Open the newest article and report its first heading.',
    ['Open the Knowledges app', 'Click the first article'], ['The article body is rendered', 'The first heading is reported']),
  t('browser-find-mcp', 'Find the MCP endpoint URL using the UI only.',
    ['Open BASE/', 'Open the MCP app (or docs)'], ['The text https://zuey.me/mcp or /api/mcp is shown']),
  t('browser-open-github', 'Open the GitHub app and report the most recent activity item.',
    ['Open BASE/', 'Open the GitHub app'], ['The GitHub window shows recent activity', 'One item is reported']),
  t('browser-change-appearance', 'Open Appearance and switch to a different theme; confirm the desktop changes.',
    ['Open BASE/', 'Open Appearance', 'Pick another theme'], ['The desktop colours/wallpaper visibly change']),
  t('browser-window-management', 'Open two apps, drag one window, minimise/close the other.',
    ['Open About and Reads', 'Drag the About title bar', 'Close the Reads window'], ['About moved', 'Reads is gone']),
  t('browser-mobile-layout', 'At 390x844, open BASE/ and open the Pricing app; confirm it is usable without horizontal scroll.',
    ['Resize to 390x844', 'Open BASE/', 'Open Pricing'], ['No horizontal page scroll', 'Plans are readable']),
  t('browser-keyboard-nav', 'Using only the keyboard, open the Reads app (Alt+4) and close it with Escape.',
    ['Open BASE/', 'Press Alt+4', 'Press Escape'], ['Reads opens', 'Reads closes']),
];
