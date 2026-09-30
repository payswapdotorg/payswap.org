# ADR-004 — Frontend and Deployment Architecture From Stage 0

Status: ACCEPTED
Date: 2026-09-30

## Decision

Frontend information architecture, user journeys, design-system foundations, state mappings and deployment topology are defined from the first Work Order rather than after backend completion.

W3-001 owns the initial UX/deployment contract and Stripe UX research.

## UX reference

Stripe.com and authenticated Stripe Dashboard surfaces are the primary reference lab for information architecture, onboarding, dashboard hierarchy, checkout, billing, Connect, operational states, developer experience and agentic commerce.

The product must be inspired by Stripe's clarity and coherence, not copy proprietary implementation or private data.

## Authentication rule

Public Stripe pages are surveyed directly. When a useful private/dashboard surface requires authentication, the authorized user authenticates through the browser session. Passwords, session cookies and private account data are never committed or copied into source-control artifacts.

## Deployment rule

Start with a free/low-cost-biased topology using Vercel, Neon, Cloudflare R2 and Upstash or equivalent provider-neutral services where suitable. Vendor replacement must remain possible.

Every major feature needs a production deployment owner, environment requirements, observability requirements and browser verification plan before completion.

## Consequences

UI coherence and deployability are tested continuously, preventing backend-complete/frontend-late architecture drift.
