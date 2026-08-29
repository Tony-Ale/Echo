import * as chrono from "chrono-node";
import { formatDate } from "./helpers.js";
import { clockService } from "../../../shared/clockService.js";

/**
 * Parses temporal expressions in a user query using Chrono,
 * and appends the results as structured "Temporal Context".
 *
 * @param query - The user's raw query
 * @returns The query with temporal context appended
 */
export function addTemporalContext(query: string){
    // Set reference date in UK timezone
    const ukNow = clockService.now("Europe/London").toJSDate();

    // Parse query with Chrono using the UK reference date and making it to parse uk date time format if it is in the query
    const results = chrono.en.GB.parse(query, ukNow);

    // If no temporal info found, return original query
    if (results.length === 0) return {query, temporalData: [], augmentedQuery: query};

    // Map results to structured format
    const temporalData = results.map(r => {
        const res = formatDate(r.start.date())
        const end = r.end ? formatDate(r.end.date()).formatted : undefined
        const date = res.formatted;
        const day = res.day;
        return {
            text: r.text, // the text in the query that was recognized as temporal
            date_equivalent: date,
            end_date_equivalent: end,
            day_equivalent: day,
            //start: r.start ? r.start.date().toISOString().split("T")[0] : null,
            //end: r.end ? r.end.date().toISOString().split("T")[0] : null, // for ranges
        }
    });

    // Append temporal context as JSON to the query
    const augmentedQuery = `${query}\n\n[Temporal Context: ${JSON.stringify(temporalData)}]`;

    return {query, temporalData, augmentedQuery}
}


