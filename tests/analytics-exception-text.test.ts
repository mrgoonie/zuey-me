import { describe, expect, test } from 'bun:test';
import {
  MAX_EXCEPTION_TEXT_LENGTH, enterSensitiveSurface, hardenExceptionProperties, scrubCaptureResult,
} from '../src/lib/analytics/destinations/posthog';
import { REDACTED } from '../src/lib/analytics/pii';

const CHAT = 'Tôi muốn hỏi về khoản vay của tôi, liên hệ jane.doe@example.com hoặc gọi 0901234567. '.repeat(6);
const FRAMES = [{ filename: 'https://zuey.me/_astro/ZueyAiPanel.abc123.js', lineno: 12, colno: 4, function: 'send', in_app: true }];

function exception(url: string, message = `Unexpected token in JSON: ${CHAT}`) {
  return {
    event: '$exception',
    properties: {
      $current_url: url,
      $exception_message: message,
      $exception_type: 'SyntaxError',
      $exception_list: [{ type: 'SyntaxError', value: message, mechanism: { handled: false }, stacktrace: { type: 'raw', frames: FRAMES } }],
    },
  };
}

function listOf(properties: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const list = properties?.$exception_list;
  return Array.isArray(list) ? list : [];
}

describe('exception events carry little free text', () => {
  test('messages are scrubbed first, then cut to the limit', () => {
    const out = scrubCaptureResult(exception('https://zuey.me/articles/hello'));
    const message = out?.properties?.$exception_message;
    expect(typeof message).toBe('string');
    expect(String(message).length).toBeLessThanOrEqual(MAX_EXCEPTION_TEXT_LENGTH + 1);
    expect(String(message).startsWith('Unexpected token in JSON: Tôi muốn hỏi')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(out)).toContain(REDACTED);
    const [first] = listOf(out?.properties);
    expect(first?.value).toBe(message);
    expect(first?.type).toBe('SyntaxError');
    expect(first?.stacktrace).toEqual({ type: 'raw', frames: FRAMES });
  });

  test('short messages are kept as scrubbed', () => {
    const out = scrubCaptureResult(exception('https://zuey.me/', 'Failed to fetch for jane.doe@example.com'));
    expect(out?.properties?.$exception_message).toBe(`Failed to fetch for ${REDACTED}`);
  });

  test('/chat and /studio drop the message text but keep the type and frames', () => {
    for (const url of ['https://zuey.me/chat', 'https://zuey.me/chat/abc', 'https://zuey.me/studio#articles']) {
      const out = scrubCaptureResult(exception(url));
      expect(out?.properties?.$exception_message).toBe(REDACTED);
      expect(out?.properties?.$exception_type).toBe('SyntaxError');
      const [first] = listOf(out?.properties);
      expect(first?.value).toBe(REDACTED);
      expect(first?.type).toBe('SyntaxError');
      expect(first?.stacktrace).toEqual({ type: 'raw', frames: FRAMES });
      expect(JSON.stringify(out)).not.toContain('khoản vay');
    }
  });

  test('an open Zuey AI panel drops the message text on any page until it unmounts', () => {
    const leave = enterSensitiveSurface();
    try {
      const out = scrubCaptureResult(exception('https://zuey.me/'));
      expect(out?.properties?.$exception_message).toBe(REDACTED);
      expect(listOf(out?.properties)[0]?.value).toBe(REDACTED);
    } finally {
      leave();
      leave();
    }
    const after = scrubCaptureResult(exception('https://zuey.me/'));
    expect(after?.properties?.$exception_message).not.toBe(REDACTED);
  });

  test('other events are untouched', () => {
    const long = 'x'.repeat(500);
    const out = scrubCaptureResult({ event: '$pageview', properties: { $current_url: 'https://zuey.me/chat', $exception_message: long } });
    expect(out?.properties?.$exception_message).toBe(long);
  });

  test('hardenExceptionProperties keeps non-string values and a surrogate pair whole', () => {
    expect(hardenExceptionProperties({ $exception_message: 42, $exception_list: [null, { type: 'Error' }] }, true))
      .toEqual({ $exception_message: 42, $exception_list: [null, { type: 'Error' }] });
    const emoji = `${'a'.repeat(MAX_EXCEPTION_TEXT_LENGTH - 1)}😀tail`;
    expect(hardenExceptionProperties({ $exception_message: emoji }, false).$exception_message).toBe(`${'a'.repeat(MAX_EXCEPTION_TEXT_LENGTH - 1)}…`);
  });
});
