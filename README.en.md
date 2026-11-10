# pi-goal-compact

[Русская версия](README.md)

A [Pi](https://github.com/badlogic/pi-mono) extension that carries long-running work toward a goal across many context windows and compacts context without losing what the owner actually asked for.

> **Status: in development.** The extension does not register anything in Pi yet. It is too early to use it.

## Why

A long agent run outlives a single context window. Every compaction replaces history with a summary, and after a few compactions the agent is working from its own summary of a summary: the owner's original words are no longer in the window. The work does not stop; it drifts.

Goal tracking and context compaction solve the same problem — getting the work to what was agreed. So this is one extension rather than two that negotiate what the model sees at the start of a window.

## Origin

The extension continues [pi-codex-goal](https://github.com/datspike/pi-codex-goal) and [context-compaction](https://github.com/datspike/context-compaction) and replaces both. See [NOTICE](NOTICE).

## Development

```sh
npm install
npm run verify
```

Repository rules are in [AGENTS.md](AGENTS.md), the workflow in [docs/workflows.md](docs/workflows.md), accepted decisions in [docs/adr/](docs/adr/README.md). These documents are written in Russian; the Russian README is the source of truth.

## License

MIT, see [LICENSE](LICENSE).
