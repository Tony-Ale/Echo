import type { Document } from "@langchain/core/documents";
import { DateTime } from "luxon";
import { ATTENDANCE, DOCUMENTS_AND_RESOURCES, EVENTS_2026, isMonthlyRotaSheet, MEMBERS, MONTHLY_ROTA, ORIGINALS_2026_ROTA, SM_LIBRARY } from "../../../integrations/googleSheets/utils.js";
import { clockService } from "../../../shared/clockService.js";

export function formatDocumentsForLLM(docs: Document[]): string {
    return docs
        .map(
            (doc) =>
                `${doc.pageContent}\n`
        )
        .join("\n---\n");
}


// Helper to format a JS-date-compatible value as DD/MM/YYYY and get the day name.
export const formatDate = (date: unknown) => {
    if (!date) throw new Error("Invalid date");
    const dateTime = DateTime.isDateTime(date)
        ? date
        : DateTime.fromJSDate(date as never, { zone: "Europe/London" });

    if (!dateTime.isValid) throw new Error("Invalid date");

    return {
        formatted: dateTime.toFormat("dd/LL/yyyy"),
        day: dateTime.toFormat("cccc"),
    };
};

/**
 * 
 * @param dateString of format DD/MM/YYYY
 * @returns string
 * for example 12/02/2026 will return feb 26
 */
export function mapDateStringToMonthlyRota(dateString: string): string {
    const [, month, year] = dateString.split("/");

    const monthIndex = parseInt(month, 10) - 1;
    const shortYear = year.slice(-2);

    const monthNames = [
        "jan", "feb", "mar", "apr", "may", "jun",
        "jul", "aug", "sept", "oct", "nov", "dec"
    ];

    if (monthIndex < 0 || monthIndex > 11) {
        throw new Error("Invalid month in date string");
    }

    return `${monthNames[monthIndex]} ${shortYear}`;
}

/**
 * Gets the date for the monday of the current week
 * @param baseDate 
 * @returns 
 */
export function getMondayOfWeek(baseDate: DateTime = clockService.now("Europe/London")): string {
    const date = baseDate.setZone("Europe/London").startOf("day");
    const monday = date.weekday === 7 ? date.plus({ days: 1 }) : date.startOf("week");
    return monday.toISODate()!;
}




export function buildSheetDescriptionsJSON(
    sheetNames: string[],
    sheetDescriptionMap: Map<string, string> = SHEET_DESCRIPTIONS
) {
    return sheetNames
        .filter(name => sheetDescriptionMap.has(name) || isMonthlyRotaSheet(name))
        .map(name => {
            let descName;
            if (isMonthlyRotaSheet(name)) {
                descName = MONTHLY_ROTA
            }
            return {
                sheetName: name,
                description: sheetDescriptionMap.get(descName ?? name)
            }
        });
}


export const SHEET_DESCRIPTIONS: Map<string, string> = new Map([
    [
        MONTHLY_ROTA,
        `Contains the weekly task allocation for choir members within a month.
Columns:
1. Date : The week/date of assignment.
2. Role : The responsibility (e.g., Hymn, Worship & Praise, Special Ministration, Pure Praise, Offering Thanksgiving, Uniform, Bible Study, etc.).
3. Lead : The member leading that role.
4. Supporting Link/Info : Relevant details such as song title, uniform details, or additional notes.`
    ],

    [
        ATTENDANCE,
        `Spans the entire year and tracks member availability.
Rows represent dates across the year.
Columns represent choir members.
Uses availability keys:
A: Available
NA : Not Available
U : Unsure.`
    ],

    [
        SM_LIBRARY,
        `Contains a categorized list of Special Ministrations and Hymns.
Songs are grouped by themes for easy reference and planning.`
    ],

    [
        MEMBERS,
        `Contains the full list of choir members.
Includes their names and assigned vocal parts/roles within the choir.`
    ],

    [
        EVENTS_2026,
        `Contains key choir events and programs for the year.
Columns:
1. Date : The date of the event.
2. Event : The name or description of the program.`
    ],

    [
        DOCUMENTS_AND_RESOURCES,
        `Contains important choir-related resource links.
Columns:
1. Document Name
2. Link
Includes links to:
- Choir policy
- Choir vision
- Audition form
- Originals/composed song library
- Meeting summaries.`
    ],

    [
        ORIGINALS_2026_ROTA,
        `Tracks original song composition assignments for the year.
Columns:
1. Month : The month of composition.
2. Composer : The assigned choir member.
3. Song : The composed original song for that month.`
    ]
]);

