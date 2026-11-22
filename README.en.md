[Русская версия](README.md)

# pi-goal-compact

A [Pi](https://github.com/badlogic/pi-mono) extension for long-running agent work. It carries the work toward a goal across many context windows and compacts context without losing what the owner actually asked for.

One extension replaces two earlier ones: [pi-codex-goal](https://github.com/datspike/pi-codex-goal) (long-running goals) and [context-compaction](https://github.com/datspike/context-compaction) (context window and compaction summaries). Sessions started with them open and continue as they are.

> **Status.** The extension works and is tested, but it is not published to npm. Version `0.0.0`, installed from a local checkout. The cache-preserving append compaction lives in an experimental branch: it is off by default, turns on for the current window with `/context append on`, and falls back to a standard summary with a visible reason whenever it cannot apply.

## Why

A long agent run outlives a single context window. Compaction replaces history with a summary. After a few compactions the agent is working from a summary of a summary: the owner's original words are no longer in the window. The work does not stop; it drifts. The goal gets closed when the counters add up, not when the requested result exists.

Tracking a goal and compacting context serve one purpose: finishing the work that was agreed on. That is why this is a single extension. Two separate parts used to negotiate what the model sees at the start of a new window. Now one place decides.

## What the owner gets

**The agreement in every window.** When setting a goal, the agent records an agreement in three parts: what the owner wants, what the agent decides on its own without confirmation, and when the work is done. After every compaction the agreement sits at the start of the window right after the summary, so the model sees it, not only its own retelling. Until the next compaction the start of the window does not change: it holds the agreement revision as of compaction. A new revision arrives in the `amend_goal` result and closing arrives as a note in the `update_goal` result, both at the end of the window. Changing the start of the window would reset the provider cache for the whole history after the summary. A different goal set after compaction moves to the start of the window at once.

**"Decided by me" as a separate list.** Assumptions and choices the agent made without the owner do not dissolve into the goal text. Only the owner can confirm or reject an item.

**Closing with a question.** The first attempt to close a goal returns the agreement to the agent. It has to answer in its own words how the work meets each of the owner's requirements. Counters and green checks confirm bookkeeping, not the result. The agent passes its verification text straight to `update_goal`, so closing usually takes two calls.

**A summary that keeps the intent.** The compaction summary keeps the owner's words about the goal verbatim, the status of each decision (accepted, open, rejected), every related object (merge requests, branches, environments), the source of each step and exact paths. The goal's own control instructions stay out of the summary. Messages that arrive during compaction, such as subagent notifications, do not cancel it: they stay in the window right after the summary.

**Work without extra nudging.** While a goal is active and the agent is idle, the extension continues the work with a hidden message. When the agent tries to end its turn with the goal still open, the message asks it to check the work against "Done when": continue with an unmet item, or close the goal with a verification. It accounts time and tokens, pauses the goal on Esc, and survives provider errors, context overflow, restarts and `/reload`. When the agent is waiting for the owner's answer, there are no continuations.

In a native subagent fork, the parent's Goal remains history: it neither starts a turn nor controls the child's completion. The child can create its own Goal, which survives restarts and `/reload`. Interactive forks keep their previous continuation behavior.

**Lean protocol.** Without a goal the model sees a single goal tool, `create_goal`. The others appear once a goal is set and leave at the next window boundary after it closes: removing them at once would reset the cache. Smooth work needs no service calls on the way: coherent chat text counts as a report, the plan and the report for the same milestone go into one `update_goal_work`, and every goal tool response carries the fresh plan revision. Language remarks about a report arrive in the response as `languageNotes` and block nothing.

**A controlled window.** Context window modes: an economy mode by default, an enlarged window for one compaction or for the whole conversation. The footer shows how full the window is, the compaction threshold and the goal state.

## Installation

Requires Pi 1.5 and Node.js 22.19 or newer.

```sh
git clone <repository URL> pi-goal-compact
cd pi-goal-compact
npm install --omit=dev
pi install "$PWD"
```

If `pi-codex-goal` and `context-compaction` are installed, remove them from Pi's `settings.json` first. Next to the new extension they duplicate tools and commands. To roll back, restore the two old entries and remove the new one.

## Usage

Tell the agent you want to set a goal and describe the result. Before calling `create_goal`, the agent asks in one batch about everything that changes scope, design or acceptance and is not settled yet. If you asked it to work without questions, it does not ask and records its assumptions under "decided by me" instead.

From there the agent works on its own. It reports progress briefly in chat; a separate `report_goal_progress` call is needed when it waits for an answer, hits a blocker or verifies the result. It also records decisions and deferred issues, and closes the goal only after checking against the agreement. The goal document lives in `.pi/goal-compact/<goalId>/GOAL.md` inside the project. It is regenerated from the goal data and is read-only.

### Commands

| Command | What it does |
|---|---|
| `/gs` | Short goal status |
| `/gw` | Work overview: plan, next step, link to the goal document |
| `/gp` | Pause the active goal |
| `/gr` | Resume a paused goal without a new model request |
| `/gc` | Clear the current goal |
| `/context [status\|append on\|append off\|economy\|long-once\|long-chat\|off]` | Show or change the context window mode |

### Model tools

Without a goal the model is offered only `create_goal`; `checkpoint_compact_continue` is available when its feature flag is enabled.

| Tool | Purpose |
|---|---|
| `create_goal` | Set a goal with an agreement and a "decided by me" list |
| `get_goal` | Read the goal: in full, as a status, or its history |
| `update_goal_work` | Update the work plan and, if needed, publish the report for the same milestone |
| `report_goal_progress` | Publish a report: waiting for an answer, blocker, verification |
| `record_goal_note` | Record a decision, a "decided by me" item or a deferred issue |
| `amend_goal` | Extend the agreement after an owner message |
| `resume_goal` | Resume a paused goal on the owner's word |
| `update_goal` | Close the goal with a verification text |
| `checkpoint_compact_continue` | Save a checkpoint, compact context and continue the same task |

### Switch models after compaction

`/model-next` opens a model picker for the next successful compaction. `/model-next-now` requests compaction and switching after the current turn without interrupting a running tool. Both work with or without a goal: no argument opens search, an exact `provider/model` selects directly, and a partial name opens search with that text. Autocomplete and an optional `--thinking medium` (or another supported level) are available.

`/model-next status` shows a pending transfer; `/model-next cancel` cancels it. Once model application is in progress, wait for its result before cancelling. Pending transfers survive `/reload` and restarts; navigating to another branch or session, or manually choosing a model, cancels them.

The previous model writes the summary. The new model is applied only after compaction is saved; goal pauses and owner-decision holds remain in force. An idle session without an active task does not start new work.

If compaction fails or you cancel it, the transfer stays queued and is applied by the next successful compaction: running `/compact` again is enough. Until then work continues on the previous model. A failed summary request is retried twice automatically; each retry and the failure reason are reported as a warning. A turn that starts during manual compaction, for example from a subagent notification, waits for it to finish: after successful compaction it goes to the new model with the compacted window; after failure it continues on the previous model; if the owner cancels compaction, the waiting turn is not sent.

If compaction is saved but the new model cannot be applied or the compacted context does not fit it, the transfer stops and reports why: cancel it or select the model again. Until it is resolved, turns are not sent, and every stopped turn names the reason and both commands. Smaller-window capacity is checked using an estimate of the summary, recent tail, system instructions and tools, not the provider's exact tokenizer. System instructions and the recent tail remain in the new model's input; cache transfer is not promised.

### Window modes

- `economy` — the default: a window of at most 272 thousand tokens; Pi starts compacting at about 256 thousand.
- `long-once` — up to 372 thousand until the next successful compaction, then back to `economy`.
- `long-chat` — up to 600 thousand for the whole conversation.
- `off` — the model registry window without the extension's cap.

Enlarged modes turn on only if the model's entry in Pi's registry declares such a window and a pricing tier for it. The extension does not edit `models.json`: the window is overridden for the current session only.

### Append compaction for the current window

`/context append on` enables continuing the last working request to produce the summary; `/context append off` turns it off. The choice lasts until `/new`, and a new window starts with the mode off. The state is shown by `/context status`: `append=on`, `append=off`, or `append=forbidden` when settings do not allow it.

While the summary runs, the working line says `Compact: append on the last request cache` or `Compact: standard summary`, not generation. After compaction the feed keeps a card: `◆ append compact · cache hit 92% · 258.8k → summary ~4.1k · 12.3 s · $0.0208`, and expanding it shows the separate append time, its cost and the model. If append did not apply, the owner sees `◆ standard compact · append fallback (<reason>)` in the warning colour, and the same reason stays in the expanded card instead of only flashing by as a notice.

Every compaction result is also recorded machine-readably in `goal-compact-compact-metrics`: the kind of compaction, the cache outcome, sizes before and after, time, cost and the fallback reason. That record is what makes the mode reviewable after the session, not only in the moment.

## Settings

Language and the compaction window are set in Pi's `settings.json`:

```json
{
  "contextCompaction": {
    "language": "en",
    "compactCapabilities": []
  }
}
```

- `language` — `ru` (the default) or `en`: the language of goal prompts, summaries and notifications. The older `summaryLanguage` key is also read.
- `compactCapabilities` — verified windows of the summary request for exact provider routes. Use it when a route actually accepts more than the registry declares.
- `appendCompaction` permits append but does not enable it: `false` and `true` both leave the mode off until the owner turns it on in the window with `/context append on`. This extension does not change the working installation or its settings.

Goal behavior is configured in `goal-reports.json`: globally in Pi's agent directory and per project in `.pi/goal-reports.json`. The project file overrides only the fields it names; feature switches are merged one by one.

```json
{
  "afterActiveSeconds": 500,
  "afterAssistantTurns": 30,
  "maxHiddenContinuations": 0,
  "features": {
    "agreementInWindow": true,
    "completionReturn": true,
    "selfDecidedList": true,
    "askBeforeGoal": true,
    "singleFactOwner": true,
    "ownerRepliesWithoutGoal": true,
    "amendNeedsOwner": true,
    "checkpointCompactContinue": false
  }
}
```

`afterActiveSeconds` and `afterAssistantTurns` set how often the agent publishes a report. `maxHiddenContinuations` limits hidden continuations in a row without an owner message; `0` means no limit.

The switches in `features` change one improvement without touching the others. Goal settings reload when opening a session or switching branches; the checkpoint registration flag is read when loading the extension.

| Switch | What it turns on |
|---|---|
| `agreementInWindow` | The agreement at the start of the window right after the summary |
| `completionReturn` | The first close attempt returns the agreement |
| `selfDecidedList` | The "decided by me" list; only the owner changes an item's state |
| `askBeforeGoal` | The rule to ask questions before setting a goal |
| `singleFactOwner` | Each fact lives in one place: the summary does not retell the goal, the continuation does not repeat it |
| `ownerRepliesWithoutGoal` | Without a goal, the owner's latest messages follow the summary verbatim |
| `amendNeedsOwner` | An agreement change is accepted only after a real owner message |
| `checkpointCompactContinue` | Offers `checkpoint_compact_continue` to the model; defaults to `false` |

To restore the tool, set `features.checkpointCompactContinue: true` in `goal-reports.json` and run `/reload` or restart Pi in the project directory. With `false`, the tool is not registered at all. The flag does not change automatic threshold or overflow compaction, `/compact`, `session_before_compact`, or `session_compact`.

`create_goal` always requires an agreement; the switches do not change that.

## Moving from the earlier extensions

- Goals, reports and records of `pi-codex-goal`, and the window mode and cards of `context-compaction`, are read from session logs under their old names. Logs are not rewritten.
- Documents of goals started with the earlier extension keep growing in the old `.pi/pohuy-goal/` directory. New goals are written to `.pi/goal-compact/`.
- A goal from the earlier pair has no agreement. The window shows the old goal text instead.
- Before compaction, the goal's hidden continuations are removed from the summary input, including those written by the earlier extension. The very earliest continuation wordings are recognized neither by the new version nor by the old one. In the summaries we checked, the model did not carry them over.

## Limitations

- Append compaction exists only in this experimental branch; it is not deployed to the working installation or Pi settings.
- Append does not promise a provider cache hit: with a short prefix or after a route change the miss shows up in the card as a warning.
- With an already applied summary (`previousSummary`) append always yields to a standard summary and leaves the `previous-summary` reason in the card.
- The model writes the agreement in its own words. The extension stores it unchanged, but how faithful the retelling is depends on the model.
- With `language: "en"` the summary instruction does not name a language explicitly: over a Russian conversation the summary comes out in Russian.
- An RPC `compact` command in the middle of a turn aborts the turn, and the goal pauses. A manual `/compact` while idle does not.

## How it is verified

- `npm run verify` in one command: types, layers and dead code, 891 tests, a check that the tree contains no private paths, and the TLA+ models.
- Two TLA+ models in `formal/`: continuation with holds, and the agreement with closing. Each property has a deliberate defect that makes the check fail. The approach is described in [decision 0008](docs/adr/0008-formalnaya-proverka.md) (in Russian).
- Smoke runs on real Pi without network: an answer to a question survives compaction and restart, a session of the earlier pair continues under the new version, a goal change without an owner message is rejected.
- Model scenarios that used to catch failures: verification loops instead of closing, four merge requests lost after compaction, a decision accepted without consent, closing on counters instead of the result. The new version passes them no worse than the earlier pair.

## Development

```sh
npm install
npm run verify
```

Repository rules are in [AGENTS.md](AGENTS.md), the process in [docs/workflows.md](docs/workflows.md), accepted decisions in [docs/adr/](docs/adr/README.md). Project documents are written in Russian. The TLA+ models need Java; `npm run check:formal` downloads `tla2tools.jar` on first run.

## Origin and license

The core is written from scratch. Proven modules are carried over from `pi-codex-goal` (upstream: [fitchmultz/pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal)) and `context-compaction` together with their tests. See [NOTICE](NOTICE).

MIT, see [LICENSE](LICENSE).
