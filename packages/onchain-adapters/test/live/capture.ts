import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Machine-generated provenance capture for the LIVE suites: every real
 * observation appends one sanitized JSONL record (endpoint, provider, chain,
 * observed values — NEVER keys; public endpoints carry no credentials).
 * The capture file (evidence/live-capture.jsonl) is the raw provenance for
 * evidence/real-network-provenance.md.
 */
const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../evidence");

export function capture(record: Record<string, unknown>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(
    path.join(EVIDENCE_DIR, "live-capture.jsonl"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), ...record })}\n`,
  );
}
