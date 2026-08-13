import { describe, expect, it } from 'vitest';
import { assertBaseUnits, assertCount, MAX_I128 } from './base-units';

describe('assertBaseUnits', () => {
  it('accepts integer strings of base units', () => {
    expect(assertBaseUnits('0', 'amount')).toBe('0');
    expect(assertBaseUnits('10000000', 'amount')).toBe('10000000');
  });

  it('accepts the largest i128 exactly, without rounding it', () => {
    const max = MAX_I128.toString();
    expect(max).toHaveLength(39);
    expect(assertBaseUnits(max, 'amount')).toBe(max);
  });

  it('rejects a value that is not a string, naming the missing cast', () => {
    // This is the failure the guard exists for: a `numeric` decoded as a JSON
    // number has already lost precision, and the message has to say why.
    expect(() => assertBaseUnits(10000000, 'contributions.amount')).toThrow(/::text cast/);
    expect(() => assertBaseUnits(1.5, 'contributions.amount')).toThrow(/arrived as number/);
    expect(() => assertBaseUnits(null, 'contributions.amount')).toThrow(/arrived as object/);
  });

  it('rejects anything that is not a non-negative integer', () => {
    for (const value of ['-1', '1.5', '1e7', '', ' 12 ', 'abc', '0x10', '+1']) {
      expect(() => assertBaseUnits(value, 'amount')).toThrow(/not a non-negative integer string/);
    }
  });

  it('rejects a value beyond the i128 range', () => {
    const tooLarge = (MAX_I128 + 1n).toString();
    expect(() => assertBaseUnits(tooLarge, 'amount')).toThrow(/exceeds the maximum i128/);
  });
});

describe('assertCount', () => {
  it('accepts a number from the driver', () => {
    expect(assertCount(0, 'ledger')).toBe(0);
    expect(assertCount(4606483, 'ledger')).toBe(4606483);
  });

  it('accepts a bigint that arrived as a string', () => {
    // `node-postgres` returns int8 as a string, so counts and ledgers need the
    // same scrutiny as money before they become JSON numbers.
    expect(assertCount('42', 'ledger')).toBe(42);
  });

  it('rejects values that cannot be a count', () => {
    expect(() => assertCount(-1, 'ledger')).toThrow(/non-negative safe integer/);
    expect(() => assertCount('1.5', 'ledger')).toThrow(/non-negative safe integer/);
    expect(() => assertCount(null, 'ledger')).toThrow(/non-negative safe integer/);
  });

  it('rejects a value past the safe-integer range instead of rounding it', () => {
    expect(() => assertCount('9007199254740993', 'ledger')).toThrow(/non-negative safe integer/);
  });
});
