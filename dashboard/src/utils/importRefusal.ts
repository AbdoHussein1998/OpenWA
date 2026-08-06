/**
 * POST /infra/import-data answers 409 for unrelated reasons, and they need opposite handling.
 *
 * The orphan case is a DECISION: live engines exist for sessions the backup would remove, and the
 * documented retry is `stopOrphans=true`, which stops them inside the request. Offering that as a
 * confirm is right — and it is the only refusal the endpoint throws without a machine `code`.
 *
 * Every coded refusal is a "not now" instead: another restore is in flight, or another transaction
 * holds the connection. The caller can only wait and retry unchanged. Retrying one with
 * `stopOrphans` would run a second destructive replace-all the operator never asked for — tearing
 * down live engines — from a dialog whose message says wait. So the presence of a code, not the
 * status, decides; an unrecognised code withholds the retry, which costs the operator nothing
 * because the refusal is still shown as an error toast carrying the server's own message.
 */
export function shouldOfferStopOrphansRetry(
  status: number | undefined,
  code: string | undefined,
  alreadyRetriedWithStopOrphans: boolean,
): boolean {
  if (status !== 409) return false;
  // A 409 on the retry itself (an engine started mid-import) must not loop.
  if (alreadyRetriedWithStopOrphans) return false;
  return code === undefined;
}
