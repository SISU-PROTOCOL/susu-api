import { describe, expect, it } from 'vitest';
import { generateInviteCode, INVITE_CODE_PATTERN, isWellFormedInviteCode } from './invite-code';

describe('generateInviteCode', () => {
  it('produces codes that satisfy the database constraint', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(INVITE_CODE_PATTERN.test(generateInviteCode())).toBe(true);
    }
  });

  it('never produces a code shaped like a Stellar address', () => {
    // The specific mistake this project made the first time. A base64url code can
    // contain `0`, `1` and `9`, none of which appear in base32, so the shapes are
    // disjoint — but that is a property worth pinning rather than reasoning about.
    for (let i = 0; i < 500; i += 1) {
      expect(generateInviteCode()).not.toMatch(/^[GC][A-Z2-7]{55}$/);
    }
  });

  it('uses the full length available', () => {
    // 32 bytes in base64url is 43 characters. A shorter code would still pass the
    // database's floor of 22, so the floor alone does not pin the entropy.
    const code = generateInviteCode();
    expect(code.length).toBe(43);
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 1000 }, generateInviteCode));

    // 256 bits of entropy; a collision in 1000 draws means the generator is not
    // drawing from a CSPRNG.
    expect(codes.size).toBe(1000);
  });
});

describe('isWellFormedInviteCode', () => {
  it('accepts a generated code', () => {
    expect(isWellFormedInviteCode(generateInviteCode())).toBe(true);
  });

  it('accepts any code meeting the database shape', () => {
    expect(isWellFormedInviteCode('a'.repeat(22))).toBe(true);
    expect(isWellFormedInviteCode('a'.repeat(64))).toBe(true);
    // 22 characters — the floor — so the alphabet is exercised at the shortest
    // length the database accepts.
    expect(isWellFormedInviteCode('abc_DEF-0123456789abcd')).toBe(true);
  });

  it('refuses a code that is too short', () => {
    // 132 bits is the floor the database enforces; anything shorter must not
    // reach a lookup.
    expect(isWellFormedInviteCode('a'.repeat(21))).toBe(false);
    expect(isWellFormedInviteCode('')).toBe(false);
  });

  it('refuses a code that is too long', () => {
    expect(isWellFormedInviteCode('a'.repeat(65))).toBe(false);
  });

  it('refuses a contract address', () => {
    // Long, high-entropy and a perfect match for the length-and-alphabet check,
    // which is why the shape check alone is not enough.
    expect(isWellFormedInviteCode(`C${'A'.repeat(55)}`)).toBe(false);
    // And the classic account form, for the same reason.
    expect(isWellFormedInviteCode(`G${'B'.repeat(55)}`)).toBe(false);
  });

  it('refuses characters outside the alphabet', () => {
    expect(isWellFormedInviteCode('a'.repeat(21) + '!')).toBe(false);
    expect(isWellFormedInviteCode('a'.repeat(21) + ' ')).toBe(false);
    expect(isWellFormedInviteCode('a'.repeat(21) + '.')).toBe(false);
  });
});
