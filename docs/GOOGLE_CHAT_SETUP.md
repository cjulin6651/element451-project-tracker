# Google Chat Setup

Google Chat is optional. The code supports private intake from Chat, optional creation/completion posts to an originating conversation, and optional private completion pings for Project Tracker watchers.

## Required Google configuration

Use the same Standard Google Cloud project linked to the Apps Script project unless your architecture intentionally separates them. Enable the Google Chat API and People API when Chat is used. The Apps Script manifest already declares the Chat advanced service/scopes used by the build.

## Canonical dashboard URL

Set Apps Script Script Property:

```text
PROJECT_TRACKER_WEB_APP_URL
```

to the production Project Tracker web-app `/exec` URL. Chat-generated viewer links use this canonical URL.

## Service account for delayed/app-auth messages

If your selected Chat features require the service-account path, create a service account in the linked Cloud project and configure the appropriate Workspace Domain-Wide Delegation in Admin Console.

Do not commit the private key. Store credentials in Apps Script Script Properties using one of these supported forms:

```text
CHAT_SERVICE_ACCOUNT_JSON
```

or:

```text
CHAT_SERVICE_ACCOUNT_EMAIL
CHAT_SERVICE_ACCOUNT_PRIVATE_KEY
```

Grant only the OAuth scopes required by the features you enable. Re-check current Google Chat/Workspace documentation when configuring Domain-Wide Delegation or Marketplace settings because platform UI and availability can change.

## Chat app configuration

Configure the Google Chat API to use the Apps Script Workspace add-on deployment. Configure quick commands/message actions appropriate to the current Google Chat platform capabilities and your Workspace release channel. Keep initial visibility limited to testers.

## Validate

Run:

```text
migrateGoogleChatIntegration()
```

only when adding the Chat schema to an existing initialized Project Tracker installation. A fresh `setup()` already creates the current schema.

Then run:

```text
verifyGoogleChatIntegration()
```

Test with at least two users before broad rollout. Confirm private-by-default behavior, imported sender/timestamp accuracy, viewer grants only for configured domains, signed-link restrictions, attachment handling, and idempotent completion notifications.
