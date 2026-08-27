# Institution Customization Map

This is the inventory of values most likely to differ between institutions.

| Area | Setting | File / location | Notes |
|---|---|---|---|
| Institution | Institution display name | `apps-script/Config.gs` → `CONFIG.INSTITUTION_NAME` | Used for documentation/config context. |
| Identity | Allowed Workspace viewer domains | `CONFIG.ALLOWED_VIEWER_DOMAINS` | Supports multiple domains. Google Chat automatic viewer grants use this allow-list. |
| Branding | Add-on/dashboard logo and favicon URLs | `CONFIG.BRAND_LOGO_URL`, `CONFIG.BRAND_FAVICON_URL`, plus `appsscript.json` | Workspace manifest logo must be a public HTTPS URL. |
| Locale | Time zone | `apps-script/appsscript.json` → `timeZone` | Use the institution's IANA time zone. |
| Drive | Shared Drive ID | `CONFIG.DRIVE_ID` | Data spreadsheet is created here. |
| Drive | Active ticket folder ID | `CONFIG.TICKETS_FOLDER_ID` | Ticket file folders/resources use this location. |
| Drive | Archive folder ID | `CONFIG.ARCHIVE_FOLDER_ID` | Completed/archived file handling. |
| Data | Spreadsheet name | `CONFIG.SPREADSHEET_NAME` | Default is `Project Tracker Data`. |
| Tickets | Ticket prefix/padding | `CONFIG.TICKET_PREFIX`, `CONFIG.TICKET_PAD` | Example default `TKT-0001`. |
| Workflow | Status model / labels | Multiple business-logic and UI files | Current model includes Wish List, Up Next, In Progress, On Hold/Halted, Completed, and Trash. Changing it is a code-level customization, not just a seed value. |
| Terminology | Ticket/project wording | UI/add-on/extension source | The code uses both “ticket” and “project”; institutions may want a consistent local term. |
| Roles | Agents/editors/viewers | Live `Agents` tab in the Project Tracker data spreadsheet | The public template seeds no real users. Enter access directly in Sheets after `setup()` so staff contact information never needs to be placed in source or an AI prompt. |
| Taxonomy | Project types/default sizes | `SEED.types`, then live `Types` tab | Neutral defaults are included. Keep them initially or edit the live Sheet directly after setup. |
| Taxonomy | Departments | `SEED.departments`, then live `Departments` tab | Neutral defaults are included. Institution-specific labels can be entered directly in the live Sheet. |
| Taxonomy | Size labels/time guidance | `SEED.sizes` | Defaults can be retained or customized. |
| Workload | Snapshot hour/baseline | `CONFIG.WORKLOAD_STUDY_SNAPSHOT_HOUR`, `CONFIG.WORKLOAD_STUDY_BASELINE_START` | Optional workload study. |
| Element451 | Client/tenant slug | `apps-script/ElementConfig.gs` → `ELEMENT451_CONFIG.CLIENT` | From `https://CLIENT.element451.io/`. |
| Element451 | Resource-ID prefix | `ELEMENT451_CONFIG.RESOURCE_ID_PREFIX` | Usually same as client, but configurable. |
| Element451 | API host | `ELEMENT451_CONFIG.API` | Default `api.451.io`. |
| Element451 | Credential sheet ID/name/range | `ElementConfig.gs` | IDs only in source; actual credentials remain in the restricted sheet. |
| Element451 | API URL whitelist | `apps-script/appsscript.json` | Replace `https://example.api.451.io/` with your tenant API host (`https://YOUR_CLIENT.api.451.io/`). |
| Element451 | Additional person/student identifier types | `CONFIG.ADDITIONAL_STUDENT_ID_TYPES` plus `Element451.gs`, `RelatedStudents.gs`, `Index.html`, and Gmail/Chat enrichment | Ask what identifiers the institution actually uses beyond Element ID. Two optional slots are disabled by default; configure only real identifiers and extend the resolver if more than two are needed. |
| Element451 | Identifier mapping slugs | `apps-script/Element451.gs` and tenant mapping diagnostics | Verify against the adopting tenant. Never invent a mapping slug. |
| Element451 | Optional automatic ID recognition | `apps-script/Config.gs` plus Gmail/Chat extraction logic | Enable only for explicitly selected identifier types with a reliably distinguishable format. Keep disabled when ambiguous. |
| Workspace add-on | Public logo URL | `apps-script/appsscript.json` | Separate static manifest value. |
| Workspace/Cloud | APIs, OAuth consent, Marketplace visibility | Google Cloud and, only when required, Workspace Admin | Configure during the guided build. Do not assume the installer is a Workspace administrator. |
| Workspace/Cloud | OAuth/Marketplace branding + support URLs | Google Cloud / Workspace Marketplace consoles | App name, support/developer contacts, homepage, privacy policy, terms, screenshots/tiles, and distribution audience vary by institution. |
| Governance | Data retention / privacy rules | Policy + optionally code/config | Decide retention for tickets, notes, Gmail/Chat captures, attachments, student links, notifications, and deleted items. |
| Web app | Canonical production URL | Script Property `PROJECT_TRACKER_WEB_APP_URL` | Set after web deployment. |
| Google Chat | Service account JSON or email/private key | Script Properties | Secret; never commit. |
| Google Chat | DWD client ID/scopes | Google Admin Console | Environment-specific. |
| Chrome extension | OAuth client ID | `chrome-extension/manifest.json` | Institution/extension-specific; not a secret, but template is scrubbed. |
| Chrome extension | Web-app URL | Extension Options | Stored per browser installation. |
| Chrome extension | Apps Script API deployment ID | Extension Options | Stored per browser installation. |
| Product naming | App/add-on/extension display name | `appsscript.json`, HTML/add-on source, extension manifest | Only change if institution wants a different product name. |
| Branding | Colors | `Index.html`, `GmailAddon.gs`, `chrome-extension/styles.css` | Optional aesthetic customization. |

## Assumptions intentionally removed from business logic

The template no longer hard-codes a specific Element451 hostname, a specific `tenant.resource.123` prefix, one college email domain, one set of staff accounts, one set of departments, or one institution-specific external-ID format. Those behaviors must come from the adopting institution's configuration/identity model or remain disabled until explicitly adapted.

## Other values to evaluate even if you keep the defaults

- notification retention;
- page/search limits;
- attachment limits;
- Gmail watcher behavior;
- Chat completion polling;
- whether viewer grants should be offered at all;
- whether Related Students should be enabled in environments with different privacy rules;
- data retention and Drive sharing policies;
- Marketplace distribution model;
- Chrome Web Store/internal-extension distribution model.
