/**
 * POST /infra/import-data answers 409 for two unrelated reasons, and they need opposite handling.
 *
 * The orphan case is a DECISION: live engines exist for sessions the backup would remove, and the
 * documented retry is `stopOrphans=true`, which stops them inside the request. Offering that as a
 * confirm is right.
 *
 * IMPORT_ALREADY_RUNNING is not a decision — another restore is in flight and the caller can only
 * wait. Retrying it with `stopOrphans` would run a second destructive replace-all the operator never
 * asked for, from a dialog whose message says "wait". So the status alone must never drive the
 * confirm; the machine code has to be read.
 */
export function shouldOfferStopOrphansRetry(
  status: number | undefined,
  code: string | undefined,
  alreadyRetriedWithStopOrphans: boolean,
): boolean {
  if (status !== 409) return false;
  // A 409 on the retry itself (an engine started mid-import) must not loop.
  if (alreadyRetriedWithStopOrphans) return false;
  return code !== 'IMPORT_ALREADY_RUNNING';
}
