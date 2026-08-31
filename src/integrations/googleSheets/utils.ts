// Map of sheet name to the index of the header row for that sheet
const MONTH_YEAR_PATTERN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s\d{2}$/i;

export function isMonthlyRotaSheet(sheetName: string): boolean {
  return MONTH_YEAR_PATTERN.test(sheetName.trim());
}

export function getHeaderRowIndexForMonthlyRotaSheet(sheetName: string): number | undefined {
  if (isMonthlyRotaSheet(sheetName)) {
    return 2;
  }
  return undefined;
}

// Sheet name constants
export const ORIGINALS_2026_ROTA = "2026 originals rota";
export const DOCUMENTS_AND_RESOURCES = "documents and resources";
export const EVENTS_2026 = "2026 events";
export const MEMBERS = "members";
export const SM_LIBRARY = "sm library";
export const ATTENDANCE = "2026 attendance";
export const MONTHLY_ROTA = "monthly rota"

export const smallSheets = [EVENTS_2026, MEMBERS, DOCUMENTS_AND_RESOURCES, ORIGINALS_2026_ROTA]

// Map of sheet name constants to header row index
export const sheetNameHeaderIndexMap = {
    [ORIGINALS_2026_ROTA]: 1,
    [DOCUMENTS_AND_RESOURCES]: 2,
    [EVENTS_2026]: 1,
    [MEMBERS]: 0,
    [SM_LIBRARY]: 0,
    [ATTENDANCE]: 10
} as const;


export const SHEET_REGISTRY = {
  [MONTHLY_ROTA]: {
    headers: {
      DATE: "DATE",
      ROLE: "ROLE",
      LEAD: "LEAD",
      SUPPORTING_INFO: "SUPPORTING LINK/ INFO",
    },
  },

  [ORIGINALS_2026_ROTA]: {
    headers: {
      MONTH: "MONTH",
      COMPOSER: "COMPOSER",
      SONG: "SONG",
    },
  },

  [DOCUMENTS_AND_RESOURCES]: {
    headers: {
      NAME: "NAME",
      LINK: "LINK",
    },
  },

  [EVENTS_2026]: {
    headers: {
      DATE: "DATE",
      EVENT: "EVENT",
    },
  },

  [MEMBERS]: {
    headers: {
      SN: "SN",
      LIST_OF_MEMBERS: "LIST OF OHA MEMBERS",
      PARTS_OR_ROLES: "PARTS/ROLES",
    },
  },

  [SM_LIBRARY]: {
    headers: {
      THEME: "THEME",
      SPECIAL_MINISTRATIONS: "SPECIAL MINISTRATIONS",
      HYMNS: "HYMNS",
    },
  },

  [ATTENDANCE]:{
    headers: {
      Dates_Names: "Dates/Names",
    }
  }
} as const;
