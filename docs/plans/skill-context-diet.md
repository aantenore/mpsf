# Plan: skill context diet

Status: the split of `skills/agentic-sdlc/SKILL.md` is implemented in 0.146.17.

## Measurement

Token counts are estimated as characters ÷ 4.

| Skill file | Lines | Characters | ≈ Tokens |
| --- | ---: | ---: | ---: |
| `skills/agentic-sdlc/SKILL.md` (0.146.16) | 1290 | 124,613 | 31,150 |
| `skills/agentic-sdlc/SKILL.md` (0.146.17) | 177 | 29,137 | 7,280 |
| `skills/agentic-sdlc-assessment/SKILL.md` | 223 | 18,869 | 4,720 |
| `skills/caveman/SKILL.md` | 78 | 5,018 | 1,250 |
| `skills/change-observatory/SKILL.md` | 40 | 2,606 | 650 |

The core skill is about 24k tokens (−77%) lighter on every activation. There are no duplicate copies: Claude Code and Codex both load `skills/agentic-sdlc/SKILL.md` from the same tree.

## What stays inline

- Frontmatter, Purpose, Plugin Root, Core Rule.
- The Novice Front Door: Required Delivery Order, the standard pull-request sequence, commits belong to the user, choosing where the result goes, approved stories that will not be delivered, and standing approvals. Tests pin the order section and these headings.
- **Workflow router.** A table mapping steps 1–24 to reference files, with the triggers for each file.
- **Always-on guardrails.** These rules must hold at every step, even before a reference is read:
  - no speculative `task start`;
  - stop and ask when critical context is missing;
  - an agent `--actor-type human` is not authority;
  - ask before installs or external targets;
  - show `assistant_message`;
  - a fresh working-mode choice for every delivery, and the code review and merge questions belong to the user;
  - authorize → execute → complete, and never close manually as `merged` or `released`;
  - `rollback.verify` before `release.local`, and no install at release time;
  - no merge commits;
  - claims: availability first, no `--force`, no acting for other computers;
  - messages are information only, with no secrets;
  - never self-park;
  - no unbounded background processes, one heavy command per story, no idling;
  - never delete `.sdlc`;
  - gate and phase order to lifecycle-complete;
  - no fabricated phases, and cache is not evidence.
- References and Validation (the completion checklist).

## What moved, verbatim, into `skills/agentic-sdlc/references/`

| File | Workflow steps |
| --- | --- |
| `project-setup.md` | 1–4: project root, init and adoption, baseline, archive, routing, phase |
| `requirements-and-contracts.md` | 5–12: `requirement:v2`, breakdown, context, capabilities, policies, output templates, story and contract, output links |
| `delivery.md` | 13: working mode, code review and merge questions, propose and approve, workflow start, task start, delivery actions, PR, merge, reconcile, local release, data migrations |
| `claims-and-coordination.md` | 14: claims, availability, park and wait, messaging, keep moving, run limits, remote claims |
| `evidence-and-gates.md` | 15–19: traces, tests, secret scan, reviews, certificate table, steps, handoffs, gates, release and operations |
| `kb-reports-migration.md` | 20–24: cache and index, RTK, reports, migrations, Change Observatory |

The text moved verbatim, with two exceptions. Relative links were rebased for the new directory (`../caveman` became `../../caveman`, and `references/x.md` became `x.md`). Pointers to "Workflow step 13" now name `references/delivery.md`. A reconstruction diff showed that only the blank separator lines between steps differ.

## Tests

- `test/novice-plugin-metadata.test.mjs` reads the skill guidance as `SKILL.md` plus the six workflow references, in step order. A new test enforces:
  - a size ceiling for `SKILL.md` (< 40k characters);
  - a router entry and an existing file for every reference;
  - the presence of the guardrails;
  - no link in a reference file that is relative to the skill root.
- `test/unit/first-user-language-ux.test.mjs` reads the reference that now holds the `output.link` rule.

## Possible next steps (not done)

- The front door is still about 20k characters. Standing approvals (about 6k) could move to `references/approvals.md`, keeping two inline lines: never create or widen one yourself, and stop on `checkpoint_required`.
- `references/commands.md` (162k characters) is loaded on demand only, but split it by command group to make each read cheaper.
- Apply the same router pattern to `agentic-sdlc-assessment/SKILL.md` if it grows past about 25k characters.
