import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { BlockRenderer } from '../src/components/blocks/BlockRenderer';
import { embedFrame, embedFromPastedText, embedResizeHeight, embedSrc, recognizeEmbed } from '../src/lib/blocks/embed';
import { documentToMarkdown } from '../src/lib/blocks/markdown';
import { validateDocument } from '../src/lib/blocks/validate';
import type { Block, EmbedProvider } from '../src/lib/blocks/schema';

const embedViewSource = readFileSync(new URL('../src/components/blocks/EmbedView.tsx', import.meta.url), 'utf8');

function render(blocks: Block[], autoLoadEmbeds?: boolean): string {
  return renderToString(createElement(BlockRenderer, { doc: { version: 1, blocks }, autoLoadEmbeds }));
}

function embed(url: string, provider: EmbedProvider, caption?: string): Block {
  return { id: 'e1', type: 'embed', url, provider, ...(caption ? { caption } : {}) };
}

describe('provider resolver: common social URL shapes', () => {
  const cases: Array<[string, EmbedProvider, string | null]> = [
    ['https://x.com/someone/status/1234567890123?s=20', 'x', 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123&dnt=true'],
    ['https://mobile.twitter.com/someone/status/1234567890123', 'x', 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123&dnt=true'],
    ['https://x.com/someone', 'x', null],
    ['https://www.facebook.com/reel/1234567890', 'facebook', 'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F1234567890'],
    // Share short links are redirects the plugins are not documented to follow: rendered as a link card.
    ['https://www.facebook.com/share/r/AbCdEf123/', 'facebook', null],
    ['https://www.facebook.com/share/v/AbCdEf123/', 'facebook', null],
    ['https://www.facebook.com/share/p/AbCdEf123/', 'facebook', null],
    ['https://www.facebook.com/share/AbCdEf123/', 'facebook', null],
    ['https://www.facebook.com/watch/?v=1234567890', 'facebook', 'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D1234567890'],
    ['https://www.instagram.com/reel/C0deAbc123/', 'instagram', 'https://www.instagram.com/reel/C0deAbc123/embed'],
    ['https://www.instagram.com/reels/C0deAbc123/', 'instagram', 'https://www.instagram.com/reel/C0deAbc123/embed'],
    ['https://www.instagram.com/someone/p/C0deAbc123/', 'instagram', 'https://www.instagram.com/p/C0deAbc123/embed'],
    ['https://www.instagram.com/explore/tags/p/C0deAbc123/', 'instagram', null],
  ];
  for (const [url, provider, src] of cases) {
    it(`${provider}: ${url}`, () => {
      const rec = recognizeEmbed(url);
      expect(rec.provider).toBe(provider);
      expect(rec.src).toBe(src);
    });
  }

  it('reserves a frame shape that fits each provider', () => {
    expect(embedFrame('x', 'https://x.com/a/status/1')).toBe('post');
    expect(embedFrame('instagram', 'https://www.instagram.com/p/abc/')).toBe('post');
    expect(embedFrame('facebook', 'https://www.facebook.com/a/posts/1')).toBe('post');
    expect(embedFrame('facebook', 'https://www.facebook.com/a/videos/1')).toBe('video');
    expect(embedFrame('facebook', 'https://www.facebook.com/reel/1')).toBe('vertical');
    expect(embedFrame('tiktok', 'https://www.tiktok.com/@a/video/1')).toBe('vertical');
    expect(embedFrame('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('video');
  });
});

describe('a stored provider never frames a host it does not own', () => {
  const mismatches: Array<[string, EmbedProvider]> = [
    ['https://example.com/embed/x', 'linkedin'],
    ['https://example.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://evil.example/status/1234567890123', 'x'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'vimeo'],
    ['https://x.com/someone/status/1234567890123', 'facebook'],
  ];
  for (const [url, provider] of mismatches) {
    it(`${provider} override on ${url} gives no iframe`, () => {
      expect(embedSrc(url, provider)).toBeNull();
      const html = render([embed(url, provider)]);
      expect(html).not.toContain('zb-embed-frame');
      expect(html).toContain('zb-embed-fallback');
    });
  }

  it('passes LinkedIn embed URLs through only from www.linkedin.com, on a fixed origin', () => {
    expect(embedSrc('https://www.linkedin.com/embed/feed/update/urn:li:share:123?x=1', 'linkedin'))
      .toBe('https://www.linkedin.com/embed/feed/update/urn:li:share:123');
    expect(embedSrc('https://evil.linkedin.com/embed/feed/update/urn:li:share:123', 'linkedin')).toBeNull();
    expect(embedSrc('https://linkedin.com/feed/update/urn:li:activity:456', 'linkedin'))
      .toBe('https://www.linkedin.com/embed/feed/update/urn:li:activity:456');
  });

  it('rejects a conflicting provider at validation with a clear error', () => {
    const res = validateDocument({ version: 1, blocks: [{ id: 'e1', type: 'embed', url: 'https://example.com/embed/x', provider: 'linkedin' }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].path).toEndWith('.provider');
    expect(res.errors[0].message).toContain('does not match the URL host (detected "generic")');
  });

  it('accepts the detected provider and a downgrade to a plain link', () => {
    const url = 'https://x.com/someone/status/1234567890123';
    for (const provider of ['x', 'generic']) {
      const res = validateDocument({ version: 1, blocks: [{ id: 'e1', type: 'embed', url, provider }] });
      expect(res.ok).toBe(true);
    }
  });
});

describe('pasted links become native embed blocks', () => {
  it('recognises a bare supported URL and keeps it verbatim', () => {
    expect(embedFromPastedText('  https://x.com/someone/status/1234567890123\n')).toEqual({ url: 'https://x.com/someone/status/1234567890123', provider: 'x' });
    expect(embedFromPastedText('https://www.instagram.com/p/C0deAbc123/')).toEqual({ url: 'https://www.instagram.com/p/C0deAbc123/', provider: 'instagram' });
    expect(embedFromPastedText('https://www.facebook.com/someone/posts/abc')?.provider).toBe('facebook');
  });

  it('leaves prose, generic, insecure and non-embeddable links alone', () => {
    expect(embedFromPastedText('xem https://x.com/someone/status/1234567890123')).toBeNull();
    expect(embedFromPastedText('https://example.com/post')).toBeNull();
    expect(embedFromPastedText('http://x.com/someone/status/1234567890123')).toBeNull();
    expect(embedFromPastedText('https://x.com/someone')).toBeNull();
    expect(embedFromPastedText('')).toBeNull();
  });

  it('stores the original URL so Markdown/API output keeps its shape', () => {
    const url = 'https://x.com/someone/status/1234567890123';
    const res = validateDocument({ version: 1, blocks: [{ type: 'embed', url }] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [block] = res.doc.blocks;
    expect(block).toMatchObject({ type: 'embed', url, provider: 'x' });
    expect(documentToMarkdown(res.doc)).toContain(url);
  });
});

describe('height messages from embedded posts', () => {
  const xMessage = { 'twttr.embed': { method: 'twttr.private.resize', params: [{ width: 550, height: 612.4 }] } };

  it('accepts X resize messages from platform.twitter.com (object or JSON string)', () => {
    expect(embedResizeHeight('x', 'https://platform.twitter.com', xMessage)).toBe(613);
    expect(embedResizeHeight('x', 'https://platform.twitter.com', JSON.stringify(xMessage))).toBe(613);
  });

  it('accepts Instagram MEASURE messages from www.instagram.com', () => {
    expect(embedResizeHeight('instagram', 'https://www.instagram.com', JSON.stringify({ type: 'MEASURE', details: { height: 734 } }))).toBe(734);
  });

  it('ignores other origins, providers, shapes and junk', () => {
    expect(embedResizeHeight('x', 'https://evil.example', xMessage)).toBeNull();
    expect(embedResizeHeight('instagram', 'https://platform.twitter.com', xMessage)).toBeNull();
    expect(embedResizeHeight('facebook', 'https://www.facebook.com', { height: 500 })).toBeNull();
    expect(embedResizeHeight('x', 'https://platform.twitter.com', '{not json')).toBeNull();
    expect(embedResizeHeight('x', 'https://platform.twitter.com', { 'twttr.embed': { method: 'other', params: [{ height: 400 }] } })).toBeNull();
    expect(embedResizeHeight('instagram', 'https://www.instagram.com', { type: 'MEASURE', details: { height: -5 } })).toBeNull();
  });

  it('clamps announced heights', () => {
    expect(embedResizeHeight('instagram', 'https://www.instagram.com', { type: 'MEASURE', details: { height: 10 } })).toBe(120);
    expect(embedResizeHeight('instagram', 'https://www.instagram.com', { type: 'MEASURE', details: { height: 99999 } })).toBe(2400);
  });
});

describe('embed rendering', () => {
  it('server-renders a centred, provider-sized placeholder without contacting the provider', () => {
    const html = render([embed('https://x.com/someone/status/1234567890123', 'x', 'Bài đăng gốc')]);
    expect(html).toContain('class="zb-figure zb-embed zb-embed-post zb-embed-x"');
    expect(html).toContain('class="zb-embed-frame zb-ratio-post"');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('platform.twitter.com');
    // Without JavaScript nothing will load, so the server markup promises nothing and offers the original post.
    expect(html).not.toContain('sẽ tự tải khi bạn cuộn tới');
    expect(html).toMatch(/<noscript>[^]*cần JavaScript[^]*href="https:\/\/x\.com\/someone\/status\/1234567890123"[^]*<\/noscript>/);
    expect(html).toContain('<figcaption>Bài đăng gốc</figcaption>');
    expect(html).toContain('<a href="https://x.com/someone/status/1234567890123" target="_blank" rel="noopener noreferrer nofollow">Mở bài gốc trên <!-- -->X</a>');
  });

  it('keeps editor previews click-to-load', () => {
    const html = render([embed('https://www.instagram.com/p/C0deAbc123/', 'instagram')], false);
    expect(html).toContain('zb-embed-instagram');
    expect(html).toContain('<button type="button" class="zb-btn">Tải nội dung từ <!-- -->Instagram</button>');
    expect(html).not.toContain('thiết bị này');
  });

  it('renders the per-device opt-out from the first paint, disabled until hydrated (no line shift)', () => {
    const html = render([embed('https://x.com/someone/status/1234567890123', 'x')]);
    expect(html).toContain('<button type="button" class="zb-embed-link-btn" disabled="">Không tự tải nội dung nhúng trên thiết bị này</button>');
  });

  it('falls back to a plain link for unsupported URLs and Facebook share links', () => {
    const html = render([embed('https://example.com/post', 'generic', 'Nguồn')]);
    expect(html).toContain('zb-embed-fallback');
    expect(html).toContain('href="https://example.com/post"');
    expect(html).not.toContain('zb-embed-frame');
    expect(html).toContain('<figcaption>Nguồn</figcaption>');
    const share = render([embed('https://www.facebook.com/share/r/AbCdEf123/', 'facebook')]);
    expect(share).toContain('zb-embed-fallback');
    expect(share).toContain('href="https://www.facebook.com/share/r/AbCdEf123/"');
    expect(share).not.toContain('zb-embed-frame');
  });

  it('renders video providers full width and Facebook reels as vertical frames', () => {
    expect(render([embed('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube')])).toContain('zb-embed zb-embed-video zb-embed-youtube');
    expect(render([embed('https://www.facebook.com/reel/1234567890', 'facebook')])).toContain('zb-embed zb-embed-vertical zb-embed-facebook');
  });

  it('keeps the iframe sandbox to the flags embeds need (no top navigation, forms or modals)', () => {
    const sandboxes = [...embedViewSource.matchAll(/sandbox="([^"]*)"/g)].map(m => m[1]);
    expect(sandboxes).toEqual(['allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation']);
    expect(embedViewSource).toContain('referrerPolicy="strict-origin-when-cross-origin"');
  });
});
