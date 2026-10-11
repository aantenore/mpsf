import { UserError } from "../cli/user-error.mjs";
import { buildContextPack, getContextRef } from "./service.mjs";

/** `context pack --story <id> [--phase <p>] [--budget <tokens>] [--json]` */
export function contextPackCommand(context, options, { pluginVersion = null } = {}) {
  if (!options.story) throw new UserError("context pack needs --story <story-id>.");
  const result = buildContextPack(context, {
    story: options.story,
    phase: options.phase ? String(options.phase) : null,
    budget: options.budget,
    cache: options["no-cache"] !== true,
    pluginVersion,
  });
  if (options.json === true) {
    console.log(JSON.stringify({
      status: "ok",
      cache: result.cache,
      source_files: result.source_files,
      source_tokens: result.source_tokens,
      pack_tokens: result.pack.tokens,
      pack: result.pack,
    }, null, 2));
  } else {
    process.stdout.write(result.text);
  }
  return result;
}

/** `context get <ref> [--budget <tokens>]` */
export function contextGetCommand(context, options, args = []) {
  const ref = options.ref ?? args[0];
  if (!ref || args.length > 1) throw new UserError("context get needs exactly one ref, as printed by context pack (sec:..., rec:..., trace:...).");
  const result = getContextRef(context, ref, { budget: options.budget });
  if (options.json === true) console.log(JSON.stringify({ status: "ok", ref: result.ref, text: result.text }, null, 2));
  else process.stdout.write(result.text);
  return result;
}
