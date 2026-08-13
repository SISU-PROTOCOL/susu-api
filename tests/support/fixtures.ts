import type { GroupSummary } from '../../src/db/groups';

/**
 * Test support: environment and fixtures.
 *
 * `configureTestEnv` must run before `src/server` is imported, because
 * `getEnv()` validates and caches on first use. Test files therefore call it at
 * module scope and import the server dynamically inside `beforeAll`.
 */

/** A structurally valid contract address, used wherever a group is referenced. */
export const GROUP_CONTRACT_ID = `C${'A'.repeat(55)}`;

/** A second contract address, for cases that need two distinct groups. */
export const OTHER_CONTRACT_ID = `C${'B'.repeat(55)}`;

/** A classic account address (`G`), as a creator or member. */
export const ACCOUNT_ADDRESS = `G${'C'.repeat(55)}`;

/** A contract address acting as a member, which is legal and must not be rejected. */
export const CONTRACT_MEMBER_ADDRESS = `C${'D'.repeat(55)}`;

function fakeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(payload)}.signature`;
}

export function configureTestEnv(): void {
  process.env['NODE_ENV'] = 'test';
  process.env['PORT'] = '3000';
  process.env['HOST'] = '0.0.0.0';
  process.env['DATABASE_URL'] = 'postgresql://user:password@localhost:5432/postgres';
  process.env['SUPABASE_URL'] = 'https://example.supabase.co';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = fakeJwt({ role: 'service_role' });
  process.env['STELLAR_NETWORK'] = 'testnet';
  process.env['STELLAR_RPC_URL'] = 'https://soroban-testnet.stellar.org';
  process.env['STELLAR_NETWORK_PASSPHRASE'] = 'Test SDF Network ; September 2015';
  process.env['FACTORY_CONTRACT_ID'] = '';
  process.env['USDC_CONTRACT_ID'] = '';
  process.env['TREASURY_ADDRESS'] = '';
  process.env['PROTOCOL_FEE_BPS'] = '50';
  process.env['WALLET_NONCE_SECRET'] = 'a'.repeat(32);
  process.env['ALLOW_MAINNET'] = 'false';
  process.env['CORS_ALLOWED_ORIGINS'] = 'http://localhost:5173';
}

export function groupSummary(overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    contractId: GROUP_CONTRACT_ID,
    factoryContractId: `C${'E'.repeat(55)}`,
    groupId: 1,
    creator: ACCOUNT_ADDRESS,
    token: `C${'F'.repeat(55)}`,
    contributionAmount: '100000000',
    memberCapacity: 3,
    createdLedger: 4_606_483,
    status: 'active',
    memberCount: 3,
    currentRound: 1,
    completedRounds: 0,
    contributedTotal: '300000000',
    paidOutTotal: '0',
    feeTotal: '0',
    lastEventLedger: 4_606_500,
    ...overrides,
  };
}
