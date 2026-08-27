# Institution-Specific Values Worksheet

This is intentionally a **short worksheet**. It is not a Google Cloud, Apps Script, or deployment questionnaire.

Project Tracker is already built. The goal is to make a copy that behaves almost exactly like the included version while replacing only the values that are different at your institution.

Fill out what you know below, then start the AI-guided setup. The AI will walk you through Drive, Apps Script, Google Cloud, Element451 credentials, deployment, Gmail, Chat, and the Chrome extension **one phase at a time while you build them**.

## Important privacy rule

Do **not** put staff names, staff email addresses, student information, API keys, tokens, passwords, private keys, or OAuth client secrets in this worksheet.

Project Tracker user access will be configured **directly in the Project Tracker spreadsheet during setup**. The AI should explain what to enter there, but you should not send those names or email addresses to the AI.

---

# 1. Institution name

Enter the institution name you want Project Tracker setup/documentation to use.

- Institution name:

---

# 2. Google Workspace email domain

Project Tracker needs to know which institutional email domain is allowed when it grants view-only access from Google Chat.

You do **not** need to be a Google Workspace administrator to answer this.

Use the part that comes after `@` in your normal institutional Google account.

Example:

- If an institutional account is `someone@example.edu`, enter `example.edu`.

Do not enter the person's full email address.

- Primary institutional Google email domain:

If your institution regularly uses more than one Google email domain for people who should be eligible for Project Tracker view-only access, list the additional domains. If you do not know of any, leave this blank. The AI can help address it later if it becomes relevant.

- Additional allowed Google email domains, if known:

---

# 3. Element451 URL

Open Element451 the way you normally do and copy the beginning of the URL through `.element451.io`.

It normally looks like:

`https://examplecollege.element451.io/`

The AI can derive the Element451 client/tenant slug from this URL, so you do not need to find that separately.

- Element451 base URL:

---

# 4. Other person/student ID types

Element451 already has its own person/record ID and profile URL. Some institutions also use one or more other identifiers, such as an SIS ID, student number, CRM ID, application ID, or another locally named identifier.

Does your institution use **any identifier other than the normal Element451 person ID/profile URL** that Project Tracker users should be able to use to find a student/person?

- Additional ID types used: yes / no / unsure

If yes, list only the **names your institution uses for those identifiers**. Do not enter real student IDs.

- Identifier name:
- Identifier name:
- Identifier name:

You do not need to know the Element451 mapping slug, API field, or recognition pattern yet. During the Element451 setup phase, the AI should help you identify the correct mapping safely and should use fake/example formats only when needed.

---

# 5. Local terminology or branding changes

The default product name is **Project Tracker**, and the included workflow and functionality should normally be kept as-is.

Only fill this section out if you already know you want something visibly different.

- Keep the name `Project Tracker`? yes / no
- If no, preferred name:
- Use the included Project Tracker icon/branding? yes / no / decide later
- If you already have a replacement logo/icon file, filename or description only:

---

# 6. Known institutional differences from the included version

The recommended approach is to keep the included behavior and change only institution-specific configuration.

If you already know of a local requirement that is different, describe it briefly here. Examples might include a different ticket prefix, different department labels, a locally used ID type, or a feature your institution does not want to deploy.

Do **not** list staff or student information.

- Known difference:
- Known difference:
- Known difference:

If there are no known differences, write:

`KEEP INCLUDED BEHAVIOR`

---

# Stop here

That is all you need to gather before starting.

Do **not** create the following just to complete this worksheet:

- a Shared Drive or folders;
- an Apps Script project;
- a Google Cloud project;
- OAuth credentials;
- an Element451 credential spreadsheet;
- a service account;
- Apps Script deployments;
- Chrome extension credentials;
- Marketplace configuration.

Those are setup tasks, not institutional questionnaire answers. `SETUP_WITH_AI.md` is designed to walk you through them in order.

## What to give the AI next

Give ChatGPT or Claude:

1. the full repository;
2. `SETUP_WITH_AI.md`;
3. this completed `INSTITUTION_CONFIG_QUESTIONNAIRE.md`.

Then use the starter message in `START_HERE.md`.
