# Mandatory Stripe UX/UI Reverse-Engineering Directive

Date: 2026-10-02
Source: operator directive (IM, verbatim). This directive supersedes the
less-specific UX research instructions in the previous PaySwap handoff
(You-platform remains a visual-system reference already extracted in
P3-W2-001; Stripe is the PRIMARY UX benchmark from here on).
Recorded in-repo by the TL so the P4-W1-003 research worker (and all UX
implementation workers) read it from the source of truth.

---

## Objective

Build the PaySwap user experience **as though Stripe had been hired to design
and build PaySwap itself**.

Stripe is the primary UX benchmark for:

- information architecture
- Dashboard organization
- interaction patterns
- navigation
- workflows
- search
- forms
- tables
- filters
- object detail pages
- confirmation flows
- onboarding
- settings
- developer experience
- merchant experience
- payment operations
- reporting
- risk/security presentation
- responsive behavior
- empty/loading/error/success states
- progressive disclosure.

This does **not** mean copying Stripe branding, source code, proprietary
assets, or visual identity.

The goal is to reverse-engineer the **product-design logic and interaction
quality** and then build an original PaySwap implementation around PaySwap's
universal-money-interface mission.

---

## 1. Dedicated Stripe UX Research Worker

The TL MUST assign one worker primarily to this reconnaissance during the UX
foundation stage.

That worker must survey both:

### Public Stripe surfaces

At minimum:

```
https://stripe.com
https://stripe.com/payments
https://stripe.com/connect
https://stripe.com/billing
https://stripe.com/radar
https://stripe.com/crypto
https://stripe.com/docs
https://stripe.com/pricing
```

and other relevant first-party Stripe pages discovered during the survey.

### Authenticated Stripe surfaces

The worker must survey the actual Dashboard experience, including as
available to the user's account:

```
https://dashboard.stripe.com
```

and relevant authenticated sections such as:

```
Home
Payments
Balances
Customers
Products
Billing
Reports
Connect
Apps
Settings
Developers
Webhooks
API keys
Test mode
Live mode
Payouts
Risk
Disputes
```

The worker should follow the real navigation rather than relying only on
public screenshots or documentation.

Stripe's current public materials show Dashboard patterns such as:

```
Home
Payments
Balances
Customers
Connect
More
```

along with Dashboard search, account management, reporting and operational
workflows.

---

## 2. Google Login Protocol

The worker MUST use an isolated interactive browser session.

The intended flow is:

```
Worker opens Stripe Dashboard
        ↓
Stripe login
        ↓
"Continue with Google"
        ↓
USER performs Google authentication
        ↓
USER handles MFA / consent / account selection if required
        ↓
Worker continues operating the authenticated browser session
```

The worker must never receive or record:

```
Google password
Stripe password
Google session cookie
Stripe session cookie
MFA code
security key secret
API secret
Stripe secret key
wallet credential
```

No credentials may appear in:

```
LLM context
worker notes
repository
screenshots
recordings
logs
test artifacts
tickets
PR descriptions
development-state
```

The authenticated browser session is solely a research surface.

Stripe confirms that Google-account login is supported for Dashboard web
login.

The worker must also verify that the browser remains on an official Stripe
domain before interacting with it. Stripe itself recommends checking for
`stripe.com` or an appropriate Stripe subdomain to avoid phishing domains.

---

## 3. User-assisted authentication is part of the work order

The TL should NOT ask the user for credentials.

Instead the worker should provide an interactive browser state in which the
user can personally complete:

```
Google account selection
Google authentication
MFA
Stripe verification
```

Once authenticated, the worker can perform the UX survey using the
already-authorized browser session.

The user may therefore participate without exposing credentials to the
worker.

---

## 4. Research methodology

The worker must create a structured UX inventory.

For every meaningful Stripe surface visited, record:

```
Page
Purpose
Primary user
Primary task
Navigation entry
Information hierarchy
Primary CTA
Secondary actions
Search behavior
Filtering
Sorting
Table structure
Forms
Validation
Confirmation
Error handling
Loading behavior
Empty state
Success state
Notifications
Permissions
Progressive disclosure
Keyboard behavior
Responsive behavior
Object relationships
Breadcrumbs
Back navigation
Contextual actions
```

For important workflows record:

```
Starting state
User intent
Steps
Decision points
Confirmation points
Possible errors
Recovery
Final state
```

---

## 5. Do not merely screenshot Stripe

Screenshots are evidence, not the deliverable.

The worker must explain:

> Why does Stripe structure the interface this way?

For every important pattern:

```
OBSERVED STRIPE PATTERN
        ↓
USER PROBLEM IT SOLVES
        ↓
PAYSWAP EQUIVALENT
        ↓
PAYSWAP-SPECIFIC MODIFICATION
        ↓
IMPLEMENTATION CONTRACT
```

Example:

```
Stripe:

Global search
    ↓
payments/customers/invoices/etc.

PaySwap:

Global search
    ↓
payments/accounts/transactions/capabilities/
organizations/opportunities/activity/
```

---

## 6. PaySwap Dashboard information architecture

The worker should propose an original PaySwap IA based on the Stripe
research.

The baseline candidate is:

```
Overview

Pay
Receive
Move
Convert

Payments
Accounts
Activity

Opportunities

Connections
Capabilities

Security

Reports

Developers

Settings
```

The worker may change this based on the actual Stripe research and PaySwap's
domain model.

The final IA must support BOTH:

```
consumer/simple experience
merchant/professional experience
```

without creating two unrelated products.

---

## 7. Stripe-style object model in the UI

Stripe's UX is strong partly because users can move naturally between
related objects.

PaySwap should reproduce that principle.

For example:

```
Payment
   ↓
Customer
   ↓
Payment attempt
   ↓
Execution route
   ↓
Provider / chain / protocol
   ↓
Settlement
   ↓
Finality
   ↓
Evidence
```

A user should be able to navigate through this relationship naturally.

Likewise:

```
Opportunity
   ↓
Strategy
   ↓
Organization
   ↓
Capabilities
   ↓
Execution
   ↓
Result
```

---

## 8. Universal PaySwap command/search experience

The Stripe research must specifically investigate search.

Stripe documents Dashboard search across resources such as connected
accounts, customers, invoices, payouts and products, including filters and
operators.

PaySwap should evolve this idea into:

```
SEARCH / COMMAND
```

which can find:

```
payments
customers
merchants
wallets
accounts
transactions
providers
chains
tokens
DEXs
capabilities
organizations
opportunities
security events
settlements
evidence
```

and, where authorization permits, execute commands such as:

```
"Pay Alice €100"
"Show failed USDC payments"
"Cash out my USDC"
"Connect my Stripe account"
"Show today's settlement exceptions"
"Find opportunities requiring less than $1,000 capital"
```

Search and command are separate concepts internally even if they share one
user surface.

---

## 9. Merchant UX must feel Stripe-grade

The merchant should be able to:

```
Create payment
Create checkout
Configure payment methods
Accept crypto
Configure settlement
Connect Stripe
View payments
Refund
Review disputes/issues
View balances
View activity
Configure webhooks
Manage API keys
Switch test/live mode
View reports
```

without learning blockchain terminology.

The merchant's mental model remains:

```
Amount
Currency
Customer
Payment
Settlement
Refund
Risk
```

not:

```
chain
RPC
gas
nonce
ABI
router
approval
```

Advanced blockchain details remain progressively disclosed.

---

## 10. Crypto UX must inherit Stripe's operational clarity

A crypto payment should appear as naturally as any other PaySwap payment.

Example:

```
Payment
€100.00

Status
Paid

Customer
Alice

Method
USDC

Network
Base

Conversion
USDC → EUR

Execution
Best eligible route

Settlement
Stripe

Security
Passed

Finality
Confirmed

Evidence
Available
```

An expert can expand:

```
Transaction hash
Contract
DEX
Route
Gas
Slippage
Simulation
Security findings
Execution trace
```

The ordinary user should never need to open those fields.

---

## 11. Security UX must be substantially better than a raw wallet

The Stripe survey should include how Stripe presents:

```
risk
warnings
verification
requirements
account status
payout state
failed actions
manual intervention
```

PaySwap should apply the same clarity to blockchain risk.

Example:

```
⚠ Transaction blocked

Why:
The contract would grant unlimited USDC spending
authority to an untrusted spender.

Expected action:
Swap 100 USDC → ETH

Actual authorization:
Unlimited USDC allowance

Recommendation:
Do not sign this transaction.
```

The security UI should explain the attack in human terms.

---

## 12. Stripe-inspired risk model + PaySwap's blockchain security model

Stripe's current Radar product illustrates a broader operational principle:
risk detection is integrated into the transaction lifecycle rather than
exposed as a completely separate tool.

PaySwap should follow this principle.

Security should appear directly inside:

```
onboarding
payment creation
checkout
wallet connection
transaction signing
payout
withdrawal
DEX execution
bridge execution
opportunity execution
merchant settlement
```

rather than requiring the user to visit a separate "security application."

---

## 13. Test Mode / Live Mode

The worker must study how Stripe separates test and live operations.

PaySwap should use an equally clear distinction:

```
TEST MODE
LIVE MODE
```

and where applicable:

```
TESTNET
MAINNET
```

but these must never be visually ambiguous.

No test transaction may appear to be a real financial transaction.

---

## 14. Apps / Extensions

The worker must inspect Stripe's current Apps/Extensions model.

Stripe documents both drawer applications and full-page applications, with
installed apps managed from the Dashboard.

PaySwap should apply this concept to:

```
DEX extensions
Blockchain connectors
Wallet connectors
Off-ramps
Security providers
Accounting tools
Analytics
Merchant tools
AI agents
Protocol capabilities
```

Therefore the eventual architecture becomes:

```
PaySwap Core
       ↓
Capability Marketplace
       ↓
Extensions
```

rather than hard-coding every external provider into the core product.

---

## 15. "Stripe was building PaySwap" acceptance test

The worker should repeatedly ask:

> "Would Stripe's product organization consider this workflow finished?"

Evaluate:

```
clarity
hierarchy
speed
consistency
discoverability
error recovery
operational visibility
security communication
responsive design
information density
progressive disclosure
```

Do NOT evaluate:

```
does this look aesthetically similar to Stripe?
```

Evaluate:

```
does this solve the user's job with the same degree of product clarity and
operational polish?
```

---

## 16. Required UX research artifact

The worker must produce:

```
spec/ux/stripe-research/
```

or the repository's canonical equivalent, containing:

```
README.md

public-pages.md

dashboard-pages.md

navigation.md

search.md

payments.md

customers.md

balances.md

connect.md

billing.md

reports.md

risk.md

developers.md

settings.md

apps.md

onboarding.md

responsive.md

component-patterns.md

workflow-patterns.md

pay-swap-ux-mapping.md
```

Do not invent this path if the repository already has a canonical UX
specification location; use the existing structure.

---

## 17. Research output must become implementation contracts

The worker's final output is not merely research.

It must result in:

```
PaySwap navigation contract
PaySwap design-token contract
PaySwap component contract
PaySwap workflow contract
PaySwap object-detail contract
PaySwap search/command contract
PaySwap error-state contract
PaySwap security-presentation contract
PaySwap merchant-dashboard contract
PaySwap consumer-dashboard contract
```

These become inputs to the implementation workers.

---

## 18. Screenshot and evidence policy

The worker may capture screenshots for internal research where appropriate.

However:

```
No sensitive customer data
No API keys
No account secrets
No payment credentials
No Google credentials
No MFA
No private security information
```

Sensitive fields must be redacted before repository storage.

Prefer documenting patterns rather than committing large numbers of copied
screenshots.

---

## 19. No visual implementation before UX contracts

The implementation workers must NOT independently invent competing
dashboards while the UX researcher is working.

The sequence is:

```
Stripe reconnaissance
        ↓
UX findings
        ↓
PaySwap UX contracts
        ↓
TL review
        ↓
Shared component system
        ↓
Dashboard implementation
```

Workers can parallelize non-conflicting foundation work, but the final UI
vocabulary must converge on the documented UX contract.

---

## 20. Final UX certification

Before PaySwap UX is declared complete, the worker must test:

```
desktop
tablet
mobile

keyboard navigation

search

navigation

payment creation

crypto payment

fiat payment

crypto → fiat

fiat → crypto

wallet authorization

Stripe connection

merchant checkout

refund

failed payment

UNKNOWN transaction

security block

security warning

empty state

loading state

error state

success state
```

The worker must use browser automation and actual rendered pages.

No:

```
dead buttons
fake success states
placeholder workflows
mock data presented as real data
broken navigation
console errors
```

may survive certification.

---

## 21. Relationship to the broader PaySwap architecture

This UX work must consume the universal architecture rather than define a
new one.

The final product remains:

```
                    PAYSWAP
                       │
                 USER INTENT
                       │
                INTENT COMPILER
                       │
             CAPABILITY DISCOVERY
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
        FIAT         ONCHAIN       OTHER
        RAILS         RAILS        RAILS
          │            │
       Banks/PSPs   Chains/DEXs
       Cards        Protocols
       Mobile       Wallets
       FX           Bridges
          │            │
          └─────┬──────┘
                ↓
         OPTIMAL EXECUTION
                ↓
         SECURITY ENGINE
                ↓
             AUTH
                ↓
           SETTLEMENT
                ↓
      OBSERVATION/RECONCILIATION
                ↓
              LAB
```

The UX should make this complexity almost invisible.

---

## 22. Definition of done

The Stripe UX work is complete only when:

```
✅ Public Stripe surfaces surveyed
✅ Authenticated Stripe Dashboard surveyed
✅ Google login performed through user-assisted browser auth
✅ No credentials captured by worker
✅ Dashboard navigation mapped
✅ Major objects mapped
✅ Major workflows mapped
✅ Search/command behavior mapped
✅ Merchant UX mapped
✅ Developer UX mapped
✅ Apps/extensions model mapped
✅ Risk/security UX mapped
✅ Test/live mode mapped
✅ Responsive behavior mapped
✅ Error/recovery behavior mapped
✅ PaySwap-specific UX contracts produced
✅ Shared component vocabulary produced
✅ Actual PaySwap UI implements the resulting contracts
✅ Browser verification passes
```

The final standard is:

> **A merchant using PaySwap for the first time should feel that they have
> encountered a mature Stripe-class financial operating system—not a crypto
> wallet that happens to have a dashboard.**

That standard applies equally to the consumer experience, merchant
experience, developer experience, and agent-facing execution surfaces.
