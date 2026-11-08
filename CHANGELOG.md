# Changelog

## [1.0.0] - 2026-11-08

First public release of **Pi Observer**.

- Background assessments of efficiency/instruction friction, confusion, and goal alignment.
- Source-linked user intent derived only from observed interactive messages.
- Quiet, theme-aware status with review freshness and limited-context indicators.
- Readable reports with on-demand evidence and technical details.
- Interactive settings with toggles, choices, numeric inputs, and explicit Save/Cancel.
- Session-local persistence, conservative budget gates, cancellation, and single-flight scheduling.
- GitHub Pages documentation, automated checks, and MIT licensing.

### Boundaries

Read-only and advisory: no classifier, alerts, steering, or tool blocking. Model calls
send bounded session excerpts to the selected provider; there is no automatic secret
redaction. Budgets rely on reported usage and pricing, not a provider-enforced hard cap.
