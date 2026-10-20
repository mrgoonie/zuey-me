import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandIcon } from '../src/components/BrandIcons';

describe('About product icon badges', () => {
  const products = [
    ['cloud', 'Cloud Harness MCP'],
    ['vault', 'AK Vault'],
    ['render', 'AK Render'],
    ['multix', 'Multix'],
    ['anymd', 'AnyMD'],
    ['motion', 'Motion MCP'],
  ] as const;

  it.each(products)('%s has a distinct SVG icon instead of the initials fallback', (name, label) => {
    const html = renderToStaticMarkup(<BrandIcon name={name} />);
    expect(html).toContain('<svg');
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('text-stone-700');
  });
});
