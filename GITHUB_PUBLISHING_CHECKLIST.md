# GitHub Publishing Checklist

Use this after institution adaptation and before making a repository public.

## Repository contents

- Keep source under `apps-script/` and `chrome-extension/`.
- Rebuild any release ZIP after source changes so a stale nested archive cannot retain removed values.
- Do not commit Apps Script `.clasp.json` files if they expose a production script ID unless that is intentional.
- Do not commit downloaded service-account JSON, credential exports, logs, screenshots, or production data.

## Institution/privacy scrub

Search both normal files and release archives for:

- institution name, domains, and tenant URLs;
- staff/student names and email addresses;
- Drive/folder/file IDs;
- Apps Script deployment IDs;
- OAuth client IDs you do not want published;
- API keys/tokens and private-key material;
- copied student/person data;
- old deployment names and internal-only URLs.

Use `SECURITY_CHECKLIST.md` as the minimum security review.

## Documentation

- Update `README.md` and `START_HERE.md` for the fork's supported components.
- Review `INSTITUTION_CONFIG_QUESTIONNAIRE.md` and remove any completed local answers before turning an institution-specific fork back into a reusable public template.
- Keep `SETUP_WITH_AI.md` if you want future maintainers to be able to reconfigure the project interactively.
- Record local deviations from the template in your fork rather than hard-coding unexplained assumptions.

## GitHub settings

- Choose a repository visibility appropriate to your data/governance requirements.
- Add a `LICENSE` only after deciding the reuse terms you intend to grant.
- Enable secret scanning and dependency/security features available for the repository.
- Protect the default branch if multiple maintainers will contribute.
- Require review for changes to authorization, credential handling, or deployment configuration when practical.

## Final release test

Clone/download the repository into a clean location and follow the setup documentation as though you were a new institution. Confirm the docs do not depend on knowledge that only the original implementers have.
