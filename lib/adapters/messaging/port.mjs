/**
 * MessagingProvider port.
 *
 * Messaging only notifies: it is never a source of truth, never approves,
 * claims or skips anything, and never blocks an action. Coordination state
 * lives in the record store (claims, waits, delegations); a provider only
 * tells the other computers that something happened.
 *
 * A provider is an object with:
 *
 *   id                                   provider id (as in host_policy.adapters.messaging.provider)
 *   guarantees                           list of MESSAGING_GUARANTEES it gives
 *   ensureChannel({ config, signal, verify }) -> { issue|null, created, url }
 *                                        finds or creates the channel; idempotent
 *   publish({ config, message, signal }) -> normalized message (at least { id, time })
 *                                        `message` is { from, host, ghLogin, story, text, kind, replyTo, to, version, until? }
 *   poll({ config, since, signal })      -> normalized messages after `since`, oldest first
 *                                        `since`: all | duration (30m) | unix seconds | ISO time | cursor "<time>|<id>"
 *   subscribe({ config, since, signal, onMessage, onError, intervalSeconds })
 *                                        delivers new messages until the signal aborts or onMessage returns false
 *   whoami({ signal })                   -> account login of this computer on the transport, or null
 *
 * A normalized message carries:
 *   id (digits only, growing), time (ISO, UTC, seconds), from, host, story,
 *   kind, reply_to, to, version, gh_login, stories, text, title,
 *   plugin_message, and `until` for a freeze.
 *
 * Errors: a temporary refusal (network, rate limit, server error, transport
 * not ready) is an Error with `setup: true`, or a `status` of 408/429/5xx, or
 * `rateLimited` with `retryAfterMs`; the outbox queues the message. Any other
 * error is a permanent refusal and the message is not queued.
 */
export const MESSAGING_PORT_METHODS = Object.freeze(["ensureChannel", "publish", "poll", "subscribe", "whoami"]);
export const MESSAGE_FIELDS = Object.freeze([
  "id", "time", "from", "host", "story", "kind", "reply_to", "to", "version", "gh_login", "stories", "text", "title", "plugin_message",
]);

/** Throws when `provider` does not implement the port; returns it otherwise. */
export function assertMessagingProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("A messaging provider must be an object.");
  if (typeof provider.id !== "string" || !provider.id) throw new TypeError("A messaging provider needs an id.");
  for (const method of MESSAGING_PORT_METHODS) {
    if (typeof provider[method] !== "function") throw new TypeError(`Messaging provider '${provider.id}' does not implement ${method}().`);
  }
  if (!Array.isArray(provider.guarantees)) throw new TypeError(`Messaging provider '${provider.id}' must list its guarantees.`);
  return provider;
}
