# AI-Guided Setup Instructions

Use this file as the implementation prompt for adapting this repository to another **Element451 institution**.

## Your job

Help the user create a Project Tracker that stays as close as possible to the included implementation. This is **not** a greenfield design exercise and not a generic CRM integration project.

Default rule:

> Preserve the included behavior, workflow, UI, Gmail/Chat/Chrome functionality, and architecture unless an institution-specific value or an explicit user request requires a change.

The main things that normally change are tenant URLs/slugs, Google resource IDs created during setup, institution email domains, Element451 credential locations, optional local identifier mappings, and any local labels/branding the user explicitly requests.

## Critical source-preservation rule

**Do not rebuild this application from scratch.** This repository contains the complete working reference implementation. The source files in `apps-script/` and `chrome-extension/` are the implementation to deploy and adapt, not examples to imitate and not a specification for a new app.

Before writing or replacing code:

1. inspect the existing repository files relevant to the current phase;
2. identify the smallest institution-specific change required;
3. modify the existing file in place;
4. preserve unrelated functions, UI, workflows, integrations, comments, and behavior;
5. avoid wholesale rewrites when a configuration or targeted patch will accomplish the same result;
6. do not create a simplified replacement app, alternate architecture, new framework, or fresh implementation unless the user explicitly asks for a redesign.

If a file already implements the needed feature, **use that implementation**. Do not regenerate it from prose descriptions in the Markdown files. Treat the codebase as the primary source of truth and the Markdown files as setup/adaptation guidance.

When presenting code changes to the user, prefer complete updated versions of the existing affected files or a repository ZIP that preserves the rest of the codebase. Never silently omit existing features because they were not mentioned in the current setup phase.

## Assume a beginner

Assume the user may never have created an Apps Script project, linked a Google Cloud project, enabled an API, created OAuth credentials, configured a service account, or deployed a Workspace add-on.

Do not front-load all of those concepts. Guide the installation in **phases**, and only explain the technical concept needed for the current phase.

For each phase:

1. briefly explain what is being created or configured and why;
2. give click-by-click directions appropriate for a beginner;
3. tell the user exactly what non-secret value, ID, or result you need back, if any;
4. never ask for secrets or personal contact lists;
5. use the result to update the repository/configuration before moving on;
6. verify the phase succeeded before starting the next phase.

If the user cannot access a setting because it requires an administrator, do not assume they are an administrator and do not make admin access a prerequisite. Explain the smallest specific action that an administrator would need to perform at that point.

## Files to read first

Read the entire repository, especially:

- `INSTITUTION_CONFIG_QUESTIONNAIRE.md`
- `apps-script/Config.gs`
- `apps-script/ElementConfig.gs`
- `apps-script/appsscript.json`
- `apps-script/Setup.gs`
- `docs/GOOGLE_CHAT_SETUP.md`
- `CUSTOMIZATION_MAP.md`

Treat completed worksheet answers as already supplied. Do not make the user repeat them.

## Privacy and secret-handling rules

Never ask the user to paste into AI chat:

- staff names or staff email lists used to configure Project Tracker access;
- real student/person data;
- Element451 API/bearer keys;
- Element451 Feature tokens;
- Element451 Analytics tokens;
- Google service-account private keys or JSON key contents;
- OAuth client secrets;
- passwords, access tokens, or refresh tokens.

When Project Tracker access must be configured, instruct the user to enter the users **directly in the `Agents` tab of the Project Tracker spreadsheet**. Explain the columns and valid roles, but do not ask the user to report the names/emails back to you.

When secrets must be entered, tell the user exactly where to paste them locally and what non-secret confirmation you need afterward.

## Important assumptions from the worksheet

### Element451 is not optional

Do not ask whether the institution uses Element451. This repository is specifically for Element451 institutions.

The worksheet supplies the institution's Element451 base URL. Derive the normal tenant/client slug from the hostname. Verify tenant-specific API behavior during the appropriate phase rather than asking the user to research it in advance.

### Workspace domain does not require Admin Console access

The worksheet asks for the email domain after `@` in an institutional Google account. Use that value for `CONFIG.ALLOWED_VIEWER_DOMAINS`.

Do not tell the user they must visit Google Admin Console simply to discover their normal email domain.

### Keep the included application behavior

Do not interview the user about every workflow/status, Cloud resource, Drive folder, role, scope, or feature before beginning. Most of those are implementation steps or template defaults, not institutional design questions.

If the worksheet says `KEEP INCLUDED BEHAVIOR`, preserve the existing implementation unless a later setup constraint requires a change.

---

# Guided build phases

Run these phases in order. Do not dump all phases on the user at once.

## Phase 1 — Apply the institution-specific values already known

From the completed worksheet:

1. Set `CONFIG.INSTITUTION_NAME`.
2. Set `CONFIG.ALLOWED_VIEWER_DOMAINS` from the institutional email domain(s).
3. Set the Element451 client/tenant value from the supplied Element451 URL.
4. Update the Element451 hostname in `apps-script/appsscript.json` using the configured tenant.
5. Preserve the included workflow and feature set unless the worksheet explicitly says otherwise.
6. Record any additional institutional person/student identifier labels for later Element451 mapping work; do not invent mapping slugs or ID patterns.
7. Apply an explicitly requested product-name/branding change only if the user supplied one.

Show the user a short summary of what was changed. Do not ask for staff access information.

## Phase 2 — Create or identify the Google Drive storage

Guide the user through creating or selecting the Drive locations used by Project Tracker.

Prefer the same Shared Drive architecture used by the included implementation. Do not require Workspace-admin status merely to begin. If the user already has a Shared Drive they can use, guide them to use it. If they cannot create one, explain that someone with the appropriate Drive permission may need to create/provide it.

Help the user obtain:

- Shared Drive/root ID used by `CONFIG.DRIVE_ID`;
- active ticket/project files folder ID for `CONFIG.TICKETS_FOLDER_ID`;
- archive folder ID for `CONFIG.ARCHIVE_FOLDER_ID`.

Explain how to copy a folder ID from the Drive URL. These IDs are not passwords.

Update `apps-script/Config.gs` with the IDs the user provides.

## Phase 3 — Create the Apps Script project and add the source

Walk the user through creating a standalone Apps Script project (or using the project they intentionally chose), copying the files from `apps-script/`, and opening Project Settings.

Do not assume they know what Apps Script is. Explain where each file goes and how `appsscript.json` is exposed/edited when needed.

Configure the Apps Script time zone to match the institution's normal local time. If the worksheet did not provide a time zone, ask for the institution's city/state or time zone now; do not make the user know the IANA name.

Do not require a Standard Google Cloud project before explaining why it is needed. Introduce and link/configure it when the project reaches the Google API/OAuth phase.

## Phase 4 — Create the Element451 credential location

Project Tracker expects Element451 credentials in a restricted Google Sheet. Guide the user through creating that Sheet and restricting access appropriately.

Use the included credential layout unless the user has a reason to change it:

- B1 — Element451 API/bearer key
- B3 — Element451 Feature token
- B4 — Element451 Analytics token

Tell the user to paste those values **directly into the Sheet**. Never ask them to paste the values into chat.

Ask only for the non-secret Google Sheet ID after the Sheet is created. Put that ID into `apps-script/ElementConfig.gs`.

If the user does not know how to obtain the required Element451 credentials, guide them through the current Element451 process at this phase. Do not make them collect that information before the build starts.

## Phase 5 — Run initial setup and configure users privately

Once the required configuration placeholders are resolved, have the user run:

1. `validateTemplateConfiguration_()`
2. `setup()`
3. `verifySetup()`

`setup()` creates the Project Tracker data spreadsheet and tabs.

After it succeeds, instruct the user to open the generated spreadsheet and configure access **themselves** in the `Agents` tab.

Explain these columns:

- `email` — the user's institutional Google email address;
- `display_name` — the name Project Tracker should display;
- `role` — `agent`, `editor`, or `viewer`;
- `active` — `TRUE` for an active account.

Explain the roles:

- `agent` — can edit and can be assigned tickets/projects;
- `editor` — can edit but is not assignable; can manage High Priority;
- `viewer` — read-only and intended for signed ticket links rather than general dashboard use.

At least one person who will administer/test the app should be entered as an active `agent` before deploying/testing the dashboard.

**Do not ask the user to tell you who they entered.** Ask only for confirmation that the appropriate rows were added.

Also explain that the `Types`, `Departments`, and `Sizes` tabs are live configuration. The user can keep the included defaults or edit those tabs directly for their institution without sending internal organizational details to the AI.

## Phase 6 — Verify Element451 and configure any additional institutional IDs

Run the included Element451 connection/diagnostic functions appropriate to the repository.

Confirm that the configured tenant works before changing identity logic.

If the worksheet says the institution uses additional person/student identifier types:

1. take one identifier type at a time;
2. help determine the correct Element451 identity/mapping field using tenant-safe diagnostics/documentation;
3. never use a real student's identifier in chat;
4. use a fake example only if a recognition pattern is needed;
5. enable only the corresponding `CONFIG.ADDITIONAL_STUDENT_ID_TYPES` slot(s);
6. set user-facing labels to the institution's actual terminology;
7. do not invent a mapping slug or token pattern.

If the institution uses no extra identifier types, leave both optional slots disabled.

## Phase 7 — Link/configure Google Cloud and enable required APIs

Now guide the user through the Standard Google Cloud project and APIs required by the included Apps Script project.

Assume they have never used Google Cloud Console. Give exact current navigation when you reach each task.

Explain the difference between:

- the Apps Script project;
- the linked Google Cloud project;
- enabling Google APIs;
- OAuth consent/app configuration;
- OAuth client IDs used by components such as the Chrome extension.

Only request non-secret IDs when they are needed. Never request an OAuth client secret.

If a specific action requires Workspace administrator approval, identify that action at this point instead of treating administrator access as a general prerequisite.

## Phase 8 — Deploy and test the core web app

Guide the user through creating the Apps Script web-app deployment with the settings appropriate to this architecture.

Obtain the production `/exec` URL and configure `PROJECT_TRACKER_WEB_APP_URL` in Script Properties where required by the repository.

Test with the account the user privately added to the `Agents` sheet. If identity is not resolving correctly, troubleshoot deployment identity/settings before continuing.

Do not ask the user to send their email address to diagnose access; use role/result descriptions where possible.

## Phase 9 — Configure the Gmail add-on

Keep the Gmail implementation aligned with the included Project Tracker version.

Walk the user through the required Apps Script/Google Cloud/Marketplace configuration for the Gmail add-on, enabling the needed APIs/scopes and testing ticket creation/email capture.

Do this as a build phase, not as a questionnaire interview.

## Phase 10 — Configure Google Chat

Use `docs/GOOGLE_CHAT_SETUP.md` and the existing source implementation.

Guide the user through the required Google Chat app configuration and any service-account/Domain-Wide Delegation step that the included delayed-posting functionality needs.

If Workspace administrator approval is required for Domain-Wide Delegation, explain exactly what must be approved and provide the user with the specific information they need to send to their administrator. Do not assume the person building Project Tracker is the Workspace administrator.

Never ask for the service-account private key contents. Tell the user where to store the required values in Apps Script Script Properties.

## Phase 11 — Configure the Chrome extension

Guide the user through creating the extension OAuth client, configuring `chrome-extension/manifest.json`, creating/identifying the Apps Script API executable deployment, and entering the normal extension Options values.

Request the OAuth **client ID** only; never request a client secret.

Keep the extension behavior the same as the included version unless the user explicitly requests a change.

## Phase 12 — Full validation and cleanup

Run or guide the user through tests for the same capabilities included in the repository:

- agent access, editing, and assignment;
- editor access and High Priority behavior without assignment eligibility;
- viewer signed-link restrictions;
- ticket creation/editing/status/progress/notes;
- Related Students and Related Resources;
- Element451 person/resource resolution;
- any configured additional institutional ID type;
- Gmail ticket creation/capture/watch behavior;
- Google Chat intake/sharing/completion behavior;
- workload/capacity features;
- Chrome extension behavior;
- branding/icons where applicable.

Then scan the repository for:

- `YOUR_`
- `PASTE_`
- `example.edu`
- `example.com`
- former-institution names/domains/URLs
- accidentally committed secrets or private keys

Tell the user which remaining placeholders are intentional and which must be resolved.

Do not declare the installation complete until the relevant included features pass.

---

# Rules for adapting the code

1. Prefer configuration changes over business-logic rewrites.
2. Keep Element451 hostname/resource parsing configuration-driven.
3. Preserve the source Project Tracker workflow unless explicitly asked to change it.
4. Do not collect staff access lists in AI chat or source code; use the live `Agents` sheet.
5. Do not collect secrets in AI chat or Git.
6. Do not require Workspace administrator access unless a specific Google step actually requires it.
7. Do not ask the user to pre-create technical resources. Create/configure them in the phase where they are needed.
8. Keep a running record of non-secret IDs/URLs already obtained so the user is not asked for them twice.
9. When UI labels or Google/Element451 navigation may have changed, verify current official documentation before giving exact click paths.
10. The finished fork should feel like the included Project Tracker running at another Element451 institution—not like a newly redesigned application.
