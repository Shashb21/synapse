import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { gateFor } from '@/modules/auth/gate';
import { proxy } from '@/proxy';
import { ADMIN_REDIRECTS } from '../next.config';

describe('retired Accuracy path boundaries', () => {
  it.each(['/accuracy', '/accuracy/nested', '/api/accuracy', '/api/accuracy/nested'])('passes %s to not-found without a workspace', path => {
    expect(gateFor(path)).toBe('open');
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const response = proxy(new NextRequest(`http://localhost${path}?test=1`, { method, headers: { 'content-length': '999999999' } }));
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it.each(['/accuracy-extra', '/api/accuracy-extra'])('keeps normal gate rules for %s', path => {
    expect(gateFor(path)).toBe('workspace');
  });

  it('has no legacy Accuracy redirects', () => {
    expect(ADMIN_REDIRECTS.some(rule => rule.source === '/accuracy' || rule.source.startsWith('/accuracy/'))).toBe(false);
  });
});
