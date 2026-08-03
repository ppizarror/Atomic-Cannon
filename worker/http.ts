/**
 * The two things every Worker entry point does: answer in JSON, and turn away a caller who is
 * asking too often. The front door and both Durable Objects had their own copy of each.
 *
 * Worker-side only — the client speaks to these through `fetch`, never imports them.
 */

export const JSON_TYPE = {'content-type': 'application/json'};

/** A JSON response. The one place the content-type is spelled. */
export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {status, headers: JSON_TYPE});

/**
 * Charge this request against a per-IP limiter. Returns a 429 to return immediately, or null to
 * carry on.
 *
 * Keying on `CF-Connecting-IP` (falling back to a shared 'anon' bucket when the header is absent)
 * is deliberate: an unidentifiable caller lands in one bucket with every other unidentifiable
 * caller, so a missing header throttles harder rather than becoming a way around the limit.
 */
export async function rateLimit(req: Request, limiter: RateLimit, message: string): Promise<Response | null> {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'anon';
  const {success} = await limiter.limit({key: ip});
  return success ? null : json({error: message}, 429);
}
