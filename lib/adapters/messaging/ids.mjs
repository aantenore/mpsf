/** Ids of the messaging providers shipped with the plugin, and other names accepted for them. Free of imports so settings code can use it. */
export const GITHUB_PROVIDER_ID = "github";
export const LOCAL_PROVIDER_ID = "local";
export const NONE_PROVIDER_ID = "none";
export const MESSAGING_PROVIDER_IDS = Object.freeze([GITHUB_PROVIDER_ID, LOCAL_PROVIDER_ID, NONE_PROVIDER_ID]);
export const MESSAGING_PROVIDER_ALIASES = Object.freeze({ "github-issue": GITHUB_PROVIDER_ID, file: LOCAL_PROVIDER_ID, off: NONE_PROVIDER_ID });
export const DEFAULT_MESSAGING_PROVIDER = GITHUB_PROVIDER_ID;

export function canonicalMessagingProvider(id) {
  const text = String(id ?? "").trim().toLowerCase();
  return MESSAGING_PROVIDER_ALIASES[text] ?? text;
}
