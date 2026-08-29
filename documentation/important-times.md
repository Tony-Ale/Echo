# Important Times

This file lists the main scheduled times used by Echo and what each one does. Times use the application timezone, `Europe/London`.

## Weekly Jobs

- **Sunday at 5:00 PM**
  - Activates a durable Sunday rota obligation for the upcoming Monday-to-Sunday service week.
  - Echo checks fresh weekly evidence before deciding whether a reminder applies.
  - Approved reminder text and member mentions are produced through agent tools.

- **Wednesday at 9:00 AM**
  - Activates a durable Wednesday rota obligation for the current week.
  - Echo checks the current schedule before deciding whether to send anything.

- **Sunday at 7:00 PM**
  - Activates the agent to evaluate and plan the next service week's setlist obligations.
  - If the target week contains the month's last Friday, no nudges are scheduled.
  - If the setlist has already been submitted, no nudges are scheduled.
  - Otherwise, Echo persists all remaining Monday-to-Friday one-time nudge obligations for that week.
  - After a restart later in the week, Echo backfills this planning only when future weekday nudge slots remain.

- **Sunday at 6:00 PM**
  - Runs setlist cleanup.
  - Deletes expired submitted setlists from Supabase.
  - Removes expired week-scoped operational memory blocks. Member memories do not expire here.

## Setlist Nudge Times

- **Monday to Friday, random time between 9:00 AM and 4:00 PM**
  - Sends a setlist nudge only if the setlist is still missing.
  - Nudges are persistent one-time obligations, not permanent recurring weekday jobs.
  - Remaining obligations for the week are satisfied and cancelled once the setlist is submitted.

## Setlist Broadcast Times

- **Thursday or Friday, random time between 9:00 AM and 4:00 PM**
  - After a setlist is submitted, Echo schedules one broadcast reminder containing the submitted setlist.
  - If the setlist is later corrected, the broadcast job is refreshed for the updated content.

## User Reminder Times

- **User-selected date and time**
  - User reminders are scheduled after the user confirms the reminder.
  - If the user gives no time, Echo defaults reminder time to **9:00 AM**.
  - Reminder dates are resolved in UK time.

## Recurring Agent Task Times

- **Superuser-selected daily, weekly, or monthly time**
  - Echo executes the objective immediately when the task is created.
  - Each later occurrence is calculated deterministically in UK time.
  - Missed periods do not create a catch-up flood; Echo runs the due objective once and schedules the next future occurrence.

## Expiration Times

- **Normal submitted setlists**
  - Expire one week after submission.

- **Setlists for a week containing the month's last Friday**
  - Expire at the end of that service Sunday, including when submitted early during the previous week.
