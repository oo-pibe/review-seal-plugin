# review-seal plugin

When Claude finishes a turn, this plugin has a separate Claude Code session review each changed file against your checklist. The verdict is recorded in your repository against the exact text and checklist it read, and the review-seal git hook holds back commits of covered files until their review is current.

Setup, configuration and the git hook are covered in the [main README](https://github.com/oo-pibe/review-seal#readme). The source, tests and issues live in [oo-pibe/review-seal](https://github.com/oo-pibe/review-seal); the review-seal-plugin repository is a copy of its `plugin/` folder for the plugin directory. The project needs a `.seal/config.json`, which the review-seal npm package creates.

## Example uses

- An outreach sequence in `sequences/` must keep its opt-out line and personalisation tokens. Claude edits the email; when the turn ends, the reviewer checks it against that checklist and Claude fixes anything it flags.
- A competitor battlecard gets a fact-check pass with web lookups and a 30-day shelf life, so its prices are re-checked monthly even if nobody edits it.
- A docs page must not contradict itself. Run `/review-seal:review docs/tickets.md` to review it on demand.

To try it with sample data, the [example project](https://github.com/oo-pibe/review-seal/tree/main/example) has a page that contradicts itself on purpose; its README walks through it in about two minutes. No account or server is needed beyond Claude Code.

## Support

Questions and bugs: [GitHub issues](https://github.com/oo-pibe/review-seal/issues). Security reports: [private vulnerability reporting](https://github.com/oo-pibe/review-seal/security/advisories/new), as described in [SECURITY.md](https://github.com/oo-pibe/review-seal/blob/main/SECURITY.md).

## What the plugin runs

- **Three hooks** (PostToolUse, Stop and UserPromptSubmit) run `node` on the CLI bundled in `scripts/`. They note which files changed, start reviews when a turn ends, and pass findings back to Claude on your next message.
- **Reviews** run the `claude` command you already have, as a short background session with read-only tools (Read, Grep, Glob). It never sees the conversation that wrote the file. review-seal starts `claude` with your environment and doesn't look at, store or send your sign-in or any key; Claude Code signs in as usual.
- **`/review-seal:review <file>`** runs a review on demand.

## What it sends and stores

- The file under review and your checklist go to Anthropic through your own Claude Code, like any other session.
- Web lookups are off by default. A pass in your config can turn on web search, which runs through Claude Code's search tool, and page fetches, limited to the hosts you list.
- Results are saved in your repository: `.seal/ledger.json`, plus working files in `.seal/.state/`, which git ignores.
- There is no review-seal server and no telemetry. See [PRIVACY.md](https://github.com/oo-pibe/review-seal/blob/main/PRIVACY.md).

Each review is a model call billed to your Claude plan or API usage. Requires Node 20 or later and git.
