# Manual Setup Guide

> **Prerequisite:** Element451 is a required platform dependency for this repository. This guide assumes your institution has an active Element451 tenant and access to the required API credentials.

Use this when you do not want the AI-guided workflow in `SETUP_WITH_AI.md`.

## 1. Make a working fork

Create a private fork/working copy first. Do not enter production secrets into Git-tracked files.

## 2. Prepare Google Drive

Create or choose:

- a Shared Drive for the Project Tracker data spreadsheet;
- an active-ticket files folder;
- an archive folder.

Copy the IDs and enter them in `apps-script/Config.gs`.

## 3. Configure institution basics

In `apps-script/Config.gs` change:

- `INSTITUTION_NAME`;
- `ALLOWED_VIEWER_DOMAINS`;
- `DRIVE_ID`;
- `TICKETS_FOLDER_ID`;
- `ARCHIVE_FOLDER_ID`;
- `SPREADSHEET_NAME`, ticket prefix/padding if desired;
- neutral default Types/Departments/Sizes may be kept initially and edited in the live spreadsheet after setup;
- workload-study options if used.

`setup()` will refuse to run while required technical placeholders remain. Real staff accounts are intentionally not stored in `Config.gs`.

## 4. Configure Element451

Create a restricted Google Sheet for credentials. With the default layout:

- B1: API/bearer key;
- B3: Feature token;
- B4: Analytics token when used.

Do not commit those values.

In `apps-script/ElementConfig.gs` set:

- credential spreadsheet ID;
- sheet name/range if different;
- `CLIENT` from your Element URL;
- `RESOURCE_ID_PREFIX` (usually the same as `CLIENT`).

In `apps-script/appsscript.json`, replace the template host `https://example.api.451.io/` with `https://YOUR_CLIENT.api.451.io/` in the URL fetch whitelist.

Identify whether your institution uses any person/student identifiers beyond Element451's native Element/person ID. Use your institution's own names (for example Banner ID, SIS ID, Student Number, or another local identifier).

`CONFIG.ADDITIONAL_STUDENT_ID_TYPES` contains two optional external-ID implementation slots. They are disabled by default. For each identifier you actually use, configure an enabled slot with:

- `label` — the user-facing name your institution uses;
- `mappingSlug` — the verified Element451 identity/mapping slug, when known;
- `tokenPattern` — optional unanchored JavaScript regex source used only when unlabeled Gmail/Chat text should be recognized automatically.

If you use no additional identifiers, leave both slots disabled. If you need more than two external identifier types, treat that as a code-level customization and extend the resolver consistently across Element451 lookup, Related Students, the web UI, and Gmail/Chat enrichment. Automatic recognition should remain disabled unless an identifier has an explicitly verified, reliably distinguishable format. Never derive a pattern from real student IDs in documentation or AI prompts.

## 5. Configure Apps Script manifest

In `apps-script/appsscript.json`:

- set `timeZone`;
- set the Element451 whitelist URL;
- replace the example add-on logo URL with a public HTTPS image URL;
- review OAuth scopes and advanced services for the components you are actually deploying.

## 6. Create Apps Script project

Create a Google Apps Script project and add every file from `apps-script/` using matching file names/types. Link the Apps Script project to the intended Standard Google Cloud project.

Enable the advanced services declared by the manifest and enable their corresponding APIs in the Cloud project. The included build uses Drive, Gmail, and Google Chat advanced services; Google Chat/People APIs are only operationally needed when Chat is enabled.

## 7. Validate and initialize data

Run:

```text
validateTemplateConfiguration_()
```

Then run once:

```text
setup()
```

Open the generated Project Tracker spreadsheet and enter user access directly in the `Agents` tab using the columns `email`, `display_name`, `role`, and `active`. Use `agent` for assignable editors, `editor` for non-assignable editors, and `viewer` only for signed-link read access. Do not put these real users into source code.

You can also edit the live `Types`, `Departments`, and `Sizes` tabs directly if the neutral defaults do not fit your institution.

Then:

```text
verifySetup()
```

`setup()` creates the data spreadsheet/tabs and stores the generated spreadsheet ID as Script Property `SPREADSHEET_ID`.

## 8. Validate Element451

Run:

```text
testElement451Connection()
```

If additional identity matching needs verification in your tenant, run:

```text
diagnoseElement451IdentityMappings()
```

Use redacted logs when troubleshooting. Do not paste credentials or student production payloads into GitHub issues or public AI chats.

## 9. Deploy the dashboard

Deploy the Apps Script project as a web app using an access/execution model appropriate for your Workspace. Validate with real test accounts that:

- `Session.getActiveUser().getEmail()` resolves the expected user;
- agents/editors can reach the shared data and ticket folders;
- unauthorized accounts are rejected;
- viewers are restricted to valid signed ticket URLs.

After choosing the canonical production deployment, set Script Property:

```text
PROJECT_TRACKER_WEB_APP_URL = https://script.google.com/.../exec
```

## 10. Gmail add-on (optional)

If using Gmail, configure/deploy the Workspace add-on using the manifest in `appsscript.json`, authorize the required scopes, and test Create/Add-to-Existing flows with at least two users.

Watched Gmail threads are processed under the mailbox user that enabled the watch. Test the watcher trigger and permissions for each role/user model you intend to support.

## 11. Google Chat (optional)

Follow `docs/GOOGLE_CHAT_SETUP.md`. Keep service-account credentials in Script Properties, not source control. Run `verifyGoogleChatIntegration()` after configuration.

## 12. Chrome extension (optional)

In `chrome-extension/manifest.json`, replace the OAuth client placeholder with the OAuth client ID created for your extension.

Create an Apps Script **API executable** deployment for the extension backend. In the extension Options page enter:

- canonical Project Tracker web-app `/exec` URL;
- API executable deployment ID.

Test the extension with unpacked/internal distribution before broader publication.

## 13. Final role/security tests

Test at minimum:

1. agent create/edit/assignment;
2. editor editing + High Priority, while remaining absent from owner assignment lists;
3. viewer can open a valid signed link but cannot browse the dashboard or another ticket;
4. invalid/altered viewer token fails;
5. local Element URLs resolve; other tenants' URLs do not auto-link;
6. no secrets appear in source, logs, screenshots, or Git history.
