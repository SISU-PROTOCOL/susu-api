/**
 * The transaction receipt endpoint.
 *
 * Public, like the group routes: everything it returns is chain-derived and
 * already visible to anyone reading the ledger. There is nothing to authenticate.
 */
import type { FastifyInstance } from 'fastify';
import {
  isTransactionHash,
  normaliseTransactionHash,
  type TransactionReadModel,
} from '../db/transactions';

export type TransactionRoutesOptions = {
  readModel: TransactionReadModel;
};

/**
 * A receipt is immutable: a transaction's events are decided when it is included
 * in a ledger and never change afterwards. So this is the one response in the API
 * that can be cached with confidence — but only the *found* one.
 *
 * `not found` is the opposite. The indexer runs on a schedule, so for a
 * transaction submitted moments ago it means "not yet", and caching that would
 * turn a transient state into a sticky one for as long as the cache lives. The
 * two get different headers for that reason.
 */
const FOUND_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600';
const ABSENT_CACHE_CONTROL = 'no-store';

export async function transactionRoutes(
  app: FastifyInstance,
  options: TransactionRoutesOptions,
): Promise<void> {
  const { readModel } = options;

  app.get('/transactions/:txHash', async (request, reply) => {
    const params = request.params as { txHash?: unknown };
    const txHash = params.txHash;

    // A hash that is not 64 hex characters cannot match a row, so it is refused
    // before the query rather than after: a junk path segment should not become a
    // database lookup, and cannot be used to probe for stored values.
    if (typeof txHash !== 'string' || !isTransactionHash(txHash)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const receipt = await readModel.getReceipt(normaliseTransactionHash(txHash));

    if (receipt === undefined) {
      // Deliberately indistinguishable from "this transaction did no Susu work":
      // the index cannot tell the two apart, so neither can this.
      reply.header('cache-control', ABSENT_CACHE_CONTROL);
      return reply.code(404).send({ error: 'transaction_not_found' });
    }

    reply.header('cache-control', FOUND_CACHE_CONTROL);
    return reply.send({ data: receipt });
  });
}
