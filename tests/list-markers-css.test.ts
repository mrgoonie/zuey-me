import { describe, expect, it } from 'bun:test';

// Tailwind Preflight sets ul/ol to `list-style: none`, and happy-dom has no cascade or layout,
// so this guards the stylesheet itself: the block list must restore its own markers.
describe('block list markers', async () => {
  const css = await Bun.file(new URL('../src/styles/blocks.css', import.meta.url)).text();
  const global = await Bun.file(new URL('../src/styles/global.css', import.meta.url)).text();

  it('still sits under Preflight, which is why markers must be restored', () => {
    expect(global).toContain('@tailwind base;');
  });

  it('restores bullet and decimal markers on the list block', () => {
    expect(css).toMatch(/ul\.zb-list \{[^}]*list-style-type: disc;/);
    expect(css).toMatch(/ol\.zb-list \{[^}]*list-style-type: decimal;/);
  });

  it('keeps the checklist free of a second marker', () => {
    expect(css).toMatch(/\.zb-checklist \{ list-style: none;/);
  });
});
