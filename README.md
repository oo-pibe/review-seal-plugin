# review-seal plugin

When Claude finishes a turn, this plugin has a separate Claude Code session review each changed file against your checklist. The verdict is recorded in your repository against the exact text and checklist it read, and the review-seal git hook holds back commits of covered files until their review is current.

Setup, configuration and the git hook are covered in the [main README](https://github.com/oo-pibe/review-seal#readme). The project needs a `.seal/config.json`, which the review-seal npm package creates.

## What the plugin runs

- **Three hooks** (PostToolUse, Stop and UserPromptSubmit) run `node` on the CLI bundled in `scripts/`. They note which files changed, start reviews when a turn ends, and pass findings back to Claude on your next message.
- **Reviews** run the `claude` command you already have, as a short background session with read-only tools (Read, Grep, Glob). It never sees the conversation that wrote the file. review-seal doesn't read your sign-in or any key; Claude Code handles that.
- **`/review-seal:review <file>`** runs a review on demand.

## What it sends and stores

- The file under review and your checklist go to Anthropic through your own Claude Code, like any other session.
- Web lookups are off by default. If a pass in your config turns them on, the reviewer can fetch pages only from the domains you list.
- Results are saved in your repository: `.seal/ledger.json`, plus working files in `.seal/.state/`, which git ignores.
- There is no review-seal server and no telemetry. See [PRIVACY.md](https://github.com/oo-pibe/review-seal/blob/main/PRIVACY.md).

Each review is a model call billed to your Claude plan or API usage. Requires Node 20 or later and git.
