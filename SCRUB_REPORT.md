# Template Scrub Report

The reusable template was derived from an existing institutional deployment and intentionally neutralized for public/reusable distribution.

## Removed or generalized

- institution name and references in source documentation;
- production staff names and email addresses;
- Workspace domain restriction;
- Shared Drive ID;
- active ticket folder ID;
- archive folder ID;
- Element451 tenant/client hostname;
- hard-coded Element451 resource-ID prefixes;
- tenant-specific Element URL parser regexes;
- tenant-specific external-ID inference assumptions;
- production logo Drive-file URLs;
- Chrome extension OAuth client ID;
- historical production deployment names;
- institution-specific department seeds and project-type taxonomy;
- production workload-study baseline date.

## Code portability changes

- Element person/resource URLs are parsed against `ELEMENT451_CONFIG.CLIENT` / `RESOURCE_ID_PREFIX` instead of a hard-coded tenant.
- Browser-side Element URL recognition receives the configured tenant through the dashboard bootstrap payload.
- Google Chat viewer grants use `CONFIG.ALLOWED_VIEWER_DOMAINS` instead of a hard-coded email suffix.
- institution-specific external-ID inference is disabled by default; optional external-ID slots must be explicitly labeled/mapped for the adopting institution, and automatic token recognition requires a verified format.
- first-run `setup()` validates that required template placeholders have been replaced.
- dashboard/Gmail branding uses template configuration rather than a production Drive image URL where runtime configuration is possible.
- a new `START_HERE.md` onboarding path explains preparation, questionnaire completion, AI handoff, local secret entry, deployment, and validation.
- the Add Student UI no longer exposes any institution-specific external-ID labels by default; raw Element ID is supported directly and optional external IDs appear only when enabled/configured.

## Intentionally retained

- generic product name `Project Tracker`;
- generic icon artwork supplied with the project;
- schema/tab names;
- role semantics (`agent`, `editor`, `viewer`);
- generic ticket/status/size behavior;
- Element451 API integration logic and standard identity slugs;
- Google API scopes needed by the feature set;
- generic external Google API URLs.
