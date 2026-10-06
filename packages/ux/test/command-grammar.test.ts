/**
 * UX-002 — command grammar tests (contract 06 v1.1 incl. R2, §2/§3/§4/§5/§6):
 *
 * - the six verbs parse (pay · request · invoice · link · convert · withdraw);
 * - the 15-representative-phrasing battery from the contract §6 acceptance;
 * - missing parameters PRE-FILL the workflow form model — never a parse error;
 * - the amount is a VERBATIM string (never float-parsed: exact-money law);
 * - ambiguity resolves through disambiguation chips (which Alice? / add
 *   contact), never a dead end and never a guess;
 * - a no-result query turns into the "Create payment for '<q>'?" intent;
 * - the keyboard model data is present ("/" focus, Esc restore, arrows, Tab,
 *   Enter; the five create chords; withdraw routes to the Balances flow).
 */

import { describe, expect, it } from 'vitest';

import {
  chordToCommandVerb,
  COMMAND_CHORDS,
  COMMAND_VERBS,
  COMMAND_VERB_ROUTING,
  commandVerbChord,
  isCommandVerb,
  noResultIntentTurn,
  parseCommand,
  resolveCounterparty,
  SEARCH_COMMAND_KEYBOARD_MODEL,
  workflowFormPrefillFromIntent,
  workflowFormPrefillFromText,
  type ContactDirectoryEntry,
} from '../src/command-center.js';

// ---------------------------------------------------------------------------
// The six verbs
// ---------------------------------------------------------------------------

describe('the six grammar verbs (TL-review R2: one set everywhere)', () => {
  it('is exactly pay · request · invoice · link · convert · withdraw', () => {
    expect(COMMAND_VERBS).toEqual(['pay', 'request', 'invoice', 'link', 'convert', 'withdraw']);
  });

  it('isCommandVerb narrows (case-sensitively; parsing lowercases first)', () => {
    expect(isCommandVerb('pay')).toBe(true);
    expect(isCommandVerb('Pay')).toBe(false);
    expect(isCommandVerb('payout')).toBe(false);
    expect(isCommandVerb('send')).toBe(false);
  });

  it('withdraw routes to the Balances withdraw flow; the other five are modal command handlers', () => {
    expect(COMMAND_VERB_ROUTING.withdraw.kind).toBe('balances-withdraw-flow');
    for (const verb of COMMAND_VERBS.filter((candidate) => candidate !== 'withdraw')) {
      expect(COMMAND_VERB_ROUTING[verb].kind).toBe('modal');
    }
  });
});

// ---------------------------------------------------------------------------
// The 15-representative-phrasing battery (contract 06 §6 acceptance)
// ---------------------------------------------------------------------------

describe('the 15 representative phrasings parse to typed partial intents', () => {
  const cases: ReadonlyArray<{
    readonly text: string;
    readonly expect: {
      readonly verb: string;
      readonly counterparty?: string;
      readonly amount?: string;
      readonly asset?: string;
      readonly modifier?: { readonly key: string; readonly value: string };
    };
  }> = [
    { text: 'pay alice 100 usdc', expect: { verb: 'pay', counterparty: 'alice', amount: '100', asset: 'usdc' } },
    { text: 'pay 25 usdc', expect: { verb: 'pay', amount: '25', asset: 'usdc' } },
    { text: 'pay', expect: { verb: 'pay' } },
    { text: 'request bob 50 eur', expect: { verb: 'request', counterparty: 'bob', amount: '50', asset: 'eur' } },
    { text: 'request 500', expect: { verb: 'request', amount: '500' } },
    { text: 'invoice acme 1200 usd', expect: { verb: 'invoice', counterparty: 'acme', amount: '1200', asset: 'usd' } },
    { text: 'invoice', expect: { verb: 'invoice' } },
    { text: 'link 30 usd', expect: { verb: 'link', amount: '30', asset: 'usd' } },
    { text: 'link', expect: { verb: 'link' } },
    { text: 'convert 2 eth to usdc', expect: { verb: 'convert', amount: '2', asset: 'eth', modifier: { key: 'to', value: 'usdc' } } },
    { text: 'convert 500 usd to eur', expect: { verb: 'convert', amount: '500', asset: 'usd', modifier: { key: 'to', value: 'eur' } } },
    { text: 'withdraw 300 usdc', expect: { verb: 'withdraw', amount: '300', asset: 'usdc' } },
    { text: 'withdraw', expect: { verb: 'withdraw' } },
    { text: 'request carol', expect: { verb: 'request', counterparty: 'carol' } },
    { text: 'pay dave 75 gbp rail:ethereum', expect: { verb: 'pay', counterparty: 'dave', amount: '75', asset: 'gbp', modifier: { key: 'rail', value: 'ethereum' } } },
  ];

  it('all 15 phrasings parse as commands with the expected fields (never an error)', () => {
    expect(cases).toHaveLength(15);
    for (const { text, expect: expected } of cases) {
      const parse = parseCommand(text);
      if (parse.kind !== 'COMMAND') {
        throw new Error(`expected a command for: ${text}`);
      }
      expect(parse.intent.verb).toBe(expected.verb);
      expect(parse.intent.counterparty).toBe(expected.counterparty);
      expect(parse.intent.amount).toBe(expected.amount);
      expect(parse.intent.asset).toBe(expected.asset);
      if (expected.modifier === undefined) {
        expect(parse.intent.modifiers.find((modifier) => modifier.key === expected.modifier?.key)).toBeUndefined();
      } else {
        expect(parse.intent.modifiers).toContainEqual(expected.modifier);
      }
      expect(parse.intent.unrecognized).toEqual([]);
    }
  });

  it('the verb match is case-insensitive; values keep their typed case', () => {
    const parse = parseCommand('Pay Alice 100 USDC');
    expect(parse.kind).toBe('COMMAND');
    if (parse.kind === 'COMMAND') {
      expect(parse.intent.verb).toBe('pay');
      expect(parse.intent.counterparty).toBe('Alice');
      expect(parse.intent.asset).toBe('usdc');
    }
  });

  it('deterministic: the same text always parses deep-equal', () => {
    for (const { text } of cases) {
      expect(parseCommand(text)).toEqual(parseCommand(text));
    }
  });

  it('non-verb-leading text is NOT_A_COMMAND (it belongs to the search lane)', () => {
    for (const text of ['', '   ', 'find the failed payment from Tuesday', 'alice 100 usdc', 'payouts overview']) {
      expect(parseCommand(text).kind).toBe('NOT_A_COMMAND');
    }
  });
});

// ---------------------------------------------------------------------------
// Missing parameters PRE-FILL (contract 06 §4 — never a parse error)
// ---------------------------------------------------------------------------

describe('missing parameters pre-fill the workflow form model', () => {
  it('a bare verb opens the form fully pre-asked: three missing fields, never an error', () => {
    const prefill = workflowFormPrefillFromText('pay');
    expect(prefill).toBeDefined();
    expect(prefill?.verb).toBe('pay');
    expect(prefill?.counterpartyText).toBe('');
    expect(prefill?.amountText).toBe('');
    expect(prefill?.assetText).toBe('');
    expect(prefill?.missingFields).toEqual(['counterparty', 'amount', 'asset']);
  });

  it('a partial command pre-fills what parsed and asks for exactly the rest', () => {
    const prefill = workflowFormPrefillFromText('request carol');
    expect(prefill?.verb).toBe('request');
    expect(prefill?.counterpartyText).toBe('carol');
    expect(prefill?.missingFields).toEqual(['amount', 'asset']);

    const amountOnly = workflowFormPrefillFromText('withdraw 300 usdc');
    expect(amountOnly?.missingFields).toEqual(['counterparty']);
    expect(amountOnly?.amountText).toBe('300');
    expect(amountOnly?.assetText).toBe('usdc');
  });

  it('every verb-leading text produces a prefill — no phrasing in the battery errors', () => {
    for (const text of ['pay', 'request', 'invoice', 'link', 'convert', 'withdraw', 'pay 0', 'pay 100.50 usdc']) {
      expect(() => workflowFormPrefillFromText(text)).not.toThrow();
      expect(workflowFormPrefillFromText(text)).toBeDefined();
    }
  });

  it('search-lane text yields undefined (the search surface owns it), never a throw', () => {
    expect(workflowFormPrefillFromText('stripe fees')).toBeUndefined();
    expect(workflowFormPrefillFromText('')).toBeUndefined();
  });

  it('the pre-fill model is derivable from an intent too (one constructor path)', () => {
    const parse = parseCommand('pay alice 100 usdc');
    if (parse.kind !== 'COMMAND') {
      throw new Error('expected command');
    }
    const prefill = workflowFormPrefillFromIntent(parse.intent);
    expect(prefill.counterpartyText).toBe('alice');
    expect(prefill.amountText).toBe('100');
    expect(prefill.assetText).toBe('usdc');
    expect(prefill.missingFields).toEqual([]);
  });

  it('the amount stays a VERBATIM string — never float-parsed (exact-money law)', () => {
    const prefill = workflowFormPrefillFromText('pay 100.50 usdc');
    expect(prefill?.amountText).toBe('100.50');
    expect(typeof prefill?.amountText).toBe('string');
    const parse = parseCommand('convert 0.000000000000000001 eth to usdc');
    if (parse.kind === 'COMMAND') {
      expect(parse.intent.amount).toBe('0.000000000000000001');
    }
  });

  it('unrecognized tokens are preserved honestly — never silently dropped', () => {
    const parse = parseCommand('pay alice 100 usdc xyzzy');
    if (parse.kind !== 'COMMAND') {
      throw new Error('expected command');
    }
    expect(parse.intent.unrecognized).toEqual(['xyzzy']);
    const trailingTo = parseCommand('pay alice 100 usdc to');
    if (trailingTo.kind === 'COMMAND') {
      expect(trailingTo.intent.unrecognized).toContain('to');
    }
  });
});

// ---------------------------------------------------------------------------
// Ambiguity model — disambiguation chips (contract 06 §4)
// ---------------------------------------------------------------------------

describe('disambiguation chips (which Alice? — never a dead end, never a guess)', () => {
  const directory: readonly ContactDirectoryEntry[] = [
    { id: 'ct_1', displayName: 'Alice Smith' },
    { id: 'ct_2', displayName: 'Alice Chen' },
    { id: 'ct_3', displayName: 'Bob Martinez' },
  ];

  it('multiple matches yield one candidate chip per match (the caller picks)', () => {
    const resolution = resolveCounterparty('alice', directory);
    expect(resolution.matches).toHaveLength(2);
    expect(resolution.chips.map((chip) => chip.kind)).toEqual([
      'counterparty-candidate',
      'counterparty-candidate',
    ]);
    expect(resolution.chips.map((chip) => chip.label)).toEqual(['Alice Smith', 'Alice Chen']);
    expect(resolution.chips.map((chip) => chip.value)).toEqual(['ct_1', 'ct_2']);
  });

  it("zero matches yield the inline \"Add contact '<raw>'\" chip", () => {
    const resolution = resolveCounterparty('zoe', directory);
    expect(resolution.matches).toEqual([]);
    expect(resolution.chips).toHaveLength(1);
    expect(resolution.chips[0]?.kind).toBe('add-contact');
    expect(resolution.chips[0]?.label).toBe("Add contact 'zoe'");
  });

  it('a unique match is still offered as a chip (confirmation, not silent resolution)', () => {
    const resolution = resolveCounterparty('bob', directory);
    expect(resolution.matches).toHaveLength(1);
    expect(resolution.chips[0]?.label).toBe('Bob Martinez');
  });

  it('the match is case-insensitive containment over the directory (deterministic order)', () => {
    const resolution = resolveCounterparty('ALICE', directory);
    expect(resolution.matches.map((entry) => entry.id)).toEqual(['ct_1', 'ct_2']);
    const empty = resolveCounterparty('alice', []);
    expect(empty.chips[0]?.kind).toBe('add-contact');
  });
});

// ---------------------------------------------------------------------------
// No-result intent-turn (contract 06 §5)
// ---------------------------------------------------------------------------

describe("the no-result intent-turn (Create payment for '<q>')", () => {
  it('turns the miss into a create-payment intent carrying the query verbatim', () => {
    const turn = noResultIntentTurn('stripe fees');
    expect(turn.kind).toBe('create-payment');
    expect(turn.verb).toBe('pay');
    expect(turn.query).toBe('stripe fees');
    expect(turn.label).toBe("Create payment for 'stripe fees'?");
  });

  it('the turn is pure and deterministic', () => {
    expect(noResultIntentTurn('q')).toEqual(noResultIntentTurn('q'));
  });
});

// ---------------------------------------------------------------------------
// Keyboard model data (contract 06 §2/§5 + 01 §6)
// ---------------------------------------------------------------------------

describe('keyboard model data is present', () => {
  it('"/" focuses from anywhere; Esc restores prior focus; arrows/Tab/Enter are modeled', () => {
    expect(SEARCH_COMMAND_KEYBOARD_MODEL.focusFromAnywhere).toBe('/');
    expect(SEARCH_COMMAND_KEYBOARD_MODEL.escapeRestoresPriorFocus).toBe(true);
    expect(SEARCH_COMMAND_KEYBOARD_MODEL.withinGroup).toBe('arrow-up-down');
    expect(SEARCH_COMMAND_KEYBOARD_MODEL.acrossGroups).toBe('tab');
    expect(SEARCH_COMMAND_KEYBOARD_MODEL.execute).toBe('enter');
  });

  it('the five create chords map to their verbs (the shortcut lane into the grammar)', () => {
    expect(COMMAND_CHORDS.pay).toBe('c p');
    expect(COMMAND_CHORDS.request).toBe('c r');
    expect(COMMAND_CHORDS.invoice).toBe('c i');
    expect(COMMAND_CHORDS.link).toBe('c l');
    expect(COMMAND_CHORDS.convert).toBe('c v');
    for (const [chord, verb] of [
      ['c p', 'pay'],
      ['c r', 'request'],
      ['c i', 'invoice'],
      ['c l', 'link'],
      ['c v', 'convert'],
    ] as const) {
      expect(chordToCommandVerb(chord)).toBe(verb);
      expect(commandVerbChord(verb)).toBe(chord);
    }
  });

  it('withdraw has no chord; unknown chords map to nothing', () => {
    expect(commandVerbChord('withdraw')).toBeUndefined();
    expect(chordToCommandVerb('c w')).toBeUndefined();
    expect(chordToCommandVerb('c x')).toBeUndefined();
  });
});
