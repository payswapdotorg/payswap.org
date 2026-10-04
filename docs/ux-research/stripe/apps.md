Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages/docs via automated extraction, no authentication

# Stripe Apps — extensibility model, components, and pattern library

Sources: R2 notes for `docs.stripe.com/stripe-apps`, its design-patterns index, and the empty-state + loading pattern pages. JSX code interiors were partially stripped by the text extraction (recorded honestly by R2); visual renders were not captured.

## The apps model

- Definition: apps let developers "develop and distribute apps privately or publish them on the global Stripe Apps Marketplace" — an app either extends the Dashboard with embedded UI or integrates a third-party service (authenticate users, listen for events, automate workflows).
- **Two form factors.** UI extensions render inside Dashboard **viewports** (embedded surfaces within existing Dashboard pages; roles can be assigned in UI extensions), and **full-page apps** are "a custom Stripe Dashboard page that provides a complete, multi-view interface". Honest observation: Directive B §14 references "drawer applications" — that exact term was not observed on the surveyed pages; viewports (embedded panels) are the closest documented equivalent.
- Viewports are documented as a reference surface — "Review a list of available viewports for Stripe Apps and how your end users see them" — placement is a declared, reviewable property of the app, not freeform injection.
- The getting-started ramp pairs Common use cases with Sample apps before Create an app — templated entry before blank-slate building.
- **Distribution spectrum:** private upload → test versions → publish to Marketplace → promote; versioned releases; deep links, route descriptors, install links; app analytics; embedded components; embedding third-party Stripe Apps inside your own.
- Distribution is documented as a pipeline of sub-guides — Distribution options, Upload your app, Versions and releases, Test your app, Publish your app, Promote your app, Add deep links, Navigate with route descriptors, Create install links — each a step a developer can be in.
- Embedded components extend app UI beyond the Dashboard, and third-party Stripe Apps can be embedded inside another app — composability at two levels.
- **Trust surfaces:** a declarative app manifest (index of fields and permissions), the Secret Store API to "persist sensitive data, like authentication credentials", permission declarations, and a first-class app settings page per app.
- **Installed-apps management:** installed apps are managed from the Dashboard; the docs pair "Build Stripe apps" with "Use apps from Stripe" (the installer/consumer side), plus sandbox support and per-mode app handling as build topics.
- **AI-era affordance:** "Build with a coding agent — Use the Stripe Apps skill to build, preview, and test an app."
- Migration paths are documented from Connect extensions and from plugins.
- Docs sub-tree shape: **Get started** (Create an app, How Stripe Apps work, Common use cases, Sample apps, Build with a coding agent) / **Build an app** (Secret Store, auth methods, authorization flows, server-side logic, listen to events, handle different modes, sandbox support, local network access, app settings page, build a UI, onboarding, distribution) / **Reference** (manifest, CLI, Extension SDK, Permissions, Viewports, Components, Design patterns).

## Component kit surface

Reference layer: App manifest, CLI, Extension SDK, Permissions, Viewports, Components library, Design patterns. Components carry UX semantics as props — DataTable's `emptyMessage` (an object with message + action for a CTA, or a plain string when no action; swapped dynamically by context), Spinner's `delay` (ms before display, to prevent flash-of-loading), Button's `pending` (pending visual style + disabled state, preventing double submission).

## Pattern library (docs.stripe.com/stripe-apps/patterns)

Framed as review-accelerators: "Follow our recommended design patterns to expedite your Stripe app review." A pattern is a composition of components (e.g. Spinner + others = a Loading screen). Categories:

- **Layout:** full-page apps, chart layout, lists, filter controls.
- **Onboarding:** sign-in, settings sign-in, demo content, additional context, redirects, sign-out.
- **User actions:** back link, action buttons.
- **Status:** communicating state, empty state, loading, progress stepping, waiting screens.

**Empty-state rules (quoted):** explain why it's empty — "No transactions" is less helpful than "No transactions yet."; title + action work as call-and-response ("No customers yet" → "Add customer"); title states what's missing, a short phrase with a period, no promotion; description under 14 words, active voice; render order is "loading first, then error…, then empty…, then content"; filtered-empty ≠ no-data-empty (offer "Clear filters", never a "create first item" CTA when items exist but are filtered out). A section-level compact variant uses a dashed border, non-bold title, and a caption-font centered description — it "mirrors the empty state pattern used across the Stripe Dashboard".

**Loading rules (quoted):** immediate feedback as soon as a fetch begins; scope-matched spinners (large = full-page/full-tab, medium = section, small = inline/table cells); delay "200–300ms for most data fetches", 0ms for known-slow operations, 100ms for view transitions; keep the tab bar visible and interactive during tab loading — replacing it makes users "lose their navigation context" and think the app is broken.

**Remaining Status patterns:** communicating state (making async outcomes legible), progress stepping (multi-stage progress), and waiting screens (long-running operations) complete the category; pattern pages carry "Before you begin" prerequisites, code samples, and callout blockquotes for anti-patterns.

## Marketplace

Global distribution with private-first onboarding: the same app travels upload → publish; versions and releases gate what merchants receive; promotion and analytics close the loop. Preview signup for new app components and capabilities is a simple email form.

## PaySwap implications (Directive B §14)

- Architecture mapping: PaySwap Core → Capability Marketplace → Extensions, with the directive's extension categories — DEX extensions, blockchain connectors, wallet connectors, off-ramps, security providers, accounting tools, analytics, merchant tools, AI agents, protocol capabilities.
- Model extension capability declarations on the app manifest pattern (declarative permissions index) + Secret Store separation: capabilities never hold credentials inline.
- Support both extension form factors in the PaySwap component kit: embedded panels inside existing surfaces (the viewport equivalent) and full-page multi-view apps.
- Adopt the pattern-library-as-review-gate idea: publish PaySwap UX patterns and make conformance part of extension review.
- Mirror the distribution lifecycle for capability listings: private install → tested versions → published → promoted, with versioned releases gating what merchants receive and analytics closing the loop.
- The empty/loading rules (call-and-response empty states, scope-matched spinners, render order, filtered-empty distinction, pending buttons) belong in PaySwap's `component-patterns.md` essentially verbatim.

## Not observable from static content

Visual renders of the patterns (images not extracted), app review process internals, Marketplace listing UX, runtime behavior of viewports and embedded components.

## Cross-references

Related files in this set: `public-pages.md`, `developers.md` (CLI, Extension SDK, docs IA), `component-patterns.md` (owns the empty/loading pattern detail), `workflow-patterns.md`, `settings.md` (app settings pages, sandbox app installs), `pay-swap-ux-mapping.md`, `README.md`.
