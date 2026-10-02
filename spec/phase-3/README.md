# Phase 3 — Public Product Surface

Phase 3 builds the actual end-user application on top of the certified PaySwap protocol/provider runtime.

Maximum concurrency: 3.
Active Work Orders must be pairwise-disjoint.
Phase 1/2 financial architecture and historical records are frozen.

## Goal

Deliver a polished public PaySwap product UI, deployed on Vercel, backed by the existing API/protocol system, with a UX direction informed by the supplied `https://you-platform.vercel.app` reference.

## Non-negotiables

- no parallel financial authority in the UI;
- no fake financial state;
- no raw provider credentials in model context or ordinary artifacts;
- local-rail browser authorization is first-class;
- providerless routes remain supported;
- UNKNOWN remains distinct from FAILED;
- provider catalogue is never executable authority;
- external balances remain observations;
- max 3 workers.

## Work Orders

Wave 1:
P3-W1-001 Public web/deployment foundation
P3-W2-001 UX system and reference extraction
P3-W3-001 Product IA and journey contracts

Wave 2:
P3-W1-002 Authentication/onboarding/connection UX
P3-W2-002 Command Center implementation
P3-W3-002 Payment/provider/local-rail journeys

Wave 3:
P3-W1-003 Infrastructure hardening/free-tier cost controls
P3-W2-003 Responsive/accessibility/visual verification
P3-W3-003 End-to-end UI certification and release
