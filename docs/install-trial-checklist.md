# Installation trial release checklist

This checklist is a release gate, not a claim that the current branch has already passed.

A hardened revision is ready for a controlled installation trial only after all of the following are true on the exact revision being installed:

- Linux CI passes dependency installation, typecheck, the complete test suite, build, and the real CLI installation smoke test.
- Windows CI passes dependency installation, typecheck, the complete test suite, build, and the real CLI installation smoke test.
- The workflow directory contains only permanent, reviewed workflows; no one-shot write-enabled patch workflow remains.
- The runnable branch contains no unresolved P1/P2 automated-review thread.
- A full Codex Code Review of the exact head finishes without findings.
- A full Codex Security Review of the exact head finishes without findings.
- The reviewed PR is merged into `main` without bypassing the review gates.
- A fresh CI run on the resulting `main` commit passes on both supported platforms.
- The installation documentation targets `wxst/codex-with-chatgpt`, uses `node bin/c2c.js`, and does not rely on a global CLI or runtime self-update.
- The default path keeps OpenAI Secure MCP Tunnel selected; Cloudflare is enabled only after explicit user approval.
- The installer verifies the exact checkout commit and runs `pnpm smoke:install` before configuring a real workspace.

For first use, install the Skill from the same verified checkout and replace `__C2C_CHECKOUT__` only in the installed Skill copy.
