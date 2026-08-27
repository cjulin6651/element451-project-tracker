# Project Tracker — Element451 Institution Template

Project Tracker is an Element451-focused project/ticket management system built with Google Apps Script, Sheets, Drive, Gmail, Google Chat, and an optional Chrome extension.

This repository is intended to let another **Element451 institution reproduce the included Project Tracker**, changing only the institution-specific values and Google resources required for its own deployment.

It is not meant to be redesigned from scratch during setup.

> **Important for AI-assisted setup:** the source in this repository is the complete working reference implementation. ChatGPT, Claude, or another coding assistant should inspect and modify the existing files in place. It should **not** use the Markdown documentation as a specification to generate a new or simplified Project Tracker. Preserve the existing architecture, UI, workflows, and integrations unless the institution-specific setup or the user explicitly requires a change.

## Start here

Read [`START_HERE.md`](START_HERE.md) first.

The setup process is deliberately beginner-friendly:

1. Fill out the short [`INSTITUTION_CONFIG_QUESTIONNAIRE.md`](INSTITUTION_CONFIG_QUESTIONNAIRE.md).
2. Give ChatGPT or Claude the full repository, the completed worksheet, and [`SETUP_WITH_AI.md`](SETUP_WITH_AI.md).
3. Start immediately.
4. The AI guides Drive, Apps Script, Element451 credentials, Google Cloud, deployment, Gmail, Chat, and the Chrome extension **one phase at a time while you build them**.
5. Real staff access and secrets are entered directly into Google—not pasted into AI chat or committed to Git.

You do **not** need to be a Google Workspace administrator simply to begin this process.

## What the pre-setup worksheet asks for

Only institution-specific values that are safe and useful before setup, such as:

- institution name;
- the domain after `@` in institutional Google accounts;
- Element451 tenant URL;
- names of any additional person/student ID types used beyond Element451's native ID;
- an explicitly requested naming/branding difference.

It does **not** ask for staff names/emails, Google Cloud IDs, Drive folder IDs, deployment IDs, service-account configuration, or credentials. Those belong in the guided build phases.

## Element451 is required

This repository is specifically for institutions using Element451. The included Related Students, Related Resources, person/profile resolution, Gmail/Chat enrichment, and other functionality assume an Element451 tenant and API access.

The normal setup path keeps the included Element451 architecture and changes the tenant-specific values.

## User access is configured privately in Google Sheets

The public template intentionally seeds **no real users** in source code.

After `setup()` creates the Project Tracker data spreadsheet, the installer enters access directly in its `Agents` tab:

- `agent` — can edit and can be assigned work;
- `editor` — can edit but is not assignable; can manage High Priority;
- `viewer` — read-only and intended for signed ticket links.

The AI should explain those columns and roles, but it should never need the real names or email addresses.

The `Types`, `Departments`, and `Sizes` tabs can likewise be edited directly after setup if the included neutral defaults need local changes.

## Workspace domain

Project Tracker's allowed viewer domain does not normally require Google Admin Console research. If the institution's managed Google accounts look like `person@example.edu`, the domain value is simply `example.edu`.

If a later integration step genuinely requires Workspace administrator approval, the setup assistant should identify that at the exact phase where it is needed.

## Repository map

| File / folder | Purpose |
|---|---|
| [`START_HERE.md`](START_HERE.md) | **Read first.** Minimal preparation and the exact AI handoff. |
| [`INSTITUTION_CONFIG_QUESTIONNAIRE.md`](INSTITUTION_CONFIG_QUESTIONNAIRE.md) | Short institution-specific worksheet; no contacts or secrets. |
| [`SETUP_WITH_AI.md`](SETUP_WITH_AI.md) | Phase-by-phase build instructions for ChatGPT/Claude. |
| [`CUSTOMIZATION_MAP.md`](CUSTOMIZATION_MAP.md) | Reference showing where institution-specific configuration lives. |
| [`MANUAL_SETUP_GUIDE.md`](MANUAL_SETUP_GUIDE.md) | Secondary technical reference for manual setup. |
| [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md) | Secret/privacy checks. |
| [`GITHUB_PUBLISHING_CHECKLIST.md`](GITHUB_PUBLISHING_CHECKLIST.md) | Checks before publishing a reusable fork/release. |
| [`SCRUB_REPORT.md`](SCRUB_REPORT.md) | Summary of the institution-specific data removed/generalized from the source implementation. |
| `apps-script/` | Dashboard/backend, setup, Gmail, Chat, Element451, and workload source. |
| `chrome-extension/` | Optional Chrome extension source. |
| `assets/` | Neutral Project Tracker icon assets. |
| `docs/` | Architecture and feature-specific references. |

## Core behavior kept by default

Unless an adopting institution explicitly requests a change, the setup should preserve the included:

- dashboard and ticket workflow;
- agent/editor/viewer role model;
- signed viewer links;
- Related Students and Related Resources;
- Gmail add-on and watched-thread behavior;
- Google Chat intake/sharing/completion behavior;
- workload/capacity features;
- Chrome extension behavior;
- Element451 integration model.

The goal is the same Project Tracker running with a different institution's tenant, IDs, storage, and deployment configuration.

## Security rule

Do not put these values in GitHub, markdown, screenshots, AI prompts, or example commands:

- Element451 API/bearer key;
- Element451 Feature token;
- Element451 Analytics token;
- Google service-account private key/JSON contents;
- OAuth client secrets;
- temporary access/refresh tokens;
- passwords;
- real student/person data used only for testing;
- staff access lists.

The architecture keeps Element451 credentials in a restricted Google Sheet and Google Chat service-account material in Apps Script Script Properties.

## Template placeholders

During the guided build, the AI will progressively replace values such as:

```text
YOUR INSTITUTION
example.edu
PASTE_SHARED_DRIVE_ID_HERE
PASTE_TICKETS_FOLDER_ID_HERE
PASTE_ARCHIVE_FOLDER_ID_HERE
PASTE_GOOGLE_SHEET_ID_HERE
YOUR_ELEMENT451_CLIENT
REPLACE_WITH_CHROME_EXTENSION_OAUTH_CLIENT_ID
example.com/project-tracker-icon
```

These do not all need to be known before setup begins; many are generated during later phases.

## Before publishing a fork

Run [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md) and [`GITHUB_PUBLISHING_CHECKLIST.md`](GITHUB_PUBLISHING_CHECKLIST.md), including repository-wide scans for institution domains, real email addresses, Drive IDs, OAuth IDs, deployment IDs, API keys, and service-account material.

## License

No open-source license is included because the repository owner should choose the terms under which the project is published. Add an appropriate `LICENSE` file before making a repository public if you want others to have explicit reuse/modification rights.
