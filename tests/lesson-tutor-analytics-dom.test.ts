import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';

// The lesson AI tutor is a private-text surface: autocapture must skip it (posthog-js drops clicks on any element
// inside a `ph-no-capture` ancestor, so neither `$elements` nor `$elements_chain` carries its text), and while it is
// open or answering, `$exception` events lose their message text.
// Installs happy-dom as process globals: never run with `bun test --concurrent`.

const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const QUESTION = 'Em tên Lan, số 0901234567, giải thích lại phần vòng lặp giúp em?';
const ANSWER = 'Vòng lặp lặp lại một khối lệnh cho tới khi điều kiện sai.';

type ReactModule = typeof import('react');
let React: ReactModule;
let client: typeof import('react-dom/client');
let tutor: typeof import('../src/components/courses/LessonTutor');
let posthog: typeof import('../src/lib/analytics/destinations/posthog');
let pii: typeof import('../src/lib/analytics/pii');

function sseResponse(frames: string[]): Response {
  const bytes = new TextEncoder().encode(frames.join(''));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new NativeResponse(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** An answer stream the test finishes itself, so the tutor can be closed or unmounted while it is still answering. */
interface HeldStream { controller: ReadableStreamDefaultController<Uint8Array> | null; signal: AbortSignal | null }
let held: HeldStream | null = null;

function heldResponse(slot: HeldStream): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      slot.controller = controller;
      controller.enqueue(new TextEncoder().encode(`event: delta\ndata: ${JSON.stringify({ text: 'Vòng lặp' })}\n\n`));
      slot.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    },
  });
  return new NativeResponse(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch() {
  const fake = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/v1/chat/sessions')) {
      return new NativeResponse(JSON.stringify({ success: true, data: { id: 'ses_tutor' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (held) {
      held.signal = init?.signal ?? null;
      return heldResponse(held);
    }
    return sseResponse([
      `event: delta\ndata: ${JSON.stringify({ text: ANSWER })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ content: ANSWER })}\n\n`,
    ]);
  };
  Object.assign(globalThis, { fetch: fake });
}

function exceptionCapture(message: string) {
  return {
    event: '$exception',
    properties: {
      $current_url: 'https://zuey.me/courses/python-co-ban/vong-lap',
      $exception_message: message,
      $exception_list: [{ type: 'TypeError', value: message, mechanism: { handled: false } }],
    },
  };
}

async function settle() {
  await React.act(async () => {
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
  });
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://zuey.me/courses/python-co-ban/vong-lap' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  stubFetch();
  React = await import('react');
  client = await import('react-dom/client');
  tutor = await import('../src/components/courses/LessonTutor');
  posthog = await import('../src/lib/analytics/destinations/posthog');
  pii = await import('../src/lib/analytics/pii');
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  Object.assign(globalThis, { fetch: nativeFetch });
});

describe('lesson AI tutor is a sensitive analytics surface', () => {
  test('tutor open: autocapture skips its question and transcript, and exceptions carry no typed text', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = client.createRoot(container);
    React.act(() => root.render(React.createElement(tutor.LessonTutor, {
      courseSlug: 'python-co-ban', lessonSlug: 'vong-lap', lessonTitle: 'Vòng lặp', signedIn: true,
    })));
    try {
      const closedOut = posthog.scrubCaptureResult(exceptionCapture('Unexpected token in lesson.js'));
      expect(closedOut?.properties?.$exception_message).toBe('Unexpected token in lesson.js');

      const toggle = container.querySelector('button[aria-expanded]');
      if (!toggle) throw new Error('No tutor toggle');
      await React.act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      const field = container.querySelector('textarea');
      if (!field) throw new Error('No question field');
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      await React.act(async () => {
        setValue?.call(field, QUESTION);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const form = container.querySelector('form');
      if (!form) throw new Error('No tutor form');
      await React.act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await settle();

      const items = Array.from(container.querySelectorAll('li')).map(li => li.textContent ?? '');
      expect(items.some(text => text.includes(QUESTION))).toBe(true);
      expect(items.some(text => text.includes(ANSWER))).toBe(true);

      // Every element of the tutor sits under a `ph-no-capture` ancestor, so posthog-js autocapture records none of them.
      const section = container.querySelector('section');
      expect(section?.classList.contains('ph-no-capture')).toBe(true);
      for (const el of Array.from(container.querySelectorAll('section *'))) {
        expect(el.closest('.ph-no-capture')).not.toBeNull();
      }

      const openOut = posthog.scrubCaptureResult(exceptionCapture(`Cannot read properties of undefined (reading '${QUESTION}')`));
      expect(openOut?.properties?.$exception_message).toBe(pii.REDACTED);
      const list = openOut?.properties?.$exception_list;
      expect(Array.isArray(list) ? list[0] : null).toEqual({ type: 'TypeError', value: pii.REDACTED, mechanism: { handled: false } });
      const serialized = JSON.stringify(openOut);
      expect(serialized).not.toContain('Lan');
      expect(serialized).not.toContain('vòng lặp');

      await React.act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const afterClose = posthog.scrubCaptureResult(exceptionCapture('Unexpected token in lesson.js'));
      expect(afterClose?.properties?.$exception_message).toBe('Unexpected token in lesson.js');
    } finally {
      React.act(() => root.unmount());
      container.remove();
    }
    const afterUnmount = posthog.scrubCaptureResult(exceptionCapture('Unexpected token in lesson.js'));
    expect(afterUnmount?.properties?.$exception_message).toBe('Unexpected token in lesson.js');
  });

  describe('while an answer is still streaming', () => {
    const PLAIN = 'Unexpected token in lesson.js';
    const messageOf = (text: string): unknown => posthog.scrubCaptureResult(exceptionCapture(text))?.properties?.$exception_message;

    /** Mounts the tutor, opens it and sends the question; the answer stream stays open until the test ends it. */
    async function askAndHold(): Promise<{ container: HTMLDivElement; root: Root; toggle: Element; slot: HeldStream }> {
      const slot: HeldStream = { controller: null, signal: null };
      held = slot;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root: Root = client.createRoot(container);
      React.act(() => root.render(React.createElement(tutor.LessonTutor, {
        courseSlug: 'python-co-ban', lessonSlug: 'vong-lap', lessonTitle: 'Vòng lặp', signedIn: true,
      })));
      const toggle = container.querySelector('button[aria-expanded]');
      if (!toggle) throw new Error('No tutor toggle');
      await React.act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const field = container.querySelector('textarea');
      const form = container.querySelector('form');
      if (!field || !form) throw new Error('No question form');
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      await React.act(async () => {
        setValue?.call(field, QUESTION);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await React.act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await settle();
      if (!slot.controller || !slot.signal) throw new Error('The answer stream did not start');
      return { container, root, toggle, slot };
    }

    afterAll(() => { held = null; });

    test('closing the panel keeps exception text dropped until the answer finishes', async () => {
      const { container, root, toggle, slot } = await askAndHold();
      try {
        await React.act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(messageOf(`Cannot read '${QUESTION}'`)).toBe(pii.REDACTED);

        slot.controller?.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ content: ANSWER })}\n\n`));
        slot.controller?.close();
        await settle();
        expect(messageOf(PLAIN)).toBe(PLAIN);
      } finally {
        React.act(() => root.unmount());
        container.remove();
      }
    });

    test('unmounting aborts the stream and leaves the sensitive surface', async () => {
      const { container, root, slot } = await askAndHold();
      expect(messageOf(`Cannot read '${QUESTION}'`)).toBe(pii.REDACTED);
      React.act(() => root.unmount());
      container.remove();
      await settle();
      expect(slot.signal?.aborted).toBe(true);
      expect(messageOf(PLAIN)).toBe(PLAIN);
    });
  });
});
