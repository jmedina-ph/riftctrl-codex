# `commands/` — how each dedicated server is commanded

One JSON file per game, named `<slug>.json`, plus a generated `index.json`. Each file answers a single
question: **when RIFT//CTRL needs to list players, kick someone, ban someone, or say something to the
server — what exactly does it send, and down which pipe?**

This dataset exists because **nothing else publishes it.** The sources RIFT//CTRL already aggregates —
AMP templates, Pelican eggs, PufferPanel, LinuxGSM, WindowsGSM, GameDig — cover installing and
configuring a server. None of them cover commanding one. That gap is why these files are written by
research rather than fetched.

## The four operations that matter

Everything else is a bonus. These four are what the product's UI already offers on every server, so
they are the bar a game has to clear:

| Operation | Field | Why it's the floor |
|---|---|---|
| Who's connected | `commands.listPlayers` + `playerParse` | Every other action needs someone to act on |
| Kick | `commands.kick` | The common case; reversible |
| Ban | `commands.ban` (+ `banList`) | The permanent one; must target the right id |
| Broadcast | `commands.say` | The only way to talk to players mid-session |

A game that supports none of them is **not a failure to record** — see "none" below.

## Shape

`schema.json` in this directory is the authoritative contract (JSON Schema draft-07) and is what
validation runs against. The field names deliberately match the `ConsoleDescriptor` the RIFT//CTRL
runtime already compiles, so a file here needs no translation layer to be consumed.

Illustrative only — **the values below are a shape demonstration, not verified data.** A real file's
values come from the research pipeline with its own sources attached.

```json
{
  "schemaVersion": 1,
  "slug": "examplegame",
  "game": {
    "displayName": "Example Game Dedicated Server",
    "appId": 123456,
    "aliases": ["EG", "Example Game"]
  },
  "transport": "rcon",
  "rcon": {
    "flavour": "source",
    "defaultPort": 28016,
    "enableSetting": "rcon.web",
    "portSetting": "rcon.port",
    "passwordSetting": "rcon.password"
  },
  "playerId": {
    "label": "Steam ID",
    "example": "76561198000000000",
    "pattern": "7656119[0-9]{10}"
  },
  "commands": {
    "info": "serverinfo",
    "listPlayers": "playerlist",
    "kick": "kick \"{playerId}\" \"{reason}\"",
    "ban": "banid \"{playerId}\" \"{reason}\"",
    "unban": "unban \"{playerId}\"",
    "say": "say \"{message}\""
  },
  "playerParse": {
    "mode": "regex",
    "linePattern": "^(?<playerId>7656119[0-9]{10})\\s+(?<name>.+?)\\s{2,}",
    "skipLinePattern": "^id\\s+name"
  },
  "sources": [
    { "url": "https://example.com/docs/admin", "kind": "official", "retrievedAt": "2026-09-11" },
    { "url": "https://wiki.example.com/RCON", "kind": "wiki", "retrievedAt": "2026-09-11" }
  ],
  "confidence": "high",
  "researchedAt": "2026-09-11",
  "verifiedAt": null,
  "notes": ""
}
```

## Rules that are not obvious

**Write the command as a person would type it.** No leading slash unless the game itself requires one.
Copy the casing the game uses. These strings are sent verbatim.

**Only these placeholders exist:** `{playerId}`, `{playerName}`, `{message}`, `{reason}`, `{duration}`.
Each field's schema description lists which it may use. Invent no others — an unrecognised token is sent
to the server as literal text.

**`playerId` is not cosmetic.** Games moderate by different identifiers — Steam ID, in-game UID,
username — and the wrong one means kick and ban run, report success, and affect nobody. If the game
kicks by *name*, say so: `label: "Username"`, and a `pattern` that matches a name.

**`playerIdFromEnd` counts from the end on purpose.** Player names contain the delimiter more often than
you would think; counting from the left breaks on the first player called `Bob, Jr`.

**`"transport": "none"` is a real, valuable answer.** Some games ship no console, no RCON and no admin
API — Enshrouded is the known example. Recording that is not a blank; it tells the runtime to stop
probing and drop straight to the host-level floor, which reaches kick and ban through the network layer
regardless of what the game supports. A `none` file must carry `notes` explaining the basis, and must
carry no commands. **Never invent commands to avoid an empty file.**

**`confidence: "high"` needs two independent sources.** This is the same two-source rule RIFT//CTRL
already applies to launch-argument forms and ports: one page, however official it looks, is `low`. Two
community posts quoting each other are one source, not two.

**`researchedAt` is not `verifiedAt`.** Research says a command was published. Verification says it was
run against a live server and observed to work. Only set `verifiedAt` for the second. Most files will
sit at `verifiedAt: null` for a long time, and that is honest.

**Commands change when protocols change, not when games patch.** Palworld moved from one RCON dialect to
another; that is the kind of event that invalidates a file. A routine content update is not. When
revising, keep the old value in `notes` with the date rather than silently overwriting.

## REST games: how an operation is CALLED

A game with a REST admin API needs more than a port. RCON and console games carry a line of text; a REST game needs a
**method, a path and usually a body** — so `rest.ops` says how each operation is called:

```json
"rest": {
  "defaultPort": 7777,
  "basePath": "/api/v1",
  "auth": { "type": "bearer", "credentialSetting": "AdminToken" },
  "ops": {
    "listPlayers": { "method": "POST", "path": "", "body": { "function": "QueryServerState" } },
    "kick":        { "method": "POST", "path": "", "body": { "function": "Kick", "data": { "playerId": "{playerId}" } } },
    "say":         { "method": "POST", "path": "", "body": { "function": "Broadcast", "data": { "message": "{message}" } } }
  }
}
```

- **`path` is appended to `basePath`**, and may be EMPTY when the whole API is a single endpoint with the operation named
  inside the body — Satisfactory works exactly this way.
- **Only `{playerId}` and `{message}`** may appear, in the path or anywhere in the body, at any depth. `{reason}` and
  `{duration}` are not filled for REST.
- A value carrying a newline or other control character is **refused rather than sent**.
- Without `ops`, a REST game can be described but never commanded — it is research, not a manageable game.

Added 2026-09-25, after the first four REST games (Killing Floor 2, Satisfactory, Space Engineers, Farming Simulator 19)
were published with their endpoints written into `notes` as prose, because the schema had nowhere to put them.

## `index.json`

Generated, never hand-edited. One row per file, so a client can resolve a game without fetching every
file:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-11T20:30:00Z",
  "games": [
    {
      "slug": "examplegame",
      "displayName": "Example Game Dedicated Server",
      "appId": 123456,
      "aliases": ["EG"],
      "transport": "rcon",
      "confidence": "high",
      "verified": false,
      "updatedAt": "2026-09-11"
    }
  ]
}
```

## How a file gets here

Cards are researched and proposed on a Trello board, approved by hand, and committed by a scheduled
GitHub Action. Approval is a human step on purpose: the cost of a wrong command is a moderation action
that appears to work and does nothing.

Two things the publishing job must respect, because this repo has a second scheduled workflow:

1. It stages **`commands/` only** — never `data/`, which belongs to the app-list job.
2. It runs `git pull --rebase origin main` before pushing, and on an offset cron, so the two jobs do not
   collide on the hour and silently lose a run.

## Consuming this

Fetch over the raw URL, the same way every other RIFT//CTRL source is fetched:

```
https://raw.githubusercontent.com/jmedina-ph/riftctrl-codex/main/commands/index.json
https://raw.githubusercontent.com/jmedina-ph/riftctrl-codex/main/commands/<slug>.json
```

A client should treat a missing file as "unknown, go and probe", never as "unsupported" — absence means
nobody has researched it yet.
