# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

DeepSeek Harness is in developer preview and ships breaking changes between
preview releases. The `dsh` version each release was verified against is noted
below; treat it as the support boundary.

## [1.0.1] - 2026-10-28

### Fixed

- The README inside the 1.0.0 tarball still said the plugin was not published to
  npm. Install instructions now lead with
  `dsh plugin --profile desktop add dsh-prompt-enhancer-pro`, with the Release
  tarball kept as the no-npm fallback.
- README links to `docs/ENGINEERING.md` and `LICENSE` were relative, and both
  targets sit outside the published tarball, so they rendered as dead links on
  the npm page. They now use absolute repository URLs.

No code changes; `lib/` is byte-identical to 1.0.0.

## [1.0.0] - 2026-10-28

First public release. Verified against DeepSeek Harness `0.2.1-rc.2`.

Published to npm as `dsh-prompt-enhancer-pro`. The `-pro` suffix is deliberate:
bundle id, HTTP route (`/plugins/dsh-prompt-enhancer-pro`) and boot log path all
carry it so this plugin can coexist with other prompt-enhancer plugins in the
same profile without collisions.

### Added

- Composer button that rewrites the current draft into a structured prompt and
  writes the result back into the input box.
- Host-side enhancement engine using `ctx.llm.stream`, so the model already
  configured in the harness is reused — no extra API key required.
- Browser-side client registering into the `conversation.input.right` slot.
- Configurable `provider` / `model` / `defaultStyle` via `cordis.patch.yml`.
- `GET /plugins/dsh-prompt-enhancer/status` health endpoint.
- Opt-in boot log at `~/.dsh/prompt-enhancer-boot.log` (`debugLog`, default on).
- Offline test suite — 198 assertions across core logic, client bundle, host
  integration and profile wiring (`node test/run-all.mjs`).
- Two additional cold-boot suites run against the harness's own Cordis runtime
  when that installation is on the module resolution path; they skip with a
  message otherwise, so a green local run does not imply they executed.

### Security

- No outbound network requests. The only filesystem write is the optional boot
  log; set `debugLog: false` to disable it entirely.
- All HTTP routes are same-origin guarded.
