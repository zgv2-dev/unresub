import { describe, expect, it } from 'vitest';
import { mccCategory } from './mcc.ts';

describe('mccCategory', () => {
  it('names common codes, falls back to ranges, then Other', () => {
    expect(mccCategory(5411)).toEqual({ id: 'groceries', label: 'Groceries' });
    expect(mccCategory(5814).id).toBe('restaurants');
    expect(mccCategory(4899).id).toBe('digital');
    expect(mccCategory(6011).id).toBe('cash');
    expect(mccCategory(3058).id).toBe('travel');
    expect(mccCategory(5651).id).toBe('shopping');
    expect(mccCategory(9311).id).toBe('government');
    expect(mccCategory(null).id).toBe('other');
    expect(mccCategory(1).id).toBe('other');
  });
});
