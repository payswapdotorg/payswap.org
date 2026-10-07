/**
 * UX-006 — My contacts (contract 10 §2: the customers object projected into
 * the consumer's address book). The SAME collection anatomy (ListPage,
 * contract 03 §2.1) with the consumer's columns and vocabulary; the honest
 * empty teaches how contacts come to exist (guests are auto-created from
 * hosted payments — nothing is fabricated).
 *
 * A PROJECTION, not a second component system: rows are the same list-cell
 * anatomy, and the empty renders through EmptyState.
 */

import Link from "next/link";
import { EmptyState, ListPage } from "@payswap/design";
import type { ListPageRow } from "@payswap/design";

/** One address-book entry (the customers object, consumer-projected). */
export interface ContactRecordView {
  readonly id: string;
  /** Display name (derived for auto-created guests). */
  readonly name: string;
  /** Verified identifier line, or null when unverified (rendered honestly). */
  readonly verified: { readonly kind: "email" | "address"; readonly value: string } | null;
  /** When the contact entered the address book (ISO). */
  readonly createdAt: string;
}

/**
 * The verified mark — plain words, never an outcome chip: a contact's
 * verification is not a money outcome, so the StatusChip vocabulary stays
 * reserved for payment states (contract 03 §2.2).
 */
function verifiedCell(contact: ContactRecordView): React.ReactNode {
  if (contact.verified === null) {
    return "Not verified yet";
  }
  return `Verified (${contact.verified.kind})`;
}

export function contactRows(contacts: readonly ContactRecordView[]): ListPageRow[] {
  return contacts.map((contact) => ({
    id: contact.id,
    cells: [
      contact.name,
      verifiedCell(contact),
      contact.verified === null ? "—" : contact.verified.value,
      contact.createdAt.slice(0, 10),
    ],
  }));
}

export function MyContacts({ contacts }: { readonly contacts: readonly ContactRecordView[] }) {
  return (
    <section className="cc-stack" aria-labelledby="cc-my-contacts-heading" data-testid="my-contacts">
      <div>
        <h1 id="cc-my-contacts-heading" className="cc-section-heading">
          My contacts
        </h1>
        <p className="cc-section-intro">
          Your address book — the people and businesses you pay, and those who
          pay you. Entries with a verified identifier carry a verified mark.
        </p>
      </div>
      <ListPage
        title="My contacts"
        data-testid="my-contacts-list"
        columns={["Contact", "Verified", "Identifier", "Since"]}
        rows={contactRows(contacts)}
        empty={
          <EmptyState
            title="No contacts yet"
            description={
              <>
                Contacts are created for you automatically when someone pays
                you through a hosted payment page or a payment link — they
                arrive as guests with a derived name, and you can verify them
                afterwards. Nothing is fabricated in the meantime.
              </>
            }
            action={
              <Link href="/app/payments/link" className="ps-button ps-button--sm ps-button--primary">
                Create a payment link
              </Link>
            }
            teachingLine="Test-mode guests are marked as test data — they never mix with live contacts."
          />
        }
        pagination={
          contacts.length > 0 ? { from: 1, to: contacts.length, total: contacts.length } : undefined
        }
      />
    </section>
  );
}
