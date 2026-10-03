# Changelog

Notable changes to this fork, newest first. The fork has no version numbers yet, so changes are grouped by the date they landed on main (Pacific time). A change that took several days to finish sits under the day it was finished. Each entry says what was wrong or missing, and what the bridge does now. Most entries list the commits behind them.

## 2026-10-02

### Fixed

- **A message sent while Claude worked was held back when it started with a slash.**
  - **Before:** Claude Code reads a queued message whose last part is text starting with `/` as a slash command and holds it until the turn ends. A file path pasted mid-turn, such as `/tmp/screenshot.png`, never reached the turn it was sent into.
  - **Now:** the bridge adds a short "(Sent while you were working.)" line after such a message, so Claude sees it at the next tool result like any other. Other messages go through unchanged.
- **A large write looked stuck for minutes.**
  - **Before:** the API held back each tool argument until Claude finished writing it. A write showed only its path while the file content was generated, with nothing arriving but keepalive pings, and then the whole content landed at once. A 130 KB file meant about five minutes of no visible progress, long enough that it looked hung and got cancelled.
  - **Now:** the bridge starts Claude Code with `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`, so arguments stream as they are written and Pi's tool display shows the file grow. In a 4 KB test write with Opus, the longest gap between pieces of content dropped from 10 seconds to about one.
- **A rebuild after Esc kept less of Claude Code's session than it could.**
  - **Before:** the rebuild copies Claude Code's own records for the start of the conversation that matches Pi's history, and stopped at the first thinking block that ended in whitespace. Claude often ends a thinking block with a blank line, and Pi can keep the block without it: a Pi extension that labels thinking for display trims the text. In one real session the copy stopped after 78 of 305 messages, and the next request read 19% from the prompt cache.
  - **Now:** a thinking block matches when its signature is the same and Pi's text differs only by that trailing whitespace. The signature is the API's identity for the block, and the copy keeps Claude Code's text, which is what Claude saw. Replayed on that session, the copy reaches 98 of 305 messages. A block without a signature still has to match exactly.
- **The same copy also stopped at a tool call that printed nothing.**
  - **Before:** when a Pi tool returned only whitespace, Claude Code stored the result as `(<tool> completed with no output)`, and the rebuild compared that note with Pi's whitespace, so the copy stopped there. In the same session it stopped after 98 of 305 messages.
  - **Now:** the rebuild applies Claude Code's own rule to Pi's result before it compares them: a successful result that is empty or only whitespace becomes that note, named after the call. A failed result, or one with an image, is compared as before. Replayed on that session, the copy reaches 182 of 305 messages.
- **The same copy also stopped at a prompt the bridge built from several Pi messages.**
  - **Before:** when Pi holds several user messages in a row, such as two notices from an extension, the bridge sends them to Claude Code as one prompt joined with a blank line, and Claude Code stores one record. The rebuild compared that record with each Pi message alone, so the copy stopped there. In the same session it stopped after 182 of 305 messages.
  - **Now:** one prompt record also matches Pi's whole run of user messages when it equals them joined the way the bridge joins them. Messages in another order, a missing one, or only part of the run still end the copy. Replayed on that session, the copy reaches 304 of 305 messages; the last one is the reply that Esc cut off, for which a rebuild writes nothing.

## 2026-10-01

### Added

- **Request timing in the debug log.**
  - **Before:** the debug log could not say where a slow turn spent its time. Its lines name the module copy, not the request, so concurrent requests mixed; it recorded no durations; and it did not say why a turn rebuilt the Claude session instead of resuming it.
  - **Now:** with `CLAUDE_BRIDGE_DEBUG=1`, each Pi request writes one `timing:` JSON line when it ends. The line names the request's lane, kind (a new query, tool results for a live query, or tool results after the query ended), model, message count and outcome. It gives the time from the request's start to each step that happened: the session sync, starting the query, Claude Code's first message and first stream event, the first text Pi received, and the end of the turn. For tool results it also times their release to Claude Code, its answer and its next message.
  - It also records the event-loop delay, CPU and memory around the request, and the time spent writing a rebuilt session, saving the session marker, computing history digests and writing the debug log.
  - When a turn does not resume the session, the `timing:` line and the `syncResult:` line say why, as a short cause, plus the reason the session was marked for rebuild when it was (an abort, an idle timeout, Pi replacing the history, and so on).
  - Without the debug setting nothing is measured.

### Changed

- **Fewer repeated usage lines in the debug log.**
  - **Before:** about half of the `usage:` lines repeated the counters of the line before, because Anthropic reports a message's usage again when nothing changed.
  - **Now:** a `usage:` line that repeats the previous one of the same request is left out, and the request's `timing:` line counts how many were. Usage itself is counted as before.

### Fixed

- **A rebuild after Esc re-sent the whole conversation to the prompt cache.**
  - **Before:** the prompt after an Esc (and any other rebuild of the same account's Claude session) wrote Pi's history out as a new Claude Code transcript. Claude Code's own requests had carried content that never reaches Pi: attachments rendered as system reminders in the first message, after prompts and inside tool results, plus tool results in the form the tool call returned them. The rebuilt session's first request therefore differed from the previous one at its first message, and the prompt cache covered only the system prompt and tools. In real sessions that was 31% cache with 98k tokens written at 182 messages, and 16% with 246k written at 359 messages, where a resumed turn reads 99-100% from cache. It also made the API drop earlier thinking.
  - **Now:** the bridge finds the longest start of Pi's history that Claude Code's old transcript holds with the same content. It copies those records into the new session as Claude Code wrote them, using the SDK's session fork, and imports from Pi only the messages after them. After an Esc during a tool call, that copied part reaches the end of the last request Claude Code sent, so the next request reads it from the cache. When nothing matches, or the old transcript is missing or unreadable, the rebuild imports all of Pi's history as before. The debug log's `Case 4` and `syncResult:` lines, and the `timing:` line's `sync.forked`, show how many of Pi's messages came from the fork.

- **`/reload` threw away the warm Claude session.**
  - **Before:** the prompt after a `/reload` rebuilt Claude's session from scratch under a new session id, with a cold prompt cache. The bridge restored its session record from Pi's saved marker only when Pi started or resumed a session, and a reload drops the record. In one real session that wrote 192k tokens to the prompt cache and took about 10 s to the first token.
  - **Now:** after a `/reload` the bridge restores the record from the marker, as after a Pi restart, and the next prompt resumes the warm session when Pi's history still matches it. It still rebuilds into a new session when the checks fail, and when a Claude Code process may still be writing the session at the reload: a query was still running (RPC and print mode can reload mid-response), or one was just stopped (Esc, an idle timeout) and its process had not exited yet.

## 2026-09-30

### Highlights

- **No automatic bug reports.** The incident system is gone.
- **Agent notices:** with `agentNotices` on, the agent is told about bridge anomalies.
- **Debug log:** it no longer carries tool output or your text.
- **Dropped attempts:** a tool call from a response attempt that Claude Code dropped never reaches Pi.
- **Third-party apps:** the bridge no longer refuses a request over its system prompt. When Anthropic rejects one as a third-party app, the error now says how to fix it.

### Added

- **A fix hint on Anthropic's third-party-app rejection.**
  - **Before:** Anthropic's error said "Third-party apps now draw from your extra usage … Add more at claude.ai/settings/usage", which points at buying Extra Usage instead of the real fix.
  - **Now:** the error keeps Anthropic's text and adds a fixed hint. The hint names Pi's two documentation clauses and says to set `systemPrompt.replacement` in the user `claude-bridge.json`. An extension that copies Pi's full prompt into its own model call has to send its own prompt instead.
  - The hint is fixed text with no paths or other values in it, so it never makes Pi retry or compact on the error.
  - When a reply to a mid-turn message is rejected this way, the warning shows the whole hint after its short excerpt. (`d13aaf7`, `72f6603`, `e8add1e`)
- **Agent notices:** with `agentNotices: true` in the user `claude-bridge.json`, the agent now hears about bridge anomalies it would otherwise never see.
  - That means an error the bridge wrote, or a problem the bridge recovered from on its own, such as a dropped mid-turn message or a tool call left without a result.
  - Each kind is told once per Pi session. The notice goes with your next prompt as a message in the conversation, and is shown in the TUI. Repeats are not told again.
  - Normal cleanup is not told. That covers a cancelled request, a max-tokens stop and a restart on compacted history. Errors reported by the API or Claude Code aren't told either.
  - It is off by default, and a project's `claude-bridge.json` cannot turn it on. `CLAUDE_BRIDGE_DEBUG=1` does not turn it on or off: it keeps the details in the bridge logs, and the notice says where they are, or that they were not recorded.
  - The bridge never sends a message or starts a turn of its own. (`13ff322`, `05a6999`, `13480a9`, `58e3d64`, `cd58ad8`)
- **Versions in the debug log:** it now records what wrote it.
  - When the bridge loads, one line gives the bridge commit, the Pi version and the Node version.
  - Another line gives Claude Code's version the first time a query reports it, and again whenever it changes. (`0946b32`)

### Changed

- **The bridge loads about six times faster.**
  - **Before:** loading the bridge took about 0.45 s on every Pi start, every `/reload` and every subagent child. Nearly all of that went to Pi's loader trying each of the bridge's 166 internal imports as a `.js` file before falling back to the `.ts` file.
  - **Now:** the internal imports name the `.ts` file, and the load takes about 0.07 s. On Pi 0.99.2, a warm start went from 442 ms to 71 ms and a `/reload` from 423 ms to 14 ms. The first start after a pull that changes every file went from 848 ms to 441 ms. These are medians measured while other work kept the machine busy, so absolute times on an idle machine are lower.
  - `npm run check:imports` keeps a `.js` internal import from coming back.
- **Three TUI warnings removed:** they needed nothing from you.
  - The three were parked early tool results, the stream idle timeout (Pi already shows the turn's error), and tool calls that never reached Pi.
  - With agent notices on, the agent is told about each one instead. (`45bd6c7`)

### Removed

- **The incident system**, which builds of this fork carried from 2026-09-28 to 2026-09-30. It included:
  - error texts ending in "(incident bi-…)";
  - a `claude_bridge_incident` tool in every session;
  - `/pi-claude incidents`;
  - the `incidents.repo` setting;
  - GitHub issues that the agent filed.

  Reporting a bug is your call, not the bridge's.
  - **What you see by default:** an error that ends the turn, and a few TUI warnings, such as a rate limit, a repaired or interrupted tool result, or a session file problem.
  - **What stays out of the TUI:** tool-call errors the bridge returns to Claude as the call's result, and problems the bridge recovers from on its own. Agent notices tell the agent about them (see Added), and `CLAUDE_BRIDGE_DEBUG=1` records them in the local logs.

  An `incidents` key left in `claude-bridge.json` is ignored. (`89f090d`)
- **The third-party-app refusal**, added 2026-09-29.
  - **What it did:** the bridge refused any request whose system prompt carried both clauses of Pi's documentation line, `custom providers (docs/custom-provider.md)` and `pi packages (docs/packages.md)`, before Claude Code started. In debug mode, the agent was told about each refusal.
  - **Why it is gone:** some setups send such requests on purpose and make them acceptable their own way, and for them every refusal was a false block.
  - **What replaces it:** the bridge sends every request as it is. The README now requires Extra Usage turned off and `systemPrompt.replacement` set. With Extra Usage off, Anthropic rejects a third-party-app request itself with HTTP 400, and the bridge adds a fix hint to that error (see Added). (`de58c87`)

### Fixed

- **Anthropic's third-party-app rejection rotated accounts.**
  - **Before:** its text mentions extra usage, so the bridge took it for a rate limit. With managed account profiles, the request moved to the next profile, which rejected it the same way, and each profile it tried had a rate limit recorded against it.
  - **Now:** the request ends on the first profile with Anthropic's error. The rejection follows the system prompt, not the account. (`89aaa75`)
- **Pi could run a call from a dropped attempt.**
  - **Before:** Pi could run a tool call from a response attempt that Claude Code had thrown away. When Claude Code retries a response, it aborts the attempt's tools and never uses their results. The bridge, though, kept the attempt's finished calls and waited for a separate cancel message, which can arrive after the retry has finished.
  - **Now:** a dropped attempt's calls are withdrawn at once, and their waiting handlers get an error. (`6120d60`, `e234203`, `0e6b9cf`, `f897b13`, `9efca58`)
- **A rebuild could send a request the API rejects.**
  - **Before, two ways:**
    - It wrote redacted thinking as ordinary thinking, with a signature that didn't match.
    - It imported a modified copy of a latest turn whose thinking was cut off mid-stream.
  - **Now:**
    - Redacted thinking is replayed as `redacted_thinking`.
    - A latest turn that cannot be replayed exactly is imported as a note of what it said and did: its text and calls in order, then the results in the order they came back, with images carried. For a while that turn was dropped instead, and then Claude didn't know it had, for example, written a file. (`71ea6af`, `00b740d`, `3d3c49c`, `e21ea59`, `91f562d`)
- **The debug log carried payloads.**
  - **Before:** with `CLAUDE_BRIDGE_DEBUG=1`, the debug log carried:
    - the start of every tool result, prompt and mid-turn message;
    - your replacement prompt;
    - tool argument names;
    - the text that JSON parse errors quote.
  - **Now:** it logs only the shape: ids, block counts and types, and lengths. (`fb42799`, `159525c`, `27c296e`, `dc1c045`)
- **Two messages pointed elsewhere.**
  - **Before:** the session-file warning asked you to file an issue on another project's page, and the old-Pi error said to pin another package.
  - **Now:** the warning points at the bridge's diag log, and the error says the bridge needs Pi 0.81 or later. (`384b7a0`)

## 2026-09-29

### Highlights

- **Third-party apps:** a request that Anthropic would treat as a third-party app is refused before it is sent. Set `systemPrompt.replacement` to use Pi's main prompt.

### Changed

- **Needs `systemPrompt.replacement`.**
  - **What Anthropic does:** a subscription request is treated as a third-party app when its system prompt carries both clauses of Pi's documentation line: `custom providers (docs/custom-provider.md)` and `pi packages (docs/packages.md)`. Such a request draws from Extra Usage instead of plan limits, and fails with HTTP 400 when the account has no Extra Usage credit.
  - **Who sends both clauses:** Pi's default main prompt, pi-subagents children in append mode, and extension calls that copy Pi's prompt.
  - **What the bridge does:** it refuses such a request before it syncs the session or starts Claude Code. You get one Pi error that names the clauses and the fix, and Pi neither retries nor compacts on it.
  - **The fix:** a replacement drops Pi's documentation section.
  - Only the two exact clauses count. A live test showed that either clause alone passes Anthropic's check, and so do both paths in other wording. (`4c1fc12`, `4748819`)
- **Claude Agent SDK:** updated from 0.3.280 to 0.3.284. The bridge needed no change for it. (`a33a828`)

### Fixed

- **A message cut off mid-stream ended the run.**
  - **Before:** when every tool call in a message was cut off mid-stream, Pi got a tool-use turn with no call and stopped the run. Meanwhile, Claude Code issued the call again under a new id, with no Pi turn left to join.
  - **Now:** Pi's turn stays open for the re-issued call. (`72b96fa`)
- **A rebuilt session resumed as an interrupted turn.**
  - **Before:** Claude Code resumed a rebuilt session as an interrupted turn, and injected "Continue from where you left off." before your prompt.
  - **Now:** it no longer does. (`786afeb`)
- **Compaction during a tool call.**
  - **Now:** when Pi compacts while Claude waits on a Pi tool, the query restarts on Pi's new history, with the completed tool results. Draining the replaced query counts as normal cleanup, not as an error. (`bcb455c`, `ff53882`, `ea0553d`)
- **Each query read the whole Claude Code binary.**
  - **Before:** each fresh query read the whole binary, over 200 MB and 20–30 ms, just to check its first 16 bytes. A binary over 2 GiB failed the check.
  - **Now:** the check reads only those 16 bytes. (`9a21e51`)

## 2026-09-28

### Highlights

- **Tool calls:** each MCP call is matched by the id Claude Code tags it with, so calls can no longer get each other's results.
- **Messages sent while a Pi tool runs:** they reach Claude before that tool's result, so they change Claude's next step instead of arriving after the whole reply.
- **Claude Sonnet 5.5** is in Pi's model menu.

### Added

- **Claude Sonnet 5.5** (`pi-claude/claude-sonnet-5-5`) is now in Pi's model menu.
  - Claude Code 2.1.284 serves it, but Pi's registry does not list it, so the bridge registers it with its own metadata: 1M context, 128K output, text and images, and xhigh and max effort.
  - Claude Code rejects disabled thinking for it, so Pi hides "off".
  - When it refuses, Claude Code uses its own fallback model. (`9b251d8`)

### Fixed

- **A call could get another call's result.**
  - **Before:** a call could get another call's result, or an internal "no matching tool_call id" error while Pi still ran the tool. Claude Code can run an MCP call before the bridge has read the tool_use it belongs to, and the bridge matched calls by name and arguments.
  - **Now:** each call is claimed by the tool_use id Claude Code tags it with, and a tagged call only ever touches its own id.
    - A duplicate call joins the first one's wait.
    - A call for an answered or dead id gets an explicit error.
    - Untagged calls still match by name and arguments. (`2c4e74c`, `96684e7`, `b50a7ef`)
- **A mid-turn message arrived too late.**
  - **Before:** a message you sent while a Pi tool ran reached Claude only after the whole query ended, so Claude finished the original instruction first.
  - **Now:** it is written to the running query before the tool results, so Claude's next response follows it.
  - It is sent with priority "next", because "now" makes Claude Code discard the pending tool's result. (`9233eed`)
- **A failure after the tool turn went unreported.**
  - **Before:** when Claude Code failed after its tool turn reached Pi, Pi ended the turn as if Claude had finished. For example, the process died, or a usage limit was hit while Pi ran the tool.
  - **Now:** the failure is reported once, with the tool-result callback that follows, including when a steer rides along with it. (`23d460d`, `99c8a0f`)
- **A refusal on Opus 5.5 failed the request.**
  - **Before:** when Opus 5.5's classifier declined a turn, the request failed instead of continuing on Opus 4.8.
  - **Now:** it continues on Opus 4.8. Every model switch Claude Code makes after a refusal is announced, not only the one the bridge configures. (`88ef4cb`, `7223a0a`)
- **Thinking "off" didn't turn thinking off.**
  - **Before:** Pi's "off" thinking level still let Claude think on every turn.
  - **Now:** "off" sends Claude Code disabled thinking.
    - Fable 5.1, Opus 5.5 and Sonnet 5.5 reject disabled thinking, so Pi hides "off" for them.
    - A level that a model's `thinkingLevelMap` marks as null sends no effort. (`7920ebf`, `30090a3`, `dca0ac2`)
- **The replacement cut too much.**
  - **Before:** under a replacement, a session's own base prompt was cut away, so pi-subagents children in replace mode never saw their instructions. That base prompt comes from `SYSTEM.md`, `--system-prompt`, or a pi-subagents agent in replace mode. Pi's `<rules>` section, and the sections Pi placed before its tools, were lost too.
  - **Now:** the replacement swaps out only Pi's default preamble, tools and docs. Fixes [#1](https://github.com/nicobailon/pi-claude-bridge/issues/1). (`ae0c56e`, `21bfa66`, `1544ff8`)

## 2026-09-27

### Highlights

- **Keeping Claude's session in sync:** before reusing Claude's session, the bridge checks it against Pi's history, and rebuilds it when Pi rewrote something Claude already holds.
- **Tools:** every Pi tool reaches Claude under a name it can call, with its real JSON Schema. That includes tools an extension turns on mid-turn.
- **Loading:** Pi loads the bridge from its TypeScript source, and `/reload` picks up changes.

### Added

- **Thinking tokens:** Pi now sees how many output tokens Claude spent thinking, in `usage.reasoning`.
  - Before, Claude Code reported them, but the bridge mapped only the input, output and cache counts.
  - They are not added to `totalTokens` or cost a second time, because the output count already includes them. (`032e449`)

### Changed

- **Loading:** Pi now loads `src/index.ts` directly instead of a committed esbuild bundle, so there is nothing to rebuild and `/reload` picks up an edit. (`4e044a6`)
- **Anthropic environment variables:** Claude Code children no longer inherit `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.
  - Before, an exported one silently routed subscription turns through another gateway or credential.
  - To use a gateway on purpose, set `provider.inheritAnthropicEnv: true` in the user `claude-bridge.json`. A project config cannot set it.
  - A stripped key no longer makes Pi report the provider as connected. (`f217e0c`)
- **Log growth:** the debug and diag logs now rotate at 10 MiB and keep three old files. Claude Code CLI logs older than seven days, or beyond the newest 100, are pruned. Before, all three grew for as long as debugging stayed on. (`e9f1a1a`)
- **CI:** the typecheck, an export guard and the unit tests now run on every push and pull request. (`a425a42`)
- **Integration tests:** they now run pi-intercom, and extension side calls made while a tool runs, through real Pi and Claude Code. (`4fb2c33`, `afe5ef8`)

### Fixed

#### Tool calls

- **A stalled response lost its retry.**
  - **Before:** when a streamed response stalled, Pi got the truncated attempt ("Readi") and never the retry. If the dropped attempt had started a tool call, Pi could run it with `{}` arguments.
  - **Now:** the retry replaces the dropped attempt. Pi's stream stays append-only, and the message Pi keeps leaves the dropped blocks out. (`b0c5149`)
- **A slow Pi tool lost its result.**
  - **Before:** a Pi tool that ran longer than Claude Code's MCP limits lost its result, because Claude Code answered the call itself. With `MCP_TOOL_TIMEOUT=300000` exported in the shell, a `gh run watch` call failed after 5 minutes.
  - **Now:** the bridge's tool server declares the longest timeout Claude Code accepts, and turns off automatic backgrounding. A Pi tool runs until Pi ends it. If Claude Code still gives up on a call, you get a warning that Claude won't see its result. (`bb13968`)
- **Tools turned on mid-turn reached Claude late.**
  - **Before:** a tool that an extension turns on mid-turn, such as `subagents_enable` or `web_enable`, did not reach Claude until the next prompt.
  - **Now:** the running query serves Pi's current tools, and holds the result that turned them on until Claude Code has re-listed them. (`68314bf`)
- **Some tool names could not be called.**
  - **Before:** Claude could not call a Pi tool whose name has spaces, slashes or dots. A name that made the MCP name longer than 128 characters failed every request.
  - **Now:** such a tool is served under a valid, stable alias. A name that is already valid keeps it, so existing sessions and prompt caches are unchanged. (`45fbc51`)
- **Claude saw a lossy copy of each tool's parameters.**
  - **Before:** `$ref`, `oneOf`, nullable types, formats and constraints were lost in a Zod conversion. The SDK then rejected arguments that Pi would have accepted.
  - **Now:** Claude sees each tool's JSON Schema as Pi declares it, plus the `$defs` it refers to, and only Pi validates the arguments. A schema part that is not valid JSON Schema 2020-12 is sent without its schema, because otherwise Anthropic rejects every request in the session. (`23832e4`)
- **Later calls in a message were cut off.**
  - **Before:** when Claude wrote several tool calls in one message, the bridge sometimes cut off later ones while their arguments were still being written. A call with long arguments can stay silent for several seconds, which outlasted the 1.5-second grace timer.
  - **Now:** any stream event restarts the grace period. For a call whose handler has already run, the turn waits for as long as the idle timeout. (`f77c15e`)
- **A truncated tool call could run.**
  - **Before:** a truncated tool call could reach Pi and run, at the end of a query, on abort, and on every error path. Pi runs the tool calls in any final message.
  - **Now:** unfinished calls are dropped from the message Pi keeps, and they are no longer reported as missing results afterwards. (`9457e0c`, `204f1b5`, `e04b880`)
- **A late sibling call went to a used turn.**
  - **Before:** a repeated SDK message could reveal a sibling tool call late. It was appended to a turn Pi had already consumed.
  - **Now:** it runs in the next turn. (`72faa4f`)
- **Error messages broke Pi's encoder.**
  - **Before:** building an error message deleted the unfinished tool call from the live Pi message, and Pi's frame encoder then threw "toolcall_start event has no content block".
  - **Now:** error messages are built from a copy. (`695646a`)

#### Mid-turn messages and failures

- **A mid-query message could be lost.**
  - **Before:** a message sent mid-query, such as a steer or an intercom message, could be recorded by Pi and never reach Claude, when anything followed it in the context.
  - **Now:** every user message gets an owner before the cursor passes it. Either it is queued for Claude, or a rebuild re-imports it. (`989095f`)
- **A prompt sent right after Esc was lost.**
  - **Before:** it was taken as a callback of the aborted query, and dropped along with it.
  - **Now:** the aborted query leaves its lane at once, so the next prompt starts fresh. (`42fa518`)
- **A failed follow-up erased a finished reply.**
  - **Before:** when the follow-up query for a mid-turn message failed, the whole Pi message became an error turn, including the reply Claude had already finished. Every reader of Pi history skips error turns, so that reply was lost for good.
  - **Now:** the bridge ends the message as a normal reply holding the completed part, and warns you to send the mid-turn message again.
  - **Also fixed:**
    - A follow-up's reply no longer replaces the reply before it in the same Pi message; both stay.
    - A follow-up that repeats an earlier reply, such as "OK" twice, is no longer dropped as a duplicate.
    - Esc during a follow-up now interrupts Claude, including when a query spans two Pi runs. (`3190fc9`, `566a828`, `d79094d`)
- **A silent child could hang the turn.**
  - **Before:** a Claude Code child that went silent after its first output could hang the Pi turn forever, and an abort could wait forever on a child that ignored it.
  - **Now:**
    - The idle watchdog covers the whole stream, and pauses only while a Pi tool runs.
    - Abort teardown finishes within 5 seconds.
    - After an idle timeout, the message says what actually happens next instead of promising a retry. (`d16333a`, `1ffff5d`)

#### Sessions and other requests

- **Claude kept answering from an old copy.**
  - **Before:** when Pi rewrote an earlier message, through a `context_edit` or an extension transform, Claude kept answering from its old copy for the rest of the session. Reuse only compared message counts.
  - **Now:** the bridge stores a digest of the history Claude holds, and rebuilds Claude's session when Pi's history no longer matches. The digest ignores tool-result bodies, so extensions that prune old results do not cause rebuilds. (`7fc89a5`, `c9e6d23`, `53dea3d`)
- **A side call took over the main query.**
  - **Before:** an extension's side call through `ctx.modelRegistry`, made while the main turn waited on a tool, took over the main query. Examples are a reviewer, a summary, or MCP sampling. The side call never got an answer, the main query lost its tools, and its session was rebuilt twice.
  - **Now:** a request joins a running query only if it carries a tool call that the query gave Pi. Anything else runs as its own query.
  - A side call to an idle conversation no longer costs that conversation its warm session. (`879243b`, `ca6344e`)
- **After `/new`, Pi answered with another model.**
  - **Before:** after `/new`, fork or resume, the provider stayed registered against the old session, and Pi quietly answered with another model.
  - **Now:** the provider stays registered for the current session. (`b1dd93d`)
- **pi-subagents marked successful children as failed.**
  - **Before:** the bridge replaced the message's `model` with the dated id Claude Code reported.
  - **Now:** `model` stays the Pi model id, and the model that served the reply goes into `responseModel` when it differs. (`d8e7311`)
- **The replacement hit every system prompt.**
  - **Before:** `systemPrompt.replacement` applied to every system prompt. pi-prune's summarizer and Pi's own compaction summaries got the replacement instead of their instructions.
  - **Now:** it applies only to Pi's main agent prompt. (`9f05ea1`)

## 2026-09-22

### Added

- **Claude Opus 5.5** (`pi-claude/claude-opus-5-5`) is now in Pi's model menu. It needs Claude Code 2.1.280 or later. (`bfdcc6a`)

## 2026-09-21

### Fixed

- **Pi 0.86 transcript contexts** are supported. (`b0a5d64`)

## 2026-09-12

- The fork starts. (`bbb8146`)
