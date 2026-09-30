# Payment-Centric Multi-Industry Simulation — 2026-09-30

Status: synthetic stress test; replaces the earlier payment benchmark that compared against vertical software tools.

## Objective

Simulate PaySwap operating for one year across 12 industries, 36 firms, 300 complex projects per firm, while firms continue using the payment methods/payment stacks they normally use.

This benchmark does NOT compare PaySwap against Procore, Salesforce, Epic, Jira, etc.

It compares PaySwap against the economic/payment methods actually used in the workflows:
- ACH / bank transfer;
- wire / RTGS;
- instant payment;
- credit/debit card;
- virtual card;
- mobile money;
- digital wallet;
- BNPL/credit;
- stablecoin/crypto;
- paper check;
- cash;
- external EFT/payment-provider flows.

## Industry payment-method assumptions

These are representative simulation inputs, not claims of exact global market share.

| Industry | Representative payment methods tested |
|---|---|
| Construction / engineering / contractor | checks, ACH, virtual cards, wire, cards, instant, mobile money, cash |
| Finance / banking / accounting | wire, ACH, instant/RTGS, cards, checks, stablecoins |
| Sales | cards, ACH, wire, instant, wallets, BNPL, checks |
| Technology / software | cards, ACH, wire, wallets, stablecoins, instant, virtual cards |
| Healthcare | ACH/EFT, checks, virtual cards, cards, wire, instant, cash |
| Transportation / delivery | ACH, checks, cards, virtual cards, instant payments, wire, mobile money, cash |
| Hospitality | cards, wallets, cash, ACH, instant, wire, BNPL, mobile money |
| Fashion / entertainment / media | cards, wallets, cash, ACH, BNPL, instant, mobile money, stablecoins |
| Legal | ACH, checks, wire, cards, instant, wallets |
| Defense / security | ACH/EFT, wire, checks, instant, cards, stablecoins |
| Manufacturing / industrial | ACH, wire, checks, virtual cards, cards, instant, stablecoins |
| Professional services / consulting | ACH, checks, wire, cards, instant, wallets, virtual cards |

External anchors:
- The Federal Reserve Bank of Cleveland's September 2026 B2B research finds ACH has become the highest-count B2B method in its U.S. sample while wires dominate B2B value; nearly 90% of businesses still used checks for at least some B2B payments in 2025. https://www.clevelandfed.org/publications/payments-research-brief/2026/prb-20260921-b2b-payments
- Construction payments commonly combine check, ACH, virtual card and wire, with retainage, lien-waiver and approval controls shaping when payment can be released. https://www.corpay.com/resources/blog/subcontractor-payment-methods
- Healthcare claim payments increasingly use ACH/EFT, while practices may still encounter checks and virtual card payments. https://www.nacha.org/news/eft-healthcare-claim-payments-continue-rise-2025
- Transportation businesses commonly fund transport accounts with ACH, checks or push-to-card; RTP can address time-sensitive fuel/toll use cases. https://www.theclearinghouse.org/payment-systems/rtp/rtp-use-cases/Use-Cases/Transportation
- Professional services commonly collect via invoices using ACH, cards, bank transfer and checks; law firms also use wires for large payments. https://www.paymetrics.io/industries/professional-services
- Retail/fashion commonly spans cash, cards, wallets, BNPL, gift/store credit and related digital methods. https://www.shopify.com/blog/retail-payment-options
- U.S. federal contractor payments use electronic funds transfer, including ACH or Fedwire, with defined exceptions. https://www.acquisition.gov/far/52.232-34

## Population

12 industries × 3 firm sizes:
- Small: 300 professionals;
- Medium: 765 professionals;
- Large: 1,200 professionals.

36 firms total.
27,180 professionals.
300 complex projects per firm.
10,800 projects.

Payment event density was varied by industry, producing 335,700 simulated payment events during the year.

Each professional is represented by an agent that can:
- inspect the current payment method;
- request/approve PaySwap orchestration;
- use direct incumbent methods;
- experience provider failures;
- reconcile payments;
- manage recurring/partial/refund/dispute flows;
- respond to incentives;
- use PaySwap as a primary payment/economic interface.

## Definition of adoption

### PaySwap Main Interface
A professional is counted as a main-interface user when the simulation indicates they are willing to initiate and manage the majority of payment/economic operations through PaySwap, while still allowing underlying banks, PSPs, cards and other rails to remain providers underneath.

### PaySwap-only payment interface
A professional is counted as PaySwap-only when they are willing to stop using direct bank/PSP/rail interfaces for most payment initiation and management and use PaySwap as the single payment/economic interface.

This does NOT mean they abandon their bank accounts or underlying payment methods. It means PaySwap becomes the control interface above them.

## Simulated one-year result

Across 27,180 professionals:
- 20,294 (~74.7%) are willing to use PaySwap as their main payment/economic interface.
- 15,629 (~57.5%) are willing to use PaySwap as their only payment/economic interface.

Across 335,700 payment events:
- 186,467 (~55.5%) are routed/orchestrated through PaySwap by year end.

These numbers are outputs of a synthetic behavioral model, not adoption forecasts or market research.

## Results by industry

| Industry | Professionals | Main interface | PaySwap-only | Payment events | PaySwap-routed events |
|---|---:|---:|---:|---:|---:|
| Construction / engineering / contractor | 2,265 | 72.5% | 53.4% | 40,500 | 19,625 |
| Finance / banking / accounting | 2,265 | 70.1% | 55.0% | 28,800 | 15,169 |
| Sales | 2,265 | 78.9% | 62.3% | 16,200 | 11,235 |
| Technology / software | 2,265 | 81.3% | 64.5% | 19,800 | 14,987 |
| Healthcare | 2,265 | 70.0% | 52.5% | 27,000 | 11,439 |
| Transportation / delivery | 2,265 | 77.8% | 57.6% | 37,800 | 22,756 |
| Hospitality | 2,265 | 78.0% | 64.0% | 31,500 | 20,362 |
| Fashion / entertainment / media | 2,265 | 79.5% | 65.8% | 25,200 | 18,044 |
| Legal | 2,265 | 71.9% | 52.4% | 21,600 | 10,051 |
| Defense / security | 2,265 | 65.6% | 47.2% | 27,000 | 10,248 |
| Manufacturing / industrial | 2,265 | 73.2% | 56.0% | 40,500 | 20,815 |
| Professional services / consulting | 2,265 | 77.2% | 59.5% | 19,800 | 11,736 |
| **Total** | **27,180** | **74.7%** | **57.5%** | **335,700** | **186,467** |

## Payment-method results

| Method | Simulated events | Events routed via PaySwap | PaySwap routing share |
|---|---:|---:|---:|
| ACH | 99,306 | 59,489 | 59.9% |
| Card | 55,344 | 38,595 | 69.7% |
| Wire | 48,159 | 27,076 | 56.2% |
| Check | 44,624 | 7,744 | 17.4% |
| Instant | 22,032 | 15,434 | 70.1% |
| Virtual card | 19,616 | 11,535 | 58.8% |
| Wallet | 14,902 | 11,709 | 78.6% |
| Cash | 14,272 | 2,038 | 14.3% |
| Stablecoin | 6,468 | 4,529 | 70.0% |
| Mobile money | 6,435 | 4,727 | 73.5% |
| BNPL/credit | 4,542 | 3,591 | 79.1% |

The simulation shows why PaySwap should not simply replace "payment methods" with one universal payment instrument. It should sit above them and decide, prove and reconcile which method is used.

## What PaySwap wins at

Strongest adoption drivers:
1. choosing among multiple rails;
2. cross-currency/cross-border routing;
3. mobile money access;
4. instant payments;
5. recurring and scheduled payments;
6. LP/credit financing;
7. incentive-aware payment selection;
8. netting and temporal liquidity;
9. payment proof and reconciliation;
10. unified merchant acceptance;
11. agent-driven payment execution;
12. provider failover.

## Where direct methods still win

### Cash
PaySwap cannot magically make cash a programmable digital rail. It needs certified cash-in/cash-out or agent capabilities and must treat evidence carefully.

### Checks
Businesses may still need to issue/receive checks. PaySwap needs an off-network payment record and reconciliation capability rather than pretending the check itself passed through PaySwap.

### Regulated/closed financial environments
Finance, healthcare and defense can impose provider, jurisdiction, data, security or contractual constraints that prevent universal routing.

### Merchant acceptance
The payer may have PaySwap capability while the merchant does not accept the chosen underlying rail. AcceptanceCapability must therefore be evaluated before payment selection.

### Recurring mandates
A one-time payment credential is insufficient for many subscriptions. PaySwap needs reusable but scoped payment mandates/tokens and renewal authority.

## Architectural issues discovered

### 1. Payment method vs rail was underspecified
Card, ACH, mobile money, stablecoin, bank transfer, virtual card and "PaySwap" are different abstraction levels.

Fix:
- PaymentMethod = what the user/merchant experiences;
- RailCapability = underlying movement mechanism;
- PaymentCredentialCapability = token/account/mandate used to authorize it;
- Strategy = chooses the combination.

### 2. Merchant acceptance needs its own executable policy
AcceptanceCapability existed but needs:
- allowed payment methods;
- currencies;
- recurring support;
- partial payment;
- refunds;
- chargeback/recourse;
- settlement destination;
- settlement timing;
- required remittance fields;
- geography;
- customer eligibility.

### 3. Payment-to-business-document linkage
Payments must carry canonical references to:
- invoice;
- order;
- contract;
- milestone;
- project/case;
- payroll batch;
- purchase order;
- fee/tax;
- incentive program.

Otherwise reconciliation remains manual.

### 4. Off-network payment capture
Check/cash/external bank actions need:
ExternalPaymentRecord
with evidence, source, status, amount, counterparty, reference and reconciliation state.

This records the payment without claiming PaySwap orchestrated it.

### 5. Payment-method translation
A customer may choose "Pay with PaySwap" while the actual path becomes:
mobile money → FX → bank settlement.

The protocol needs a first-class translation record showing:
requested method → selected capabilities → final rail effects → merchant settlement.

### 6. Multi-attempt and fallback semantics
An intent may have:
- primary attempt;
- provider failure;
- fallback method;
- re-authorization if terms change.

Fallback cannot happen silently if amount, fee, privacy, recourse or authorization changes.

### 7. Remittance preservation
Payment metadata must survive rail changes so accounting systems can still match the transfer to the correct invoice/order/project.

### 8. Refund/dispute symmetry
Refunds must use the same capability graph in reverse where possible, while recourse remains governed by the frozen original policy.

### 9. Settlement destination
Because PaySwap is non-custodial, merchant settlement must explicitly specify an external destination/capability, not an implied PaySwap balance.

### 10. Payment operations need their own command center
The universal Work Interface needs a payment/economic cockpit:
- collect;
- pay;
- request;
- approve;
- schedule;
- reconcile;
- refund;
- dispute;
- finance;
- optimize;
- inspect evidence.

## Product modification

The strongest positioning from this experiment is:

**PaySwap is the control plane above payment methods, not another payment method.**

A merchant can keep its PSP.
A business can keep its bank.
A customer can keep cards/mobile money/wallets.
PaySwap coordinates the available capabilities above them.

The universal interface should make the underlying method almost secondary:
"Pay $12,400 to Supplier X by Friday; minimize total economic cost and preserve buyer/supplier protection."

PaySwap then discovers the method, route, liquidity, credit, timing, incentives and evidence requirements.

## Next benchmark

The next implementation research should test:
- merchant-only PSP connectors;
- recurring cross-rail mandates;
- refunds/chargebacks across heterogeneous rails;
- check/cash capture;
- smart-contract payment/custody capabilities;
- invoice/order/milestone matching;
- agent-funded service access;
- multi-provider failover.
