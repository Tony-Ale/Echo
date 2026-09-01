# Live Integration Test Suite

This suite checks Echo through the browser staging group using real configured
models, Supabase, Google Sheets and Pinecone. It is intended for maintainers and
coding agents. It does not start Baileys or WhatsApp.

Automated regression tests remain under `src/tests`. Use this suite for behavior
that only becomes meaningful when the complete application and its integrations
run together.

## Before A Run

1. Use isolated staging resources in `.env.staging`.
2. Apply current Supabase migrations and seed staging identities.
3. Make sure the staging Sheet contains a known rota week and attendance date.
4. Run `npm run staging` and open `http://127.0.0.1:3100`.
5. Keep **Agent activity** and **Operations** visible while testing.

Choose these values from current staging data before starting:

- `<known-week>`: a Monday-to-Sunday week with rota data.
- `<attendance-date>`: a date with known attendance data.
- `<leader>`: the verified member assigned to worship/praise for that week.
- `<ordinary-member>`, `<superuser>` and `<creator>`: seeded staging identities.

## How To Judge A Test

A test passes when:

- Echo gives a correct, readable result grounded in current data.
- Agent activity truthfully shows the capabilities and tools that ran.
- Only relevant tools run; exact tool order matters only where stated.
- Supabase and **Operations** reflect any promised persistent action.
- Permissions, ownership and reply chains are enforced by the backend.
- A failed integration produces a useful response and does not crash the turn.

Do not fail a normal agent test only because the planner chose a different valid
route. Judge the observable result and state change.

## Conversation And Retrieval

### L01 - Casual Conversation

- **Send:** `Hello Echo. How are you?`
- **Expect:** A concise conversational reply with no choir-data retrieval or
  workflow mutation.

### L02 - Catalogued Weekly Schedule

- Set application time inside `<known-week>`.
- **Send:** `What is the schedule for this week?`
- **Expect:** A date-scoped answer from the rota source. It must not mix in
  unrelated weeks or use generic spreadsheet inspection for the catalogued tab.

### L03 - Attendance Through The Normal Agent

- Set application time to the day after `<attendance-date>`.
- **Send:** `Who was unavailable yesterday?`
- **Expect:** Echo retrieves the catalogued attendance source, preserves the
  requested date and reports only supported names or clearly states that the
  source has no matching record.

### L04 - Multi-Part Retrieval

- **Send:** `For <known-week>, who leads worship and who is unavailable for rehearsal?`
- **Expect:** Echo plans enough retrieval to answer both parts, then returns one
  coherent response without repeating intermediate tool output.

### L05 - Quote And Follow-Up Context

- Send a normal member message containing a rehearsal detail.
- Reply to that message with: `Echo, what does this mean for the choir?`
- Follow with: `What about Sunday?`
- **Expect:** The quoted text is available to the first answer and recent
  conversation supplies context for the follow-up.

### L06 - Member Memory

- As `<ordinary-member>`, send: `Please remember that I prefer rehearsal reminders in the morning.`
- Start a later turn and ask: `What reminder preference do you remember for me?`
- **Expect:** The fact is stored against that member and recalled without leaking
  another member's memory. Member memory remains bounded rather than expiring on
  a schedule.

## Identity And Permissions

### L07 - Unknown Member Onboarding

- Add a simulated participant and send: `Hello Echo.`
- Refresh **Speaking as**.
- **Expect:** The participant becomes an ordinary member with profile memory and
  no creator or superuser role.

### L08 - Privileged Commands

- As `<ordinary-member>`, try `schedules`, `sync` and `scheduler deactivate`.
- Repeat the applicable commands as `<superuser>` or `<creator>`.
- **Expect:** Unauthorized requests do not execute. Authorized `schedules` is
  readable and ordered; creator scheduler commands update **Operations**.
- Finish with `scheduler activate`.

## Reminder Workflows

### L09 - Create, Edit And Confirm

- As `<ordinary-member>`, send: `Echo, remind me tomorrow at 10am about rehearsal.`
- Reply directly to Echo's confirmation with: `EDIT time to 11am`.
- Reply directly to the new confirmation with: `YES`.
- **Expect:** Nothing is scheduled before `YES`. One reminder is then persisted
  at 11:00 AM and appears in **Operations**.

### L10 - Ownership, Concurrency And Cancellation

- Start two different reminder workflows as the same member.
- Confirm each by replying to its own Echo confirmation.
- Attempt one confirmation from another member.
- Create another reminder, reply `cancel reminder`, then reply `YES` to the
  cancellation confirmation.
- **Expect:** Reply message IDs resolve the correct workflow, foreign ownership
  is rejected, and the cancelled reminder disappears from active schedules.

### L11 - Reminder Validation

- Try `Echo, remind me about rehearsal` and a reminder time in the past.
- **Expect:** Echo explicitly says the reminder was not set and gives the
  deterministic reason. It must not imply that an unfinished workflow exists.

## Setlists And Scheduled Choir Operations

These tests mutate staging setlists and obligations. Use a disposable
`<known-week>` or reset the staging timeline afterward.

### L12 - Setlist Submission And Correction

- As `<leader>`, send a small setlist with `#submit_setlist`.
- Send a corrected version with the same tag.
- **Expect:** The first submission is saved immediately without `YES`; the second
  replaces the matching week and section rather than creating a duplicate.
- Optionally submit worship and praise separately and confirm that Echo stores
  both sections but treats the completed week as one setlist for broadcast.

### L13 - Sunday And Wednesday Rota Activations

- Travel to Sunday 4:59 PM before `<known-week>` and advance past 5:00 PM.
- Travel on a fresh timeline to Wednesday 8:59 AM in `<known-week>` and advance
  past 9:00 AM.
- **Expect:** Each due activation checks current evidence. It sends a readable,
  mention-ready message only when relevant dated data exists; otherwise it
  records a truthful no-send result.

### L14 - Nudge Planning And Delivery

- Use a week with a resolvable `<leader>` and no submitted setlist.
- Travel to the preceding Sunday 6:59 PM and advance past 7:00 PM.
- **Expect:** **Operations** shows the remaining Monday-to-Friday one-time nudge
  obligations in chronological order.
- Advance past one nudge. Expect one tagged request when the leader resolves.
- Submit the setlist. Expect all remaining nudges for that week to be cancelled.

### L15 - Setlist Broadcast

- After L12, inspect **Operations** and advance past the Thursday-or-Friday
  broadcast time.
- **Expect:** Echo sends the latest actual setlist once. A correction made before
  delivery must replace the content used by the broadcast.

### L16 - Last-Friday Week

- Choose a week containing the month's last Friday and reset to its preceding
  Sunday before 7:00 PM.
- **Expect:** No setlist nudges are planned for that week. The verified leader can
  still submit early from the previous week, and Echo keeps the submission
  associated with the correct service week.

### L17 - Recurring Agent Task

- As `<superuser>`, send an explicit task such as:
  `Echo, remind the group every Monday at 10am with the members marked unavailable in the attendance sheet.`
- **Expect:** Echo executes the objective immediately, persists one recurring
  task, and shows its next run under `schedules`. The saved procedure must not
  contain copied sheet results.
- Advance past the next run and confirm it uses fresh data, then ask Echo to
  cancel the recurring task.

## Recovery And Failure Handling

### L18 - Restart Recovery

- Leave one future user reminder, one recurring task and one future obligation
  active. Stop and restart browser staging without changing the clock.
- **Expect:** Future jobs are rebuilt once and remain visible. Expired one-time
  choir jobs are not delivered as startup catch-up messages; a due recurring
  task follows its normal policy of running once before scheduling its next
  future occurrence.

### L19 - Reverse Time Travel

- Produce messages and scheduled state, then set application time earlier.
- **Expect:** Staging starts a fresh timeline automatically, clears timeline-bound
  conversations, workflows, obligations, setlists and traces, and rebuilds the
  schedules appropriate to the new time. Identities and member memory remain.

### L20 - Non-Fatal Integration Failure

- Temporarily use an invalid staging source identifier or a controlled adapter
  failure, then ask a retrieval question.
- **Expect:** The tool failure is visible in Agent activity, the turn terminates
  cleanly, and the process remains available for the next message. Restore the
  staging configuration immediately afterward.

## Constrained Generic Spreadsheet Test

Use this test only to evaluate whether the agent can discover and query an
uncatalogued spreadsheet shape. It deliberately removes the normal catalogued
attendance route without changing production prompts or tools.

1. Open **Agent evaluation** and enable controlled mode.
2. Allow only `get_current_time`, `inspect_spreadsheet` and `query_spreadsheet`.
3. Disable recent conversation and keep the normal maximum step limit.
4. Set application time to the day after `<attendance-date>`.
5. Send: `From the attendance sheet, who was unavailable yesterday?`
6. Set the expected tools to:
   `get_current_time, inspect_spreadsheet, query_spreadsheet`.
7. Set expected answer text to a non-private value known from the selected
   staging row.

The test passes when the agent discovers the tab and columns, issues a bounded
date-aware query, and answers from the returned row. A preview sample alone is
not sufficient evidence.

## Record A Run

Keep the record brief. Add one row per full run; put detailed investigation in
an issue or commit message.

| Date | Environment | Result | Failed IDs | Notes |
| --- | --- | --- | --- | --- |
| YYYY-MM-DD | local staging | Pass/Fail | None or L03, L14 | Short reason or fix reference |
| 2026-09-01 | local staging | Pass | None | Full regression and live integration run. Fixed spreadsheet recovery, history-source selection, reminder prefix punctuation and idempotent mention labels. L16 nudge suppression passed; early submission could not be exercised because the live rota had no leader for that week. |

## Cleanup

After testing:

1. Cancel test reminders and recurring tasks.
2. Return to **Live time** or reset the staging timeline.
3. Run `scheduler activate` if it was disabled.
4. Confirm **Operations** contains no unintended test jobs.
5. Stop the staging server.
