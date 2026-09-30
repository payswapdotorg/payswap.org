import { describe, it } from 'vitest';

import type { ContractTestFn } from '../src/conformance/contract-test.js';
import { runApprovalContractTests } from '../src/conformance/approval-contract.js';
import { runHttpContractTests } from '../src/conformance/http-contract.js';
import { runPspConnectorContractTests } from '../src/conformance/psp-connector-contract.js';
import { runWebhookContractTests } from '../src/conformance/webhook-contract.js';
import {
  createReferenceApprovalSubject,
  createReferenceHttpEndpoint,
  createReferencePspConnectorSubject,
  createReferenceWebhookSubject,
} from '../src/conformance/reference-fixtures.js';

/** Bridges the framework-agnostic harness registration onto vitest. */
const vitestIt: ContractTestFn = (name, fn) => {
  it(name, fn);
};

describe('http contract conformance (reference fixture)', () => {
  runHttpContractTests(createReferenceHttpEndpoint(), vitestIt);
});

describe('webhook contract conformance (reference fixture)', () => {
  runWebhookContractTests(createReferenceWebhookSubject(), vitestIt);
});

describe('approval contract conformance (reference fixture)', () => {
  runApprovalContractTests(createReferenceApprovalSubject(), vitestIt);
});

describe('psp connector contract conformance (reference fixture)', () => {
  runPspConnectorContractTests(createReferencePspConnectorSubject(), vitestIt);
});
