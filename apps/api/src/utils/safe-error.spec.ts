import { describe, expect, it } from 'vitest';
import { safeErrorKind } from './safe-error.js';

describe('safeErrorKind', () => {
  it('keeps a diagnostic code without exposing provider or SQL error text', () => {
    const error = Object.assign(new Error('password=top-secret; phone=+923001234567'), {
      code: '28P01',
      detail: 'customer@example.com',
    });
    expect(safeErrorKind(error)).toBe('Error (28P01)');
  });
});
