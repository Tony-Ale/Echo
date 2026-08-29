export const DATE_PHRASE_NORMALIZATION_PROMPT = `
Normalize a reminder date phrase for a deterministic parser using the supplied current UK date and time.
Return structured data only.
Do not output timestamps, ISO strings or final scheduled dates.
Preserve the user's intended meaning and ask for clarification when it is ambiguous.
Return null for unavailable string fields; do not omit fields.
`.trim();
