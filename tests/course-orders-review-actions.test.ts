import { describe, expect, it } from 'bun:test';
import { orderActions } from '../src/components/studio/courses/course-orders-review';

describe('admin course order actions', () => {
  it('offers only a refund of a disputed order while its dispute is open, with the disputed-order confirm text', () => {
    const actions = orderActions('charged_back', false);
    expect(Object.keys(actions)).toEqual(['refund']);
    expect(actions.refund).toMatch(/disputed order/);
  });

  it('offers nothing once the dispute was lost', () => {
    expect(orderActions('charged_back', true)).toEqual({});
  });

  it('keeps grant, dismiss and the plain refund text for the states the server settles', () => {
    expect(Object.keys(orderActions('needs_attention', false))).toEqual(['grant', 'dismiss', 'refund']);
    expect(orderActions('needs_attention', false).refund).not.toMatch(/disputed order/);
    expect(Object.keys(orderActions('paid', false))).toEqual(['refund']);
    expect(Object.keys(orderActions('pending', false))).toEqual(['grant', 'dismiss']);
    expect(Object.keys(orderActions('cancelled', false))).toEqual(['grant']);
    expect(Object.keys(orderActions('refunded', false))).toEqual(['grant', 'dismiss']);
  });
});
