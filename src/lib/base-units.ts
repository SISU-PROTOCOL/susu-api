/**
 * Exact base-unit amounts.
 *
 * Money on Stellar is fixed-point: an `i128` of stroops, not a decimal. The index
 * stores those values as `numeric(39,0)` and this module is the only place they
 * are allowed to cross into the API's type system.
 *
 * WHY STRINGS
 * Amounts are returned as strings of base units, never as JSON numbers. A JSON
 * number is an IEEE-754 double, which represents integers exactly only up to
 * 2^53; an `i128` runs to 39 digits. The moment an amount is parsed as a number
 * it can be silently rounded, and a rounded balance is indistinguishable from a
 * correct one to every consumer downstream — including ones that compare it
 * against the chain.
 *
 * WHY THIS THROWS
 * `node-postgres` decodes `numeric` to a string, so the correct thing arrives
 * here by default. That default is not a guarantee: a global type parser
 * (`pg.types.setTypeParser`) or a `Number()` in a future query would turn it
 * into a `double` before this module ever sees it. Validating the shape means
 * that mistake fails loudly at the boundary instead of quietly producing a
 * plausible-looking amount.
 */

/** The largest value an `i128` can hold: 2^127 - 1. */
export const MAX_I128 = 170141183460469231731687303715884105727n;

const BASE_UNIT_PATTERN = /^\d+$/;

/**
 * Asserts that a value is a non-negative integer string of base units within
 * `i128` range, and returns it.
 *
 * @param value - The value as it came back from the database.
 * @param field - Name used in the error, so a failure names the column.
 */
export function assertBaseUnits(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `${field} arrived as ${typeof value}, not a base-unit string. ` +
        'A numeric column read without an explicit ::text cast is decoded as a JSON number, ' +
        'which has already lost precision above 2^53.',
    );
  }

  if (!BASE_UNIT_PATTERN.test(value)) {
    throw new Error(
      `${field} is not a non-negative integer string of base units: ${JSON.stringify(value)}`,
    );
  }

  if (BigInt(value) > MAX_I128) {
    throw new Error(`${field} exceeds the maximum i128 value: ${value}`);
  }

  return value;
}

/**
 * Asserts that a value is a non-negative integer safe to expose as a JSON number.
 *
 * Ledgers, rounds, positions and counts are small by construction, so a number is
 * the right representation for them. `bigint` columns still arrive from
 * `node-postgres` as strings, and a `count(*)` is a `bigint` too, so the
 * conversion has to be checked rather than assumed.
 */
export function assertCount(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} is not a non-negative safe integer: ${value}`);
    }
    return value;
  }

  if (typeof value === 'string' && BASE_UNIT_PATTERN.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  throw new Error(`${field} is not a non-negative safe integer: ${JSON.stringify(value)}`);
}
