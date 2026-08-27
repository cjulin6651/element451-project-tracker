# Start Here: Set Up Project Tracker at Your Element451 Institution

This repository is meant to reproduce the included Project Tracker at another **Element451 institution** with as little redesign as possible.

You do not need to understand Google Apps Script, Google Cloud, OAuth, service accounts, or deployment before you begin. The AI setup prompt is designed to teach and guide those steps **while you build the project**.

## What you need before prompting the AI

Very little:

- a copy/fork of this repository;
- an institutional Google account you normally use for work;
- your institution's Element451 URL;
- the short institutional worksheet in `INSTITUTION_CONFIG_QUESTIONNAIRE.md`.

You do **not** need to be a Google Workspace administrator just to begin.

You also do **not** need to create a Shared Drive, Apps Script project, Google Cloud project, OAuth client, service account, credential Sheet, deployment, or Marketplace listing before prompting the AI. Those are setup phases.

---

# Step 1 — Fill out the short institution worksheet

Open:

`INSTITUTION_CONFIG_QUESTIONNAIRE.md`

It asks only for values that are genuinely different between institutions, such as:

- institution name;
- the domain after `@` in institutional Google accounts;
- the Element451 tenant URL;
- whether you use other person/student IDs in addition to Element451's own ID;
- any known local naming/branding differences.

It deliberately does **not** ask for Google Cloud IDs, Drive folder IDs, deployment IDs, service accounts, or staff access lists. Those are created/configured later with guidance.

## Do not put people or secrets in the worksheet

Do not enter:

- staff names or staff email addresses;
- real student information or student IDs;
- Element451 API keys/tokens;
- OAuth secrets;
- passwords;
- service-account private keys.

Project Tracker access is configured later by entering users directly into the private Google Sheet created by Project Tracker. The AI will tell you what to enter without needing to see the information.

---

# Step 2 — Prompt the AI immediately after the worksheet

Once the short worksheet is filled out, give ChatGPT or Claude:

1. the **full repository**;
2. `SETUP_WITH_AI.md`;
3. your completed `INSTITUTION_CONFIG_QUESTIONNAIRE.md`.

Then send this message:

> Use `SETUP_WITH_AI.md` to guide me through building this Project Tracker for my institution. Use my completed `INSTITUTION_CONFIG_QUESTIONNAIRE.md` for the institution-specific values I already know. **Do not rebuild the application from scratch. Inspect and modify the existing source files in this repository; they are the complete working reference implementation and the source of truth.** Preserve the included UI, workflows, integrations, and features unless an institution-specific value or an explicit request requires a change. Guide me one setup phase at a time and assume I am new to Apps Script and Google Cloud. Do not ask me to paste staff contact lists, student data, API keys, tokens, passwords, OAuth secrets, or private keys into chat.

That is the point when the technical setup should begin.

Do **not** spend hours creating Google resources first and then prompt the AI afterward. The AI prompt is supposed to guide those steps in the correct order.

---

# Step 3 — Follow the guided phases

`SETUP_WITH_AI.md` directs the AI through the build in this order:

1. apply the few institution-specific values from your worksheet;
2. create/select the Google Drive storage and capture the needed folder IDs;
3. create the Apps Script project and add the source files;
4. create the restricted Element451 credential Sheet and enter credentials locally;
5. run Project Tracker setup and configure agents/editors/viewers privately in the generated spreadsheet;
6. test Element451 and configure any additional institutional ID types;
7. configure the linked Google Cloud project and required APIs/OAuth pieces;
8. deploy and test the core web app;
9. configure and test the Gmail add-on;
10. configure and test Google Chat;
11. configure and test the Chrome extension;
12. run a complete validation/security cleanup.

The AI should give you only the instructions needed for the current phase, explain where to click, and tell you which **non-secret** result to bring back before moving on.

---

# How user access is handled

Staff access is intentionally **not** part of the institution worksheet or AI interview.

During setup, Project Tracker creates an `Agents` tab in its private data spreadsheet. The AI will tell you how to enter users directly there.

The columns are:

- `email`
- `display_name`
- `role`
- `active`

Roles are:

- `agent` — can edit and can be assigned work;
- `editor` — can edit but is not assignable; can manage High Priority;
- `viewer` — read-only access intended for signed ticket links.

The AI does not need to know who those people are. You make those entries yourself in Google Sheets.

The same approach applies to institution-specific Types, Departments, and Sizes: after setup, those tabs can be edited directly without sending internal organizational information to an AI.

---

# About your Google Workspace domain

You normally do not need Google Admin Console access simply to know the institutional domain used by Project Tracker.

If your normal institutional Google account ends in `@example.edu`, the domain value is simply:

`example.edu`

Only the domain is needed—not your full email address.

If a later Google step genuinely requires Workspace administrator approval (for example, a particular Domain-Wide Delegation configuration), the AI should identify that **at that phase** and tell you exactly what an administrator needs to approve.

---

# What stays the same by default

The repository should be treated as a working reference implementation, not a blank framework. The source code is already the application. The AI should inspect and patch those files rather than generating a new Project Tracker from the Markdown documentation.

**Do not accept a setup result that replaces the repository with a smaller, simplified, or newly designed app unless you specifically asked for a redesign.** Institution-specific setup should normally be configuration changes and targeted edits to the included implementation.

Unless you explicitly request a difference, the setup should preserve the included:

- dashboard and ticket behavior;
- workflow/status behavior;
- roles and signed viewer-link model;
- Related Students and Related Resources;
- Gmail add-on behavior;
- Google Chat behavior;
- workload/capacity features;
- Chrome extension behavior;
- Element451 integration model.

Institution-specific technical values should be swapped in as they are created or identified.

---

# File map

| File | Purpose |
|---|---|
| `START_HERE.md` | **Read this first.** Tells a beginner when to start and what to provide. |
| `INSTITUTION_CONFIG_QUESTIONNAIRE.md` | Short worksheet containing only institution-specific values safe to give an AI. |
| `SETUP_WITH_AI.md` | Main phase-by-phase implementation prompt for ChatGPT/Claude. |
| `CUSTOMIZATION_MAP.md` | Reference showing where institution-specific values live in the source. |
| `MANUAL_SETUP_GUIDE.md` | Secondary technical reference if you need to perform a step without AI guidance. |
| `SECURITY_CHECKLIST.md` | Final secret/privacy review. |
| `GITHUB_PUBLISHING_CHECKLIST.md` | Checks before publishing a reusable fork/release. |

## The entire setup in one line

**Fill out the short institution worksheet → give the repo + worksheet + `SETUP_WITH_AI.md` to the AI → build one guided phase at a time → enter users/secrets privately in Google → validate everything.**
