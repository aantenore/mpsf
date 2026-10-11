import { createGitProvider } from "../../messaging/providers/git.mjs";
import { createGithubProvider } from "../../messaging/providers/github.mjs";
import { createLocalProvider } from "../../messaging/providers/local.mjs";
import { createNoneProvider } from "../../messaging/providers/none.mjs";
import { GIT_PROVIDER_ID, GITHUB_PROVIDER_ID, LOCAL_PROVIDER_ID, NONE_PROVIDER_ID } from "./ids.mjs";

export * from "./ids.mjs";

/**
 * Messaging providers shipped with the plugin, by id. A team that wants
 * another transport (team chat, an issue tracker's comments) adds a factory
 * here that implements lib/adapters/messaging/port.mjs and passes the
 * contract suite in test/unit/adapters-messaging-contract.test.mjs.
 */
export const MESSAGING_PROVIDERS = Object.freeze({
  [GITHUB_PROVIDER_ID]: createGithubProvider,
  [GIT_PROVIDER_ID]: createGitProvider,
  [LOCAL_PROVIDER_ID]: createLocalProvider,
  [NONE_PROVIDER_ID]: createNoneProvider,
});
