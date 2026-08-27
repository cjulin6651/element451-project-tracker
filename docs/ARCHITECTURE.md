# Architecture

## Core

Project Tracker is a Google Apps Script application. Google Sheets is the structured data store and Google Drive stores ticket/project files. `Repo.gs` is the data-access layer; `Tickets.gs` contains ticket business logic; `WebApp.gs` exposes dashboard calls; `Index.html` is the dashboard UI.

## Data configuration

`Setup.gs` creates the spreadsheet and schema tabs from `Config.gs`. Script Property `SPREADSHEET_ID` points the running application to the data spreadsheet.

The `Agents` tab controls authorization. `Types`, `Departments`, and `Sizes` are also runtime data after initial seeding.

## Element451

`ElementConfig.gs` defines the tenant/client and the ID of a restricted credential Sheet. `Element451.gs` reads credentials server-side and performs person/resource resolution. `RelatedStudents.gs` and `RelatedResources.gs` attach resolved records to tickets.

Tenant URL parsing is configuration-driven. Do not reintroduce literal institution hostnames in Gmail, Chat, dashboard, or related-resource parsers.

## Gmail

`GmailAddon.gs` implements CardService UI. `GmailTicketing.gs` imports messages/attachments, enriches student/resource references, and maintains watched-thread behavior.

## Google Chat

`ChatAddon.gs` implements command/dialog UI. `ChatTicketing.gs` imports selected messages, preserves original message timestamps/senders, reuses Gmail enrichment, stores originating Chat links, and supports optional completion notifications.

## Chrome extension

`chrome-extension/` is a separate Manifest V3 extension. It authenticates with Google Identity and calls an Apps Script API-executable deployment. The extension's Options page stores the dashboard URL and API deployment ID per installation.

## Security boundaries

- application roles are checked server-side;
- viewer links use ticket-specific signed tokens;
- Element credentials never travel to the browser;
- Chat service-account credentials belong in Script Properties;
- optional integrations should be disabled/configured rather than weakening core authorization.
