export type MonthlyRotaWeeklyDocument = {
    WEEK_START: string; // ISO format (YYYY-MM-DD)
    CONTENT: string; // Structured weekly content for embedding
};

export type FlattenedSheet = {
    CONTENT: string;
}