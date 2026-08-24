/**
 * The uuid shape.
 *
 * One definition, because the same trap caught two modules separately: Zod 4's
 * `z.string().uuid()` enforces the version and variant nibbles from RFC 4122 *in
 * addition* to the overall shape. Those nibbles describe how an id was
 * generated, not whether it is an id, and Postgres' `uuid` type — which both
 * sides of these checks ultimately are — accepts any 128-bit value in the
 * canonical form.
 *
 * As a validator that mismatch is one-directional and dangerous: it can only
 * reject identifiers that the database considers perfectly valid. A user whose
 * Supabase account id is not a v4 could not link a wallet, and a notification row
 * created by a future `uuidv7()` generator could not be marked read. Both would
 * be production failures caused by a check that establishes nothing, since the
 * value is either MAC'd (the nonce) or fetched by a scoped query (the row).
 *
 * Shape is still checked. It catches a code bug that produces a malformed value,
 * and it stops a malformed value reaching a query.
 */
export const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
