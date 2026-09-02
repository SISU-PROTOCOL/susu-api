/**
 * Account deletion, and the profile photo the auth cascade cannot reach.
 *
 * The photo is a Storage object: a row in `storage.objects` and a blob behind
 * the Storage API. Deleting the auth user removes the row by foreign key but
 * leaves the blob, so the deleter removes the objects itself. These tests are
 * about that step — its order, its prefix, and what a failure means.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PROFILE_IMAGE_BUCKET,
  createAccountDeleter,
  type SupabaseAdminClient,
} from '../src/supabase/admin';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const PREFIX = `users/${USER_ID}/avatar`;

type FakeOptions = {
  list?: { data: { name: string }[] | null; error: { message: string } | null };
  remove?: { data: { name: string }[] | null; error: { message: string } | null };
  deleteUser?: { error: { message: string } | null };
};

type Fake = {
  client: SupabaseAdminClient;
  /** Calls in the order they were made, so ordering can be asserted. */
  calls: string[];
  list: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  buckets: string[];
};

function fakeClient(options: FakeOptions = {}): Fake {
  const calls: string[] = [];
  const buckets: string[] = [];

  const list = vi.fn(async (path: string) => {
    calls.push(`list:${path}`);
    return options.list ?? { data: [{ name: 'a'.repeat(32) + '.png' }], error: null };
  });
  const remove = vi.fn(async (paths: readonly string[]) => {
    calls.push(`remove:${paths.join(',')}`);
    return options.remove ?? { data: paths.map((name) => ({ name })), error: null };
  });
  const deleteUser = vi.fn(async (userId: string) => {
    calls.push(`deleteUser:${userId}`);
    return options.deleteUser ?? { error: null };
  });

  const client = {
    auth: { getUser: vi.fn(), admin: { deleteUser } },
    storage: {
      from: (bucket: string) => {
        buckets.push(bucket);
        return { list, remove };
      },
    },
  } as unknown as SupabaseAdminClient;

  return { client, calls, list, remove, deleteUser, buckets };
}

describe('createAccountDeleter', () => {
  it('removes the profile photo and then the account', async () => {
    const fake = fakeClient();
    const deleteAccount = createAccountDeleter(fake.client);

    expect(await deleteAccount(USER_ID)).toBe(true);

    expect(fake.calls).toEqual([
      `list:${PREFIX}`,
      `remove:${PREFIX}/${'a'.repeat(32)}.png`,
      `deleteUser:${USER_ID}`,
    ]);
  });

  it("looks only in the deleted user's own avatar prefix", async () => {
    const fake = fakeClient();
    const deleteAccount = createAccountDeleter(fake.client);

    await deleteAccount(USER_ID);

    // Not `users/<id>` and not the bucket root: the prefix is the ownership
    // boundary, and a deleter that ignored it would be a way to destroy objects
    // this operation has no business touching.
    expect(fake.list).toHaveBeenCalledWith(PREFIX, expect.anything());
    expect(fake.buckets.every((bucket) => bucket === PROFILE_IMAGE_BUCKET)).toBe(true);
    expect(fake.buckets.length).toBeGreaterThan(0);
  });

  it('deletes the account when there is no photo to remove', async () => {
    const fake = fakeClient({ list: { data: [], error: null } });
    const deleteAccount = createAccountDeleter(fake.client);

    expect(await deleteAccount(USER_ID)).toBe(true);

    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.deleteUser).toHaveBeenCalledWith(USER_ID);
  });

  it('still deletes the account when the photo cannot be listed, and says so', async () => {
    const fake = fakeClient({ list: { data: null, error: { message: 'storage unavailable' } } });
    const warnings: string[] = [];
    const deleteAccount = createAccountDeleter(fake.client, {
      onWarning: (message) => warnings.push(message),
    });

    // The account is what the user asked to destroy. Refusing because a blob
    // would not go would fail the request for a reason they cannot act on.
    expect(await deleteAccount(USER_ID)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('storage unavailable');
  });

  it('still deletes the account when the photo cannot be removed, and says so', async () => {
    const fake = fakeClient({ remove: { data: null, error: { message: 'object locked' } } });
    const warnings: string[] = [];
    const deleteAccount = createAccountDeleter(fake.client, {
      onWarning: (message) => warnings.push(message),
    });

    expect(await deleteAccount(USER_ID)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('object locked');
  });

  it('reports a failed account deletion rather than throwing', async () => {
    const fake = fakeClient({ deleteUser: { error: { message: 'provider refused' } } });
    const deleteAccount = createAccountDeleter(fake.client);

    // The route turns this into 502: the caller is authenticated and their retry
    // may succeed.
    expect(await deleteAccount(USER_ID)).toBe(false);
  });

  it('says nothing when the cleanup worked', async () => {
    const fake = fakeClient();
    const warnings: string[] = [];
    const deleteAccount = createAccountDeleter(fake.client, {
      onWarning: (message) => warnings.push(message),
    });

    await deleteAccount(USER_ID);

    expect(warnings).toEqual([]);
  });

  it('bounds the listing so deletion cannot become an unbounded scan', async () => {
    const fake = fakeClient();
    const deleteAccount = createAccountDeleter(fake.client);

    await deleteAccount(USER_ID);

    const options = fake.list.mock.calls[0]?.[1] as { limit?: number } | undefined;
    expect(options?.limit).toBeGreaterThan(0);
    expect(options?.limit).toBeLessThanOrEqual(100);
  });

  it('takes the bucket as configuration rather than assuming it', async () => {
    const fake = fakeClient();
    const deleteAccount = createAccountDeleter(fake.client, { bucket: 'other-bucket' });

    await deleteAccount(USER_ID);

    expect(fake.buckets.every((bucket) => bucket === 'other-bucket')).toBe(true);
    expect(fake.buckets.length).toBeGreaterThan(0);
  });
});
