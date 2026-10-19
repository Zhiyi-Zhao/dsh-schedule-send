# dsh-schedule-send

**English** | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Release](https://img.shields.io/github/v/release/Zhiyi-Zhao/dsh-schedule-send?label=release)](https://github.com/Zhiyi-Zhao/dsh-schedule-send/releases)
[![verify](https://github.com/Zhiyi-Zhao/dsh-schedule-send/actions/workflows/verify.yml/badge.svg)](https://github.com/Zhiyi-Zhao/dsh-schedule-send/actions/workflows/verify.yml)

Schedule-send for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): write a message in the composer, pick a time, and the text is delivered into the **same conversation** later as a **normal user message** — exactly as if you had pressed Send at that moment, so the agent answers it and the thread continues.

## Features

- A clock control in the composer tool row, beside the send button.
- Quick picks (30 minutes, 1 hour, 3 hours, tomorrow 09:00) or an exact local date and time.
- The draft is cleared immediately; a persistent card in the conversation records what is queued, when it sends, and offers **Cancel**.
- Durable queue outside the workspace, with catch-up: a send that came due while the app was closed is delivered on the next start.
- The delivered text is a real user message (`source.kind = 'user'`), not a reminder or a system notice.
- Retries with exponential backoff; the send id doubles as the prompt `requestId`, so a retry after a crash cannot deliver twice.
- No build step and no runtime dependencies beyond the page's shared `react` / `react-dom`.

## Why not the built-in reminders?

DSH's built-in Schedule subsystem is a reminder system: it injects a `[SCHEDULE REMINDER]` framing that tells the model to **present** the text to the user instead of treating it as an instruction. A scheduled send needs the opposite semantics — the text must become the user's message and start a turn. This plugin therefore keeps its own durable queue and delivers through the public `ctx.sessionController.prompt(...)` seam, which resumes a cold session when needed and mints an ordinary user message.

## Install

The package declares both a Host half (`index.js`, which owns the queue, the commands, and delivery) and a browser half (`client.js`). There is no build script, so every route installs finished files.

### Option 1: the release tarball (recommended)

Download `dsh-schedule-send-0.1.0.tgz` from [Releases](https://github.com/Zhiyi-Zhao/dsh-schedule-send/releases), then:

```sh
dsh plugin --profile desktop add ./dsh-schedule-send-0.1.0.tgz
```

### Option 2: straight from GitHub

```sh
dsh plugin --profile desktop add github:Zhiyi-Zhao/dsh-schedule-send
```

### Option 3: from a local checkout

```sh
git clone https://github.com/Zhiyi-Zhao/dsh-schedule-send.git
dsh plugin --profile desktop add /absolute/path/to/dsh-schedule-send
```

### Option 4: the Web UI

Open the sidebar's **Plugins** page, choose to install a bundle, and paste one of the specs above (`github:Zhiyi-Zhao/dsh-schedule-send`, a tarball URL, or an absolute path). Installing from the running app needs `danger-full-access` permission or an approval.

> `--profile desktop` names the desktop app's profile. A `dsh web` deployment uses `--profile web`; the bundle works in any profile that composes the Web client. Replace `desktop` with your profile name in every command below.

After installing into the desktop profile, the new bundle can apply through HMR; if it does not appear, restart DeepSeek Harness. Uninstall with:

```sh
dsh plugin --profile desktop remove dsh-schedule-send
```

## Usage

1. Type the message in any conversation (plain text).
2. Click the clock button to the left of Send.
3. Pick a quick time, or set an exact local date and time.
4. Confirm with **Schedule**. The draft is cleared and a "Scheduled send" card appears in the conversation.
5. At the chosen time the message is delivered into that conversation as a normal user message; the agent answers it. **Cancel** on the card works until delivery.

The card stays in the transcript as history. After delivery, Cancel reports that the message already left the queue.

> The package also registers two internal session commands (`schedule-send`, `schedule-send-cancel`) because the session command channel is how a browser plugin reaches its Host half. They appear in the slash menu; you never need to type them — the clock control is the interface.

## How it works

| Step | Where | What happens |
|---|---|---|
| Create | Browser | The composer control calls `ctx.remote.commands.execute('/schedule-send <json>')` with the message, the target epoch, an id, and the browser's IANA zone. |
| Persist | Host | The command handler validates the payload and writes a record to `$DSH_HOME/schedule-send/queue.json` (atomic temp-file rename). |
| Sweep | Host | A 5-second sweep picks due records and calls `ctx.sessionController.prompt({ requestId: id, sessionId, mode: 'queue', content, clientTimeZone })`. |
| Deliver | Host | That public method resumes the session if needed and submits a normal user message; the send id is the dedupe key, so retries are idempotent. |
| Feedback | Browser | The command lifecycle renders as the persistent card through a `conversation.chat.commandview` renderer keyed by the command name. |

## Verified delivery

One real scheduled send, read back from the Host queue (local time, Europe/Copenhagen):

| Field | Value |
|---|---|
| status | `delivered` |
| created | 2026-10-19 12:22:16 |
| target | 2026-10-19 12:24:00 |
| delivered | 2026-10-19 12:24:03 |
| delay | 3.2 s (inside the 5 s sweep interval) |

The delivered text appeared in the conversation as a normal user message and the agent answered it there.

## Limits

- **The app must be running when the send comes due.** DSH has no background scheduler; if the app is closed, the message is delivered shortly after the next start (catch-up). A closed app cannot send.
- **Text only.** A draft with attachments cannot be scheduled; the control is disabled.
- **Delivery resumes the target session and runs a turn**, even when that conversation is not open. It can spend tokens and call tools; approvals still follow that session's policy and may wait for you.
- **About ±5 seconds** of precision (the sweep interval).
- **One-shot only.** There is no recurring schedule and no edit-in-place; cancel and schedule again instead.
- A send that cannot be delivered (the session no longer exists, or the session has no routable model) is retried with backoff up to 60 attempts and then recorded as `failed` in the queue with `lastError`, with a warning in the Host log.
- A corrupt queue file is moved aside as `queue.json.corrupt-<timestamp>` and the plugin starts with an empty queue.

## Compatibility

Verified against DeepSeek Harness **0.2.1-rc.2** in the desktop app.

- Host half: `ctx.commands.register`, `ctx.sessionController.prompt`, `ctx.sessions.flush`, `ctx.agents` — public services only.
- Browser half: the slot API (`conversation.input.right`, `conversation.chat.commandview`), the locale service, and `ctx.remote.commands.execute`; it imports only `react` and `react-dom`, not DSH UI primitives, so minor UI-package changes do not break it.
- If `ctx.sessionController` is absent, scheduled sends stay queued and a warning is logged instead of failing the profile.

## Development

```
index.js              Host half: commands, durable queue, sweep, delivery
client.js             Browser half: composer control, cards, locale dictionaries
cordis.patch.yml      Loader row inserted by the bundle
locale/{en,zh}.json   Display metadata read by the plugin inventory
icon.svg              Bundle icon
scripts/verify.mjs    Static checks used by `npm run verify` and CI
```

- No build, no install step: the browser artifact is a plain closure factory.
- `npm run verify` checks the manifest, exports, locale metadata, both entry files, and the factory id.
- Install a working copy with `dsh plugin --profile <profile> add /absolute/path/to/dsh-schedule-send`.

## License

MIT © 2026 Zhiyi Zhao
