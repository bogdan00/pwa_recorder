import { describe, expect, it } from 'vitest';
import { deriveBookNarrators, formatBookNarrators } from '../format';

describe('deriveBookNarrators & formatBookNarrators', () => {
  it('returns empty list/string when recordings have no creators', () => {
    expect(deriveBookNarrators([])).toEqual([]);
    expect(formatBookNarrators([])).toBe('');
    expect(
      formatBookNarrators([{ recordedBy: undefined }, { recordedBy: '   ' }]),
    ).toBe('');
  });

  it('deduplicates creators case-insensitively while preserving first-seen order and casing', () => {
    const recs = [
      { recordedBy: 'Dad' },
      { recordedBy: ' dad ' },
      { recordedBy: 'Mom' },
      { recordedBy: 'DAD' },
    ];
    expect(deriveBookNarrators(recs)).toEqual(['Dad', 'Mom']);
    expect(formatBookNarrators(recs)).toBe('Dad & Mom');
  });

  it('formats single, pair, and three or more narrators naturally', () => {
    expect(formatBookNarrators([{ recordedBy: 'Dad' }])).toBe('Dad');
    expect(
      formatBookNarrators([{ recordedBy: 'Dad' }, { recordedBy: 'Mom' }]),
    ).toBe('Dad & Mom');
    expect(
      formatBookNarrators([
        { recordedBy: 'Dad' },
        { recordedBy: 'Mom' },
        { recordedBy: 'Grandpa' },
      ]),
    ).toBe('Dad, Mom & Grandpa');
  });
});
