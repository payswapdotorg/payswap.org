/**
 * The mode indicator (P4-W4-002 §3.5 + STRIPE-UX-DIRECTIVE §13): every
 * money-adjacent surface renders the test/live AND testnet/mainnet
 * distinction VISIBLY and honestly. A pure server component over the
 * @payswap/surface modeIndicator contract — tone is never color alone
 * (text labels + data-tone).
 */

import { modeIndicator, type SurfaceModeIndicator } from "@payswap/surface";

export function ModeIndicator({
  testOrLive,
  onchain,
  testnet,
  modeLocked,
}: {
  readonly testOrLive: "TEST" | "LIVE";
  readonly onchain: boolean;
  readonly testnet: boolean;
  readonly modeLocked?: boolean;
}) {
  const indicator: SurfaceModeIndicator = modeIndicator({
    testOrLive,
    onchain,
    testnet,
    modeLocked,
  });
  const tone =
    indicator.testOrLive === "LIVE"
      ? "live"
      : indicator.testOrLive === "TEST"
        ? "test"
        : "neutral";
  return (
    <p className="cc-mode-indicator" data-tone={tone} role="status">
      <span className="ps-badge" data-tone={tone}>
        {indicator.testOrLive} MODE
      </span>
      {indicator.testnetOrMainnet !== "NOT-APPLICABLE" ? (
        <span className="ps-badge" data-tone={indicator.testnetOrMainnet === "TESTNET" ? "test" : "live"}>
          {indicator.testnetOrMainnet}
        </span>
      ) : null}
      {indicator.modeLocked ? (
        <span className="ps-badge" data-tone="neutral">
          mode locked to credentials
        </span>
      ) : null}
      <span className="cc-mode-indicator__note">{indicator.note}</span>
    </p>
  );
}
