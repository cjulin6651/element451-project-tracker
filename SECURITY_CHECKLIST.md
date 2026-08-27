# Security and Public-Repo Checklist

## Never commit

- Element451 API/bearer key;
- Feature token;
- Analytics token;
- Google service-account private key or JSON;
- OAuth access/refresh tokens;
- webhook secrets;
- production student/person exports;
- email/chat exports containing protected data;
- unredacted screenshots with sensitive records.

## Safe storage used by this project

- Element451 credentials: restricted Google credential Sheet referenced by ID in `ElementConfig.gs`.
- Google Chat service account: Apps Script Script Properties using `CHAT_SERVICE_ACCOUNT_JSON`, or `CHAT_SERVICE_ACCOUNT_EMAIL` + `CHAT_SERVICE_ACCOUNT_PRIVATE_KEY`.
- Canonical dashboard URL: Script Property `PROJECT_TRACKER_WEB_APP_URL`.
- Generated Project Tracker data sheet ID: Script Property `SPREADSHEET_ID`.

## Before pushing to GitHub

Search the complete repository—including nested ZIPs/releases—for:

- your institution name and domain;
- real employee/student email addresses;
- your Element451 client hostname;
- `E451.` tokens;
- `AIza` keys;
- `AKfy` deployment IDs;
- `apps.googleusercontent.com` OAuth client IDs;
- Shared Drive/folder/file IDs;
- `PRIVATE KEY`;
- `client_email` from service-account JSON;
- copied API responses or logs.

Do not assume an ID is harmless merely because it is not a password. Remove infrastructure identifiers from a reusable public template unless the repo intentionally documents that environment.

## If a secret was ever committed

Deleting it from the current file is not enough. Rotate/revoke the secret and clean Git history as appropriate.

## Viewer security

Viewer restrictions are server-side. Do not replace authorization checks with UI hiding. Always test that changing `ticket=` or removing/altering `share=` cannot reveal another ticket.

## Credential-sheet access

The Element451 credential Sheet should be accessible only to accounts/runtime identities that genuinely need it. Do not share it broadly just because the main Project Tracker data Sheet is collaborative.
