import { describe, it, expect } from 'bun:test';
import { readingMinutes, wordCount } from '../src/lib/search/text';

describe('reading time', () => {
  it('counts Latin words one each', () => {
    expect(wordCount('Xin chào, đây là **bài** viết 2026.')).toBe(7);
  });

  it('weighs CJK characters as half a word', () => {
    expect(wordCount('什么是图工程')).toBe(3);
    expect(wordCount('그래프 엔지니어링')).toBe(4);
    expect(wordCount('Graph Engineeringとは')).toBe(3);
  });

  it('gives a CJK translation about the same minutes as its source', () => {
    const vi = readingMinutes(wordCount('từ '.repeat(4400)));
    const ja = readingMinutes(wordCount('語'.repeat(8800)));
    expect(vi).toBe(20);
    expect(ja).toBe(20);
  });
});
