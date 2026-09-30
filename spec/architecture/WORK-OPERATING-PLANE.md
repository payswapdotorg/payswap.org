# Work Operating Plane

## Why this exists

A one-year synthetic multi-industry simulation showed that economic intelligence alone is insufficient for professionals to make PaySwap their main interface.

Professionals work through projects, cases, customers, documents, deadlines, conversations, approvals and external systems before they reach the money movement.

The Work Operating Plane provides the universal context layer above external systems and below the experience/agent layer.

## Core objects

- Workspace;
- Organization;
- Party;
- Project;
- Case/Matter;
- WorkItem;
- Task;
- Milestone;
- Deliverable;
- Request;
- Issue;
- Decision;
- Approval;
- Contract;
- Quote;
- Order;
- Document;
- Conversation;
- Meeting;
- Event/CalendarItem;
- Asset;
- Resource;
- ExternalRecordLink;
- WorkDependency;
- SLA/Deadline.

Domain packs may specialize these objects without breaking the universal model.

## Work Graph

The Work Graph links:
- people and roles;
- organizations;
- projects/cases;
- documents;
- tasks;
- decisions;
- conversations;
- contracts;
- assets;
- external records;
- economic intents;
- obligations;
- payments;
- invoices;
- credits;
- incentives;
- evidence.

The graph is context, not a replacement for every external system of record.

## Work Program

A complex human request can compile into a Work Program:
goal/context → work plan → tasks → external actions → economic intents → approvals → outcomes.

EconomicProgram and WorkProgram can reference each other.

## Universal work interface

The main interface should support:
- universal search;
- command/ask bar;
- universal inbox;
- activity/timeline;
- projects/cases;
- approvals;
- documents/knowledge;
- conversations;
- tasks;
- goals/opportunities;
- economic activity;
- external-system views.

Users should be able to inspect or act on an external object without navigating away when the connector supports it.

## External system strategy

PaySwap is not required to become the authoritative system of record for every domain.

Instead:
1. connect external systems;
2. ingest canonical references and permitted data;
3. map them into the Work Graph;
4. let agents reason over authorized context;
5. execute writes through certified connectors;
6. write results/evidence back into the graph.

## Context and permissions

Work context is tenant-isolated and role-scoped.

An agent receives only the Work Graph subset permitted by:
- workspace policy;
- role;
- project/case membership;
- data-purpose policy;
- jurisdiction;
- document sensitivity;
- connector permissions.

## Long-running work

Work Programs support:
- deadlines;
- dependencies;
- retries;
- waiting states;
- human approvals;
- escalations;
- SLAs;
- handoffs;
- external events;
- compensating actions;
- postmortems.

A long-running project cannot depend on a single model session.

## Offline and field use

Field-heavy verticals need:
- mobile-first workflows;
- offline capture;
- local encrypted queue;
- later synchronization;
- conflict resolution.

This is a UX/runtime requirement, not a separate vertical architecture.

## Collaboration across organizations

Projects can include external parties with attenuated access:
- client;
- contractor;
- supplier;
- lender;
- expert;
- merchant;
- insurer;
- regulator.

Each external participant gets scoped Work Graph visibility and capabilities.

## System-of-record rule

External authoritative data is never silently promoted to PaySwap authority.

Each field/object retains:
- source;
- source version/revision;
- observed time;
- transformation;
- actor/action;
- evidence.

## Product implication

"Main interface" means professionals can live in PaySwap for search, context, coordination, approvals, agent work and economic activity, while specialized incumbents remain systems of record underneath.
