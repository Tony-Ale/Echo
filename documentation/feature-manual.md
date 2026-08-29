# Echo Feature Manual

Echo is the WhatsApp assistant for the OHA choir group. Tag Echo in the group, or reply to one of Echo's messages, when you want it to respond.

## How To Reach Echo

- Tag Echo in a group message.
- Reply directly to an Echo message.
- Quote another message when you want Echo to use that message as context.
- Use `@Echo help` to see a short help summary in WhatsApp.

## Questions Echo Can Answer

- Choir rota questions.
- Worship, praise, and service assignment questions.
- Song library and song theme questions.
- Event and resource questions.
- Questions that depend on a quoted WhatsApp message.
- Multi-part questions handled through Echo's bounded tool-planning loop.
- Casual choir-related conversation.

## Members And Memory

- A participant who messages Echo in an accepted choir group can be added automatically as an ordinary member. Normally this is only `WHATSAPP_GROUP_ID`; an administrator can deliberately broaden access to all joined groups.
- The private seed is only a bootstrap list; it does not need to contain the entire choir.
- Echo can learn a member's WhatsApp display name, aliases and durable conversational preferences.
- Display names and aliases do not control permissions. Verified WhatsApp identifiers remain authoritative.
- Canonical schedule-name reconciliation and sensitive identity changes remain creator-controlled.

## Reminders

- Create a reminder with clear reminder wording:
  - `@Echo remind me next Thursday about choir rehearsal`
- Create a reminder from a quoted message:
  - Reply to the message with `@Echo remind me tomorrow`
- Echo will show the reminder details before saving.
- Reply `YES` to confirm.
- Reply `EDIT ...` to change the date, time, or reminder details.
- Reply with `cancel reminder` to start cancellation.
- Only the person who created the reminder can confirm, edit, or cancel it.
- Reminders are saved in Supabase and restored after restart.

## Recurring Agent Tasks

- Superusers can use the same `remind` command to schedule a recurring objective:
  - `@Echo remind the group every Monday at 10am with the current operations update`
- Recurrence must clearly state a daily, weekly, or monthly schedule and a time.
- Echo saves the objective, sends its first real result immediately, and runs it again on schedule without a preview or `YES` confirmation.
- Future runs return to the group where the task was created and retrieve fresh information when the objective requires it.
- A saved procedure contains successful non-mutating tool calls, not previous sheet rows or message results. Echo can revise it when current data changes.
- Privileged scheduled objectives may inspect and query a specifically named spreadsheet tab with bounded columns and deterministic filters.
- Task owners can ask Echo to list, pause, resume, update, or cancel their recurring tasks.
- Active tasks are restored from Supabase after restart and appear under `schedules`.

## Setlist Submission

- Assigned leaders submit combined, worship-only or praise-only setlists with `#submit_setlist`.
- The setlist can be in the same message as the hashtag.
- The setlist can also be quoted, then submitted with the hashtag.
- Echo validates the sender, then stores the setlist immediately.
- Echo's planner identifies whether the content is combined, worship-only or praise-only; backend validation decides who may submit it and for which week.
- The same `#submit_setlist` tag replaces the matching combined, worship-only or praise-only submission after sender validation. A combined correction replaces unfinished separate sections for that week.
- Separate worship and praise submissions are combined into one weekly broadcast.
- Echo validates the submitter against the assigned leader's verified database identity.
- If next week contains the month's last Friday, that week's leader can submit early from the week before.
- A creator can submit or correct a setlist for the current week.
- A plain hashtag only works if Echo receives the message, usually by tagging Echo or replying to Echo.

## Setlist Nudges

- Each nudge is one combined worship/praise request rather than separate worship and praise messages.
- Nudges use the structured weekly schedule interpretation to identify the worship/praise leader.
- Nudges are planned weekly on Sundays at 7 PM. Echo creates all remaining Monday-to-Friday nudge obligations for the target week at once, each with its own random delivery time.
- Weekly interpretations are source-hash matched, so changed schedule data is reevaluated before later scheduled actions.
- If Echo cannot resolve and tag the leader, it skips that nudge and tries again on the next scheduled nudge.
- Once the weekly setlist is complete, remaining setlist nudges for that week are cancelled.
- Echo resolves the interpreted leader through the canonical member database before preparing a mention.
- After the weekly setlist is complete, Echo schedules one Thursday-or-Friday broadcast when that week's delivery window is still in the future.
- If Echo starts after the Sunday planning time, it restores missing planning for the current week when usable weekday nudge slots remain.

## Weekly Rota Reminders

- Echo evaluates the Sunday rota obligation for the upcoming Monday-to-Sunday service week and sends only when current evidence supports it.
- Echo evaluates the Wednesday rota obligation for the current week and sends only when current evidence contains a dated Wednesday assignment.
- The central agent composes reminder wording from current weekly evidence and converts resolved members to WhatsApp mentions where possible.

## Last-Friday Week Handling

- Echo uses weekly planned weekday setlist nudges.
- If a week contains the last Friday of the month, Echo skips setlist nudges for that week.
- Echo can still accept that week's setlist early from the assigned leader.
- This avoids nudging during vigil week while keeping the reminder system simple.

## Confirmation Rules

- Echo does not immediately perform reminder actions.
- Reminder creation requires confirmation.
- Reminder edits require confirmation.
- Reminder cancellation requires confirmation.
- Recurring agent tasks do not require confirmation; only privileged members can create or manage them.
- Setlist submission does not require a separate `YES` confirmation after sender validation.
- Reminder workflow replies are tied to Echo's confirmation message, so multiple users can run workflows safely.

## Admin Commands

- `sync`
  - Superuser-only.
  - Synchronizes source data into the retrieval system.
- `schedules`
  - Superuser-only.
  - Shows currently registered scheduled jobs.

## Creator Commands

- These are creator-only.
- `clock now`
  - Shows whether Echo is using system time or mock time.
- `clock set 2026-08-01 14:30`
  - Enables mock time and sets Echo's application clock.
- `clock advance 7 days`
  - Moves mock time forward.
- `clock advance 5 hours 30 minutes`
  - Moves mock time forward by a combined duration.
- `clock clear`
  - Disables mock time and returns Echo to system time.
- `scheduler deactivate`
  - Stops and clears all currently registered scheduled messages for the running process.
- `scheduler activate`
  - Restores Echo's normal scheduled messages for the current week.
- `send sunday reminder`
  - From a creator's private chat with Echo, immediately runs the normal Sunday reminder workflow for the upcoming service week and sends the result to `WHATSAPP_GROUP_ID` when current evidence requires one.

## What Echo Does Not Do

- Echo does not let another user hijack your reminder workflow.
- Echo does not treat old or past reminder dates as valid.
- Echo accepts setlists only from the assigned leader or a creator.
- Echo does not rely on WhatsApp display names for setlist leader validation.
- Echo does not onboard people from private conversations. With the default group policy it also rejects unrelated groups; enabling all-groups mode intentionally broadens this boundary.
