# agent-handoff

An **open file format** for agent session handoff cards, plus a zero-dependency reference
implementation. The filesystem is the bus: cards live in a plain `~/.handoff/` directory —
no API, no daemon.

## Layout

```
~/.handoff/
  pending/     # incoming cards, one .md file per card (root overridable via HANDOFF_HOME)
  archived/    # consumed cards, rolling keep of 50
```

A card is a Markdown file: YAML frontmatter (source pointer, git snapshot, task snapshot)
plus six fixed sections (Goal / Files involved / Where it got to / What's left / Exact stop
point / Reader warnings). Consume-and-discard: loading moves a card from pending to
archived; loading the same id twice is an error. Full definition in [SPEC.md](./SPEC.md)
(Chinese; the format itself is language-agnostic).

## Commands

```bash
handoff push --agent claude-code --session <session-pointer> --title <title> [--file body.md]
handoff inbox                 # list pending cards (id, source, project, pushed_at, first 2 tasks)
handoff load <id>             # consume-and-discard: print full card + git mismatch warnings
handoff export-hippo          # convert a hippo inbox JSON into protocol cards (idempotent)
```

## Repository layout

```
SPEC.md                # the protocol (format + directories + five semantics + versioning)
packages/core/         # @agent-handoff/core: zero-dep TS library — read/write, dirs, git verify
packages/readers/      # @agent-handoff/readers: read-only session discovery/parsing for eight
                       #   agents (claude-code / codex / opencode / zcode / pi / workbuddy /
                       #   cursor / grok)
packages/cli/          # @agent-handoff/cli: push / inbox / load / export-hippo / sessions / pull
skills/handoff/        # 10-line SKILL.md: teach an agent to write cards and check the inbox
```

## Acknowledgements

The storage-format research for the cursor and grok readers referenced
[dsh-resume](https://github.com/aa2246740/dsh-resume) (Apache-2.0; its NOTICE states the
bundled session reader derives byte-for-byte from a skill bundled with xAI Grok 1.0.5).
The adapters here are original TypeScript implementations — format knowledge only, no code
copied. The recovery boundaries carry over as well: grok reads only the visible
`updates.jsonl` stream and never touches the raw `chat_history.jsonl` model context;
cursor imports only supported transcript / store records and never replays stored calls.

## Development

```bash
pnpm install && pnpm -r build && pnpm -r test
```

License: MIT.
