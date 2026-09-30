// Google Sheets client for the service account (no interactive login, so it
// works headless from the cloud Routine and from a desktop shortcut).
// Credential order:
//   1. $GOOGLE_SERVICE_ACCOUNT_JSON — raw JSON key content (cloud Routine)
//   2. $GOOGLE_APPLICATION_CREDENTIALS — path to a key file (Google's standard
//      env var, picked up by googleapis itself)
//   3. `keyFile`, if it exists — e.g. config/google-service-account.json, so
//      local runs work without exporting anything
// The service account's email must be shared on the target Sheet as Editor.

import fs from 'node:fs';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export async function buildSheetsClient({ keyFile = null } = {}) {
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  } else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && keyFile && fs.existsSync(keyFile)) {
    auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  } else {
    auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  }
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}
