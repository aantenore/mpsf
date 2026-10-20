# Contributing

Issues and pull requests are welcome.

## Before you start

- For a bug, open an issue with the version (`/mpsf:doctor` prints it), the host and operating system, and the steps that reproduce it.
- For a larger change, open an issue first so the design can be agreed before you write code.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Working on the code

Requires Node.js 18.20.3+, 20.12.0+ or 21.6.0+ and Git. There are no runtime dependencies to install.

```bash
git clone https://github.com/aantenore/mpsf.git
cd mpsf
node bin/mpsf.mjs doctor
npm run test:fast
```

- Iterate with `npm run test:fast` (a few minutes); run `npm test` before opening a pull request.
- Keep changes backward compatible: other computers on the same project may run an older version. Records, refs and keys in `templates/sdlc-config.json` must keep working for them.
- User-visible text is plain language. Errors say what happened and how to fix it.
- Add a test that fails without your change.

## Pull requests

- One topic per pull request, with an English title that says what changes for the user.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under a new version, bump `package.json`, then run `npm run sync-version` to copy the version into every plugin manifest (it also stages `.claude-plugin`, `.codex-plugin` and `legacy`).
- If the change is visible in the Change Observatory, update [docs/change-observatory.md](docs/change-observatory.md) and its screenshots (`node scripts/observatory-screenshots.mjs`, which needs Playwright; see the script header).

By contributing you agree that your work is released under the [MIT license](LICENSE).
