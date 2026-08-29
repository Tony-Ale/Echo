import { google, sheets_v4 } from "googleapis";
import { env } from "../../config/env.js";

/**
 * Builds authenticated Google Sheets API client using service account credentials.
 *
 * @returns Google Sheets API client.
 */
export function createGoogleSheetsClient(): sheets_v4.Sheets {
    const auth = new google.auth.GoogleAuth({
      keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

  return google.sheets({ version: "v4", auth });
}
