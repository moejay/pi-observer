# Security

## Supported version

Security fixes target the latest 1.x release.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/moejay/pi-observer/security/advisories/new)
rather than a public issue for sensitive reports. Do not include credentials or
unsanitized session files. For non-sensitive bugs, use the issue tracker.

## Trust and privacy boundaries

Pi extensions run with the host process's permissions. This extension is not a
sandbox, permission system, or tamper-proof audit log. An agent with file/shell
access may alter the extension or session file. Other trusted extensions can
transform input before the observer sees it.

Assessments make additional model requests using Pi's configured credentials.
Bounded user input, assistant text, tool arguments/results, and working-agent
instructions may contain secrets. V1 does not automatically redact secrets.
Choose an appropriate provider or pause assessments for sensitive work.

Only input observed as interactive is used as user-intent authority. RPC,
extension-injected, and unverified historical messages remain contextual.
Citation matching is enforced in code; whether a quote semantically supports
a goal interpretation remains a model judgment.

Spending limits rely on model price metadata and reported usage, so they are
not a provider-enforced hard cap. Pausing stops new assessments but still
records interactive user messages in the existing session file.
