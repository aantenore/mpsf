/** Ids of the messaging providers shipped with the plugin, and other names accepted for them. Free of imports so settings code can use it. */
export const GITHUB_PROVIDER_ID = "github";
export const LOCAL_PROVIDER_ID = "local";
export const NONE_PROVIDER_ID = "none";
export const GIT_PROVIDER_ID = "git";
export const MESSAGING_PROVIDER_IDS = Object.freeze([GITHUB_PROVIDER_ID, GIT_PROVIDER_ID, LOCAL_PROVIDER_ID, NONE_PROVIDER_ID]);
export const MESSAGING_PROVIDER_ALIASES = Object.freeze({ "github-issue": GITHUB_PROVIDER_ID, file: LOCAL_PROVIDER_ID, off: NONE_PROVIDER_ID, "git-refs": GIT_PROVIDER_ID });
// What `message setup` picks on a clone with no messaging settings and no channel issue already in use.
export const SETUP_DEFAULT_PROVIDER = GIT_PROVIDER_ID;

export function canonicalMessagingProvider(id) {
  const text = String(id ?? "").trim().toLowerCase();
  return MESSAGING_PROVIDER_ALIASES[text] ?? text;
}
