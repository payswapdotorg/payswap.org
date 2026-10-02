# Universal Money Interface & Onchain Plane — Full Implementation Handoff

Date: 2026-10-02
Source: operator handoff (verbatim, delivered with the Phase 4 directive; the
condensed in-repo forms are docs/FINAL-TL-HANDOFF-PHASE-4-2026-10-02.md and
docs/UNIVERSAL-MONEY-INTERFACE-ARCHITECTURE-2026-10-02.md). Recorded in-repo
by the TL so Phase 4 workers read the full implementation authority from the
source of truth. Section 30 (Stripe UX reference exercise) is expanded by
docs/STRIPE-UX-DIRECTIVE-2026-10-02.md (the operator's mandatory 22-section
Stripe UX/UI reverse-engineering directive).

---

# PaySwap Universal Money Interface & Onchain Plane

## Tech Lead + 3 Workers Implementation Handoff

### Architecture target: PaySwap as the universal interface for money movement, with blockchains as one settlement-rail family

---

## 1. Mission

Extend PaySwap from a heterogeneous financial-rail orchestration platform into a **Universal Money Interface**.

A user should be able to express an economic intent without needing to understand whether execution uses:

* a bank
* card
* PSP
* mobile-money rail
* fiat FX provider
* stablecoin
* blockchain
* DEX
* aggregator
* intent network
* bridge
* smart contract
* wallet
* smart account
* off-ramp
* or a composition of several of these.

The system decides how to satisfy the intent subject to:

* user policy
* merchant policy
* authorization
* geographic eligibility
* liquidity
* cost
* timing
* finality
* compliance constraints
* execution reliability
* security
* provider health
* capital constraints.

### Product ambition

PaySwap should become simultaneously:

**For consumers**

> “Tell PaySwap what you want your money to do.”

**For merchants**

> “Stripe-like payment infrastructure that can accept crypto without making merchants become blockchain experts.”

**For agents**

> “A programmable economic execution environment spanning fiat and onchain opportunities.”

**For protocols**

> “A capability/extension layer through which users and agents can safely discover and use the protocol.”

**For the Lab**

> “A common environment in which organizations can use both traditional financial rails and blockchain rails when searching for optimal execution strategies.”

Blockchain must remain **one class of settlement rail**, not the identity of the product.

---

# 2. Non-negotiable architectural principle

The existing PaySwap hierarchy remains canonical:

```text
Economic Activity
    ↓
Fulfillment Activity
    ↓
Clearing Record
    ↓
Obligation
    ↓
Netting Set
    ↓
Net Position
    ↓
Settlement Instruction
    ↓
Settlement Attempt
    ↓
Rail Operation
    ↓
Finality Record
```

Onchain transactions must fit into this hierarchy.

Do NOT create a parallel:

```text CryptoTransaction
CryptoSettlement
CryptoPayment
CryptoLedger
```

world that duplicates the financial domain.

Instead:

```text
Settlement Instruction
        ↓
Settlement Attempt
        ↓
Rail Operation
        ↓
  ┌─────┴─────────────────┐
  ↓                       ↓
FIAT RAIL             ONCHAIN RAIL
  ↓                       ↓
PSP/Bank/etc.         Chain / Protocol
                            ↓
                       Finality Record
```

This preserves the core PaySwap architecture.

---

# 3. New first-class domain: the Onchain Capability Plane

The new layer sits inside the existing Connector/Capability architecture.

```text
CapabilityDefinition
        ↓
ProviderImplementation
        ↓
ConnectedCapabilityInstance
        ↓
CapabilityObservation
```

Extend this model with:

```text
ChainDefinition
ChainImplementation
ConnectedChainInstance

WalletCapability
SignerCapability
SmartAccountCapability

ProtocolDefinition
ProtocolImplementation
ConnectedProtocolInstance

AssetDefinition
AssetObservation

OnchainExecutionCapability
ContractInteractionCapability
DEXCapability
LiquidityCapability
BridgeCapability
LendingCapability
StakingCapability
GovernanceCapability
NFTCapability
IntentExecutionCapability
```

No core domain object should be hard-coded around Ethereum, Uniswap, MetaMask, Solana, etc.

Those become implementations/extensions.

---

# 4. Chain abstraction must be family based

Do not model every blockchain as if it were EVM.

At minimum the architecture must support:

```text
EVM account/state-machine chains
Solana account/program model
UTXO chains
```

with future extension points for:

```text
Move-based chains
Cosmos/IBC
Substrate
Starknet
other execution models
```

The chain connector contract should expose common economic capabilities while preserving family-specific semantics.

Example:

```text
ChainAdapter
 ├─ identifyAccount
 ├─ observeAccount
 ├─ observeAsset
 ├─ estimateFee
 ├─ simulate
 ├─ prepareExecution
 ├─ requestSignature
 ├─ broadcast
 ├─ observeExecution
 ├─ determineFinality
 ├─ detectReorgOrRollback
 ├─ reconcile
 └─ retrieveEvidence
```

Family-specific implementations may add:

```text
EVMAdapter
SolanaAdapter
UTXOAdapter
MoveAdapter
...
```

PaySwap should use chain-agnostic account identifiers and chain identifiers wherever standards exist. CAIP-10 provides a standardized chain-qualified account identifier, designed specifically for multi-chain wallets and applications.

---

# 5. Wallets and signing are separate from PaySwap authority

The system MUST support:

```text
External wallet
        ↓
Wallet connector
        ↓
PaySwap authorization request
        ↓
User-controlled signing
        ↓
Blockchain
```

as the default.

Examples:

```text
Browser wallet
Mobile wallet
WalletConnect-style session
Hardware wallet
Smart account
Institutional signer
Multisig
Future wallet protocols
```

PaySwap must never require custody of the user's private key merely to provide the universal interface.

The existing credential-isolation rule remains absolute:

```text
PRIVATE KEY
SEED PHRASE
RAW SIGNING SECRET
WALLET PASSWORD
MFA SECRET
SESSION COOKIE
```

must never enter:

* an LLM prompt
* agent memory
* ordinary application logs
* protocol events
* screenshots
* browser artifacts
* observability payloads.

---

# 6. PaySwap Smart Account is optional, not mandatory

Later PaySwap may provide an optional smart-account experience.

The architecture should therefore support:

```text
External EOA
External Smart Account
External Multisig
PaySwap Smart Account
PaySwap Delegated Execution Account
```

without changing the intent layer.

Ethereum's current account-abstraction direction supports programmable account controls, while ERC-4337 provides a standardized UserOperation model and EIP-7702 enables EOAs to delegate to code.

However, EIP-7702 must not be treated casually: its authorization can give delegated code very broad access, and the EIP explicitly warns that permissioning should be provided through audited extension/module systems.

Therefore:

**No arbitrary PaySwap EIP-7702 delegation.**

Use:

```text
explicit capability
+
spending limits
+
asset limits
+
destination limits
+
time limits
+
chain limits
+
protocol limits
+
revocation
+
audit trail
```

---

# 7. Intent is the primary user interface

Users should not normally construct blockchain transactions.

They express:

```text
“Send €100 to Alice.”

“Swap $2,000 of USDC into ETH.”

“Pay this merchant $50.”

“Move my funds to the cheapest available chain.”

“Cash out 1,000 USDC into my bank account.”

“Put $5,000 into the approved opportunities matching my policy.”

“Buy this NFT.”

“Stake this asset.”

“Move my assets from chain A to chain B.”

“Provide liquidity only if the expected net return exceeds X and risk policy allows it.”
```

This becomes:

```text
User Intent
    ↓
Intent Compiler
    ↓
Capability Discovery
    ↓
Eligibility
    ↓
Organization Discovery
    ↓
Route Construction
    ↓
Simulation
    ↓
Security Analysis
    ↓
Authorization
    ↓
Execution
    ↓
Observation
    ↓
Reconciliation
```

---

# 8. Generic contract interaction is a first-class escape hatch

Specialized protocol packs should provide rich semantics.

But PaySwap must also support:

```text
GenericContractInteractionCapability
```

This allows a user/agent to interact with a new protocol without PaySwap having to ship a bespoke integration first.

However:

### Generic contract writes are NOT equivalent to trusted capabilities.

For unknown contracts:

```text
unknown contract
     ↓
inspect
     ↓
resolve metadata
     ↓
simulate
     ↓
security analysis
     ↓
explicit user authorization
```

Unknown or insufficiently understood financial writes should default to:

```text
BLOCK
```

or:

```text
REQUIRE_EXPERT_CONFIRMATION
```

rather than being silently executed by an agent.

The system can still provide an expert mode for advanced users.

---

# 9. DEX extensions

DEXs become protocol extensions.

Initial extension contract:

```text
DEXCapability
 ├─ quote
 ├─ route
 ├─ simulate
 ├─ prepareSwap
 ├─ requiredApprovals
 ├─ execution
 ├─ expectedOutcome
 ├─ actualOutcome
 ├─ feeModel
 ├─ liquidityObservation
 ├─ securityProfile
 └─ failure/recovery
```

First ecosystem coverage should demonstrate multiple independent execution sources rather than building a Uniswap-only router.

For example:

```text
DEX A
DEX B
Aggregator A
Intent/Solver Network A
```

The architecture must make adding:

```text
Uniswap
Curve
CoW
1inch
Aerodrome
future DEXs
future intent networks
```

a capability-pack operation, not a core architectural change.

Current intent systems such as ERC-7683 demonstrate the value of solver-oriented, protocol-agnostic execution representations, but ERC-7683 remains a draft and therefore must be treated as an optional interoperability adapter rather than a PaySwap core dependency.

---

# 10. Best-execution engine

The existing organization/strategy engine should be extended, not replaced.

A route should be evaluated using:

```text
Expected output
- protocol fees
- network fees
- bridge costs
- FX costs
- PaySwap fees
- slippage
- liquidity impact
- expected execution loss
- failure/retry cost
- time cost
```

plus:

```text
security constraints
finality requirements
provider health
regulatory eligibility
counterparty constraints
merchant/customer policy
```

The engine returns:

```text
Candidate Execution Plans
        ↓
Security Filtering
        ↓
Policy Filtering
        ↓
Optimization
        ↓
Selected Plan
```

Never optimize pure quoted price.

The objective is:

> **best eligible executable economic outcome under the requested constraints.**

---

# 11. The Lab becomes blockchain-aware

This is one of the most important integrations.

The Reality Engineering Lab must be able to treat:

```text
Fiat provider
Bank rail
PSP
DEX
Bridge
Chain
Wallet
Smart account
Intent network
Off-ramp
```

as possible components of an Organization.

For example:

```text
Organization A

Customer wallet
    ↓
Base
    ↓
DEX
    ↓
USDC
    ↓
Stripe crypto settlement
```

versus:

```text
Organization B

Customer wallet
    ↓
Ethereum
    ↓
DEX
    ↓
Bridge
    ↓
USDC
    ↓
Off-ramp
    ↓
Bank
```

versus:

```text
Organization C

Customer fiat
    ↓
PSP
    ↓
FX provider
    ↓
local bank rail
```

The Lab should compare all of them.

Therefore an Organization is no longer:

```text
agents + traditional connectors
```

but:

```text
agents
+
fiat capabilities
+
onchain capabilities
+
protocol capabilities
+
execution policies
+
security policies
```

---

# 12. Onchain opportunities become Financial Opportunities

The user's money-making agents must be able to discover onchain opportunities.

Add an onchain opportunity family covering things such as:

```text
DEX liquidity
market making
arbitrage
lending
staking
protocol incentives
treasury yield
cross-venue price differences
solver/execution opportunities
liquidity provisioning
other permitted strategies
```

Each opportunity must contain:

```text
Expected return
Required capital
Duration
Liquidity
Exit path
Network fees
Gas sensitivity
Slippage
Smart-contract exposure
Oracle exposure
Bridge exposure
Counterparty exposure
Protocol upgrade authority
Historical/live evidence
Failure scenarios
Maximum loss
Policy eligibility
```

The agent may discover opportunities.

The agent does NOT get authority to bypass execution policy.

The existing distinction remains:

```text
Strategy
    ≠
Organization
    ≠
Authorization
```

---

# 13. Agent security becomes part of blockchain security

The security immune system must be expanded with an onchain threat domain.

Examples include:

```text
malicious contract
fake token
token impersonation
honeypot behavior
hidden transfer restrictions
malicious approval
unlimited allowance
malicious permit
permit replay
signature-domain confusion
phishing contract
proxy upgrade
compromised admin
malicious delegatecall
unexpected contract calls
oracle manipulation
flash-loan manipulation
sandwich/MEV exposure
bridge compromise
relayer compromise
reorg/finality problems
stale state
unexpected fee/tax behavior
rebasing surprises
liquidity removal
malicious governance
governance takeover
destination poisoning
chain confusion
address spoofing
```

Ethereum's current security guidance explicitly highlights access-control failures, testing, monitoring, emergency response and governance risks; its verification guidance also stresses that source-code verification is distinct from proving that the contract actually behaves correctly.

---

# 14. Adversarial transaction agent

Add a specialized security agent:

```text
AdversarialTransactionAgent
```

It gets:

```text
human intent
candidate execution
transaction calldata
ABI
contract source/bytecode metadata
simulation result
balance delta
approval delta
allowance changes
external calls
chain state
protocol state
threat intelligence
historical observations
```

It attempts to answer:

> “What could go wrong that a normal user would not notice?”

Examples:

```text
User thinks:
Swap 100 USDC → ETH

Actual:
Approve unlimited USDC
to a different contract
which can drain future balances.
```

or:

```text
User thinks:
Deposit into lending protocol

Actual:
Contract implementation was upgraded
to an unverified implementation
controlled by a newly changed admin.
```

or:

```text
User thinks:
Bridge $10,000

Actual:
Destination chain/address differs
from the expected intent.
```

The agent produces:

```text
ThreatSignal
Evidence
Explanation
Confidence
Recommended action
```

But the agent is **not the final authority**.

The deterministic Security Gate decides:

```text
ALLOW
ALLOW_WITH_CONSTRAINTS
REQUIRE_USER_CONFIRMATION
REQUIRE_EXPERT_CONFIRMATION
BLOCK
```

A model must never be able to change:

```text
BLOCK → ALLOW
```

by itself.

---

# 15. Mandatory simulation before signing

Where the chain supports simulation, PaySwap must simulate before requesting authorization.

Ethereum explicitly recommends transaction simulation to check whether transactions would succeed and preview outcomes.

The resulting UX should summarize:

```text
YOU ARE AUTHORISING

Spend:
100 USDC

Receive:
0.0342 ETH

Network:
Base

Network fee:
$0.08

PaySwap fee:
$0.00

Contract:
Verified / status

Permissions created:
None

Existing permissions changed:
0

Expected balance changes:
USDC -100
ETH +0.0342

Execution expires:
2 minutes

Risk findings:
No blocking findings
```

For complex transactions:

```text
Before
After
```

balance/state diffs must be visible.

---

# 16. Signing must use structured, understandable authorization

For EVM structured signing, use standards such as EIP-712 rather than inventing opaque signing payloads. EIP-712 explicitly exists to make signed structured data understandable and domain-separated.

Smart-contract accounts must support appropriate contract-signature verification such as ERC-1271 where applicable.

The UX must distinguish:

```text
Transaction authorization
Token approval
Permit
Recurring mandate
Smart-account delegation
Generic message signing
```

Never show a generic:

> “Sign this message.”

when PaySwap can explain the actual economic consequence.

---

# 17. Pre-broadcast security recheck

There must be another security check immediately before broadcast.

Reason:

```text
Quote at T0
Security check at T0
User reviews at T1
Broadcast at T2
```

Onchain state may change between T0 and T2.

Therefore:

```text
Prepared transaction
      ↓
fresh state read
      ↓
fresh simulation where possible
      ↓
fresh security check
      ↓
broadcast
```

If the outcome materially differs:

```text
DO NOT BROADCAST
```

Require a new authorization.

---

# 18. Continuous post-execution monitoring

After broadcast:

```text
Pending
    ↓
Observed
    ↓
Confirmed
    ↓
Final
```

or:

```text
Pending
    ↓
Unknown / Reorg / Failed
    ↓
Recovery / Reconciliation
```

The existing `UNKNOWN` semantics must be used.

Do not create:

```text
SUCCESS
```

merely because a transaction hash exists.

The system must observe:

* receipt
* chain state
* emitted events
* balance deltas
* finality
* reorg risk
* protocol state
* destination state.

---

# 19. Merchant product: “Stripe on top of blockchains”

Build a first-class PaySwap merchant product.

Conceptually:

```text
PaySwap Payments
```

should feel like:

```text
Stripe
```

from the merchant's perspective.

Merchant capabilities:

```text
Payment Intents
Checkout Sessions
Payment Links
Embedded Checkout
Webhooks
Payment Status
Refunds
Customer records
Settlement
Reporting
Risk controls
Idempotency
Test Mode
Live Mode
API Keys
SDKs
```

The merchant should not need:

```text
RPC
wallet infrastructure
chain IDs
gas
DEX routing
bridge selection
token contracts
```

unless explicitly operating in advanced mode.

---

# 20. Merchant crypto checkout

A merchant should be able to configure:

```text
Accept:
Fiat
Crypto
Both
```

Example:

```text
Merchant charges:
€100

Customer sees:

Pay €100

Crypto options:
USDC
USDT
ETH
...

PaySwap selects:
network
asset
route
gas strategy
execution venue
```

The merchant continues to reason in:

```text
€100
```

not:

```text
0.034928 ETH on chain X
```

---

# 21. Stripe settlement destination

Implement a dedicated capability:

```text
StripeMerchantSettlementCapability
```

with explicit modes.

### Mode A — Native Stripe crypto settlement

When the merchant's Stripe account and transaction are eligible:

```text
Customer crypto
      ↓
Stripe-supported crypto payment capability
      ↓
Stripe
      ↓
merchant Stripe balance in fiat
```

Stripe currently documents stablecoin payments as automatically converting and settling into the Stripe balance in fiat, and Stripe's current payment-method documentation lists Connect support.

PaySwap should therefore integrate with Stripe's actual supported crypto capability rather than inventing a synthetic Stripe balance-credit mechanism.

### Mode B — External PaySwap route

If the native Stripe path is unavailable:

```text
Customer crypto
      ↓
PaySwap routing
      ↓
conversion/off-ramp
      ↓
merchant's supported settlement destination
```

The UI must explicitly say:

```text
Stripe balance settlement unavailable for this route.
```

Never fake equivalent semantics.

---

# 22. Merchant Stripe connection

Merchant configuration should look conceptually like:

```text
Connect Stripe
        ↓
Authorize PaySwap
        ↓
Select capabilities
        ↓
Payment acceptance
Settlement destination
Refund permissions
Reporting
```

Connection does not automatically grant:

```text
arbitrary payout authority
```

and must preserve the existing PaySwap authorization model.

A merchant may choose:

```text
Accept crypto
Settle fiat
Keep crypto
Split settlement
Use Stripe
Use PaySwap
Use bank
```

subject to actual provider capabilities and eligibility.

---

# 23. Crypto payment lifecycle

Canonical lifecycle:

```text
Merchant creates PaymentIntent
        ↓
PaySwap calculates accepted options
        ↓
Customer chooses crypto
        ↓
PaySwap obtains route/quote
        ↓
Security analysis
        ↓
Customer signs
        ↓
Onchain settlement
        ↓
Finality verification
        ↓
PaymentAttempt reconciled
        ↓
Merchant webhook
        ↓
Settlement according to merchant policy
```

Payment status must distinguish:

```text
created
requires_customer_action
submitted
pending
confirmed
final
failed
expired
unknown
reorged
refunded
```

---

# 24. Crypto refunds are different from card disputes

Do not model blockchain payments as if they have card chargeback semantics.

A pure onchain payment is generally irreversible.

Current Stripe documentation for stablecoin payments lists refunds/partial refunds but no dispute support.

Therefore PaySwap must provide:

```text
Refund policy
Refund destination
Refund authorization
Refund execution
Refund evidence
```

rather than promising chargebacks where the underlying rail cannot provide them.

---

# 25. Main-interface architecture

The product should ultimately expose:

```text
                     PAYSWAP
                        │
                USER / MERCHANT
                        │
                 MONEY INTENT
                        │
                INTENT COMPILER
                        │
              CAPABILITY DISCOVERY
                        │
             ORGANIZATION SEARCH
                        │
          ┌─────────────┼─────────────┐
          ↓             ↓             ↓
       FIAT          ONCHAIN        OTHER
       RAILS          RAILS         RAILS
          │             │
      Bank/PSP      Chains/DEXs
      Mobile       Protocols
      Card         Bridges
      FX           Wallets
          │             │
          └──────┬──────┘
                 ↓
          EXECUTION ENGINE
                 ↓
           SECURITY GATE
                 ↓
         USER/AUTOMATED AUTH
                 ↓
            SETTLEMENT
                 ↓
       OBSERVATION + EVIDENCE
                 ↓
           RECONCILIATION
```

This is the product architecture.

It is deliberately **not a wallet architecture with fiat added afterwards**.

---

# 26. Extension architecture

Every new chain, protocol, wallet, simulator, security provider or off-ramp should be installable as a capability extension.

Example:

```text
/extensions
    /chains
        /ethereum
        /base
        /solana
        /bitcoin
    /dexs
        /uniswap
        /cow
        /...
    /bridges
    /lending
    /wallets
    /offramps
    /security
```

Exact repository locations must follow the existing repo conventions; do not create duplicate architectural roots.

The extension contract should provide:

```text
metadata
capabilities
authorization requirements
execution
simulation
security profile
observability
reconciliation
health
version
provenance
```

The provider catalogue remains descriptive, never authorization.

---

# 27. Future-proofing rules

The core must never assume:

```text
Ethereum
EVM
ERC-20
Uniswap
MetaMask
USDC
stablecoins
one RPC provider
one indexer
one simulator
one wallet
one bridge
```

The core assumes only:

```text
economic intent
asset
account
capability
authorization
execution
observation
finality
evidence
policy
```

Everything else is an implementation.

This is essential for avoiding architectural lock-in.

---

# 28. Cost and infrastructure design

Blockchain infrastructure must follow the same free/low-cost bias already established.

No core capability may hard-depend upon one paid RPC/indexer/simulation vendor.

Create:

```text
RPCProvider
IndexerProvider
SimulationProvider
PriceProvider
SecurityIntelligenceProvider
```

with multiple implementations.

Each observation records:

```text
source
provider
version
timestamp
confidence
latency
cost
```

Provider degradation must feed the same capability-health model already used elsewhere in PaySwap.

---

# 29. UX architecture

The UX must be implemented concurrently with the underlying functionality.

Default UX:

```text
human language
+
simple money outcomes
+
progressive disclosure
```

Advanced users can expand:

```text
chain
DEX
contract
gas
route
slippage
ABI
approval
simulation
security findings
```

Normal users should not need to understand these.

---

# 30. Stripe UX reference exercise

Worker 3 must perform a deliberate UX reverse-engineering exercise against:

```text
https://stripe.com
```

and the Stripe Dashboard.

The objective is not to copy branding or proprietary implementation.

Extract the observable interaction model:

```text
navigation hierarchy
payment creation flow
payment status
customers
products
payment methods
connected accounts
API keys
webhooks
reports
risk
settlement
settings
empty states
error states
confirmation patterns
notifications
progressive disclosure
```

The worker should document:

```text
Observed pattern
Why it works
PaySwap equivalent
Differences required by PaySwap
```

For the private Dashboard portion, the user may manually log into the Stripe account when needed.

Critical security rule:

```text
USER ENTERS CREDENTIALS
        ↓
BROWSER / PROVIDER
        ↓
WORKER OBSERVES ONLY UI
```

The worker must never request or record:

```text
password
MFA
session cookie
API secret
private key
wallet seed
```

Screenshots and research artifacts must be redacted.

---

# 31. UX should ultimately feel like an economic operating system

Primary navigation should eventually resemble:

```text
Overview
Pay
Receive
Move
Convert
Accounts
Payments
Opportunities
Activity
Connections
Security
Developers
```

The user can say:

```text
Pay €100 to X
```

rather than:

```text
Create transaction on chain X using protocol Y.
```

The system explains the route only when useful.

---

# 32. Extension/browser future

The core must expose a surface-neutral interface so the same engine can later power:

```text
PaySwap Web
PaySwap Browser Extension
PaySwap Mobile
PaySwap API
PaySwap SDK
PaySwap Agent
Merchant checkout
Embedded widgets
```

The extension is therefore a **surface**, not the blockchain architecture.

This allows PaySwap to become the primary interaction layer without requiring users to abandon their existing wallets.

---

# 33. Work-order protocol

The TL must enforce:

```text
Repository is the only source of truth.

No work item is complete because an agent says so.

No completion claim without:
source evidence
tests
callers
integration
browser proof where applicable
deployment proof where applicable
```

Every worker starts by reading:

```text
development-state
architecture
active handoff
dependency graph
existing connector contracts
security invariants
current Phase 3 state
```

The TL must verify the actual current canonical branch/commit before dispatching.

Do not create a second parallel architecture.

---

# 34. Work Graph

## W0 — TL architecture reconciliation

### P4-W0-001 — Repository / Architecture Reconciliation

TL only.

Verify:

```text
HEAD
branch
architecture SHA
development-state
Phase 2 completion
Phase 3 completion/current status
existing Connector model
existing Payment model
existing Lab model
existing FinancialOpportunity model
existing SecurityAdvisory/ThreatSignature model
deployment state
UX deployment state
```

Freeze this handoff only after reconciliation.

---

# Wave 1 — Foundation

Three workers may work concurrently.

### P4-W1-001 — Universal Onchain Domain + Capability Kernel

Owner: Worker 1

Implement:

```text
ChainDefinition
ChainImplementation
ConnectedChainInstance
WalletCapability
SignerCapability
ProtocolDefinition
ProtocolImplementation
ConnectedProtocolInstance
AssetDefinition
OnchainCapabilityObservation
```

Extend existing capability and settlement models.

Implement:

```text
chain-agnostic identifiers
chain-family abstraction
execution-family abstraction
generic contract interaction capability
```

Do NOT yet build individual DEX integrations beyond interfaces/tests.

---

### P4-W1-002 — Wallet / Signer / Authorization + Blockchain Security Foundation

Owner: Worker 2

Implement:

```text
WalletConnector
SignerConnector
AuthorizationRequest
SigningRequest
SimulationResult
SecurityAssessment
SecurityDecision
ThreatSignal
```

Implement:

```text
EIP-712 support where applicable
ERC-1271 verification where applicable
external wallet flow
smart-account abstraction
scoped delegation
approval inspection
simulation boundary
```

Hard rules:

```text
no raw keys
no seed phrases
no agent signing bypass
no hidden transaction
no direct RPC write bypass
```

---

### P4-W1-003 — Merchant Crypto Product Contract + Stripe UX Research

Owner: Worker 3

Define and document:

```text
CryptoPaymentCapability
MerchantCryptoAcceptancePolicy
StripeMerchantSettlementCapability
CryptoPaymentIntent mapping
Checkout contract
Webhook contract
Refund contract
Settlement destination contract
```

Perform:

```text
Stripe.com UX research
Stripe Dashboard research
merchant payment-flow mapping
crypto checkout UX
```

Produce implementation-ready UX contracts for the rest of the workers.

---

# Wave 2 — Real execution

### P4-W2-001 — Multi-Chain Adapter SDK

Owner: Worker 1

Implement first-family adapters:

```text
EVM
Solana
UTXO
```

Each must support the common execution lifecycle.

At minimum prove:

```text
observe
prepare
simulate
authorize
broadcast
observe
finalize
reconcile
```

with real testnet/live-compatible evidence as appropriate.

The implementation must make adding another chain primarily an adapter/extension task.

---

### P4-W2-002 — DEX / Protocol Extensions + Best Execution

Owner: Worker 2

Implement:

```text
DEX capability
aggregator capability
intent/smart-order capability
generic protocol capability
```

Demonstrate routing across multiple independent sources.

Implement the optimizer around:

```text
net executable outcome
cost
slippage
liquidity
gas
finality
health
security
```

The route optimizer must plug into the existing Organization/Lab execution model.

---

### P4-W2-003 — Merchant Checkout + Stripe Settlement

Owner: Worker 3

Implement:

```text
merchant onboarding
crypto acceptance
checkout
wallet payment
payment lifecycle
webhooks
refunds
settlement configuration
Stripe connection
```

Implement two explicit Stripe paths:

```text
NATIVE_STRIPE_CRYPTO
PAYSWAP_EXTERNAL_SETTLEMENT
```

Never imply Stripe balance settlement when the underlying Stripe capability is unavailable.

---

# Wave 3 — Intelligence + Security + Lab

### P4-W3-001 — Lab / Organization Integration

Owner: Worker 1

Extend Reality Engineering Lab so blockchain capabilities participate in:

```text
strategy generation
organization generation
simulation
replay
fault injection
route optimization
canary/shadow execution
promotion
```

A candidate Organization must be allowed to contain mixed:

```text
fiat + crypto + onchain + fiat
```

execution legs.

---

### P4-W3-002 — Onchain Financial Opportunity Engine

Owner: Worker 2

Extend:

```text
FinancialOpportunity
```

to discover onchain opportunities.

Implement:

```text
opportunity observation
profitability estimation
capital requirements
exit analysis
risk analysis
simulation
policy matching
```

Agents may discover and recommend opportunities.

Execution remains subject to authorization and policy.

---

### P4-W3-003 — Blockchain Threat Intelligence + Adversarial Agent

Owner: Worker 3

Implement:

```text
contract inspection
transaction security analysis
allowance analysis
simulation diff analysis
upgrade/admin detection
token anomaly detection
oracle analysis
bridge analysis
MEV/slippage analysis
signature/domain analysis
```

Build:

```text
AdversarialTransactionAgent
```

but ensure its output is only a signal.

Final deterministic gate:

```text
ALLOW
ALLOW_WITH_CONSTRAINTS
REQUIRE_CONFIRMATION
BLOCK
```

must remain outside LLM authority.

---

# Wave 4 — Universal money movement

### P4-W4-001 — Mixed Fiat/Onchain Route Compiler

Owner: Worker 1

Implement multi-leg intent execution such as:

```text
Crypto → DEX → Stablecoin → Off-ramp → Bank
```

```text
Fiat → PSP → Stablecoin → Blockchain → Recipient
```

```text
Crypto Chain A → DEX → Bridge → Chain B → Merchant
```

```text
Fiat → FX → Local Rail
```

The route compiler must treat them as one Money Movement Intent.

---

### P4-W4-002 — Universal User / Merchant UX

Owner: Worker 2

Implement the final UX around:

```text
Pay
Receive
Move
Convert
Checkout
Connections
Accounts
Activity
Opportunities
Security
```

Use the Stripe research from Worker 3.

Add:

```text
simple mode
advanced mode
security explanation
route explanation
before/after balances
confirmation
recovery
UNKNOWN handling
```

Also expose a stable surface API suitable for a future browser extension and mobile application.

---

### P4-W4-003 — Production Certification + Release

Owner: Worker 3

Certify:

```text
web UI
merchant checkout
external wallets
chain execution
DEX routing
security gates
Lab integration
opportunity discovery
fiat ↔ crypto flows
Stripe integration
observability
reconciliation
deployment
rollback
```

Run the full existing PaySwap battery plus new onchain certification suites.

No simulated “success” may remain in production journeys.

---

# 35. Required end-to-end acceptance journeys

The final release must prove at minimum:

### Journey A — Simple wallet payment

```text
User:
“Pay $20.”

PaySwap:
selects eligible route
→ security analysis
→ wallet authorization
→ blockchain
→ finality
→ receipt
```

---

### Journey B — DEX optimization

```text
User:
“Swap $1,000 USDC into ETH.”

PaySwap:
collects multiple routes
→ computes total economic outcome
→ security screens
→ simulates
→ asks for authorization
→ executes
→ reconciles
```

---

### Journey C — Crypto-to-fiat

```text
User:
“Cash out 1,000 USDC.”

PaySwap:
finds eligible conversion/off-ramp
→ executes
→ fiat settlement
→ reconciliation.
```

---

### Journey D — Merchant crypto payment

```text
Merchant:
charge €100

Customer:
pays crypto

PaySwap:
accept
→ route
→ secure
→ settle
→ merchant receives configured settlement.
```

Where eligible:

```text
customer crypto
→ Stripe-supported crypto payment
→ Stripe
→ merchant fiat Stripe balance
```

---

### Journey E — Mixed execution

```text
Merchant asks for €100.

Customer holds USDC on chain A.

PaySwap determines:

USDC
→ DEX/intent route
→ appropriate conversion
→ fiat settlement
→ merchant.

User sees:
€100 paid.
```

---

### Journey F — Security attack

Create intentionally malicious/adversarial test contracts/transactions.

Example:

```text
fake token
malicious approval
unexpected spender
changed proxy implementation
unexpected balance delta
```

Expected:

```text
security engine detects
→ human-readable explanation
→ transaction blocked
```

---

### Journey G — Agent opportunity

Agent discovers:

```text
onchain opportunity
```

Then:

```text
opportunity
→ evidence
→ simulation
→ risk
→ policy
→ recommendation/authorization
```

The agent cannot bypass policy.

---

### Journey H — State changes before broadcast

```text
quote
→ approval
→ state changes
→ pre-broadcast recheck
```

Expected:

```text
execution invalidated
→ new simulation
→ new authorization
```

---

### Journey I — Reorg / UNKNOWN

Force an execution into a non-final/ambiguous state.

Expected:

```text
UNKNOWN
```

rather than fake success.

---

# 36. Security certification gates

The release is NOT complete unless:

```text
[ ] no raw wallet secrets enter model context
[ ] no raw wallet secrets enter ordinary logs
[ ] no signer bypass exists
[ ] no direct RPC write bypass exists
[ ] every supported write is represented by an AuthorizationRequest
[ ] simulation is mandatory when capability supports it
[ ] pre-broadcast security recheck exists
[ ] balance/state deltas are captured
[ ] allowance changes are visible
[ ] destination changes are visible
[ ] proxy/admin changes are checked
[ ] unknown contracts are not silently trusted
[ ] agent cannot downgrade BLOCK
[ ] reorg/finality is represented
[ ] UNKNOWN is supported
[ ] post-execution reconciliation exists
[ ] incident/threat signals enter SecurityAdvisory/ThreatSignature system
```

---

# 37. Safety objective

Do NOT claim:

> “PaySwap is guaranteed safer than direct blockchain interaction.”

The engineering acceptance target is:

> **PaySwap provides a systematically stronger safety workflow than a raw transaction UI by inserting deterministic simulation, policy, route validation, security analysis, human-readable authorization, postcondition verification and continuous monitoring before and after execution.**

The evidence must come from certification tests and real incidents/observations, not marketing language.

---

# 38. What agents may and may not do

### Agents MAY

```text
discover
research
quote
compare
simulate
find routes
identify threats
identify opportunities
propose organizations
prepare transactions
prepare user-readable explanations
monitor
reconcile
learn from execution
```

### Agents MAY NOT independently override

```text
authorization
risk policy
spending limits
security blocks
merchant policy
customer policy
regulatory eligibility
credential isolation
```

---

# 39. What remains outside the core

The following remain replaceable:

```text
LLM/model
wallet provider
RPC provider
indexer
simulator
DEX
aggregator
bridge
security vendor
price feed
off-ramp
PSP
Stripe
bank
mobile-money provider
chain
protocol
browser extension
```

PaySwap owns the:

```text
intent
capability
policy
organization
execution
authorization
security
observation
reconciliation
evidence
```

model.

This is what makes the architecture durable.

---

# 40. Final architectural picture

```text
                         PAYSWAP
                UNIVERSAL MONEY INTERFACE
                              │
                              ↓
                         USER INTENT
                              │
                              ↓
                      INTENT COMPILER
                              │
                              ↓
                    CAPABILITY DISCOVERY
                              │
                              ↓
                  ORGANIZATION / LAB SEARCH
                              │
                ┌─────────────┼─────────────┐
                ↓             ↓             ↓
             FIAT          ONCHAIN       OTHER
             RAILS          RAILS        RAILS
                │             │             │
             Banks          Chains          APIs
             PSPs            Wallets         etc.
             Cards           DEXs
             FX              Bridges
             Mobile          DeFi
                             Contracts
                │             │
                └──────┬──────┘
                       ↓
                EXECUTION PLAN
                       ↓
                 SIMULATION
                       ↓
                SECURITY ENGINE
                       ↓
             ADVERSARIAL AGENT
                       ↓
                DETERMINISTIC
                 SECURITY GATE
                       ↓
              USER/AUTOMATED AUTH
                       ↓
                   EXECUTION
                       ↓
            OBSERVATION / FINALITY
                       ↓
             RECONCILIATION/EVIDENCE
                       ↓
                   LEARNING
                       ↓
                     LAB
```

The resulting product is not:

```text
a crypto app
```

and not:

```text
a wallet with fiat features
```

It is:

> **a universal economic execution interface in which blockchain networks are first-class settlement rails and programmable financial environments, alongside every other rail PaySwap can connect to.**

Stripe becomes one of the strongest merchant-facing patterns and, where supported, one of the actual settlement/execution providers. Onchain protocols become capabilities. The Lab becomes capable of optimizing across them. Agents become capable of discovering both conventional and onchain opportunities. Security becomes capable of reasoning about smart-contract and blockchain-specific attacks.

That is the architecture that lets PaySwap grow toward being the **main interface for money movement rather than the interface for one particular type of money**.
