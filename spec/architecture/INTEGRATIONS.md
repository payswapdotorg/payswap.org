# Integration Contracts

## REST / HTTP
Expose goals, programs, intents, quotes/plans, approvals, execution status, balances/projections, capabilities, incentives, contribution history, disputes and evidence.

Every mutation is idempotent.

## Developer API
Support payment requests, recurring economic programs, acceptance endpoints, webhooks, Agent Packages and Extensions.

Developer integrations should not depend on the internal agent organization.

## MCP
MCP is the agent-to-capability/tool boundary.

A PaySwap MCP adapter enforces authorization, audience, network policy, metering, evidence and capability lifecycle.

MCP is not the financial authority.

## A2A
A2A is the cross-organization agent collaboration boundary.

Messages carry task, capability, authorization/evidence requirements, expected output and lifecycle context.

A reachable A2A peer does not gain financial authority.

## AG-UI
AG-UI is the application/user event boundary.

Approval requests, tool requests, execution state and evidence links are rendered from authoritative protocol state.

The UI cannot declare finality.

## Messaging
WhatsApp, Telegram, Slack, Signal and similar surfaces are trusted only when the session is authenticated and bound to a current authorization flow.

Message text cannot silently expand authority.

## Rail adapter
Canonical adapter contract includes:
- capability discovery;
- quote;
- preflight;
- prepare;
- submit;
- status;
- cancel where supported;
- reconcile;
- evidence retrieval.

Only the Financial Protocol Authority issues an execution grant.

## Versioning
Every interface has explicit protocol version, compatibility window, deprecation path and conformance tests.

Provider-specific SDK types and quirks stay inside adapters.
