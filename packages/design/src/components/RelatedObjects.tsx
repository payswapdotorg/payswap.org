import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";

export interface RelatedObjectLink {
  /** Link target (detail route of the related object). */
  href: string;
  /** Link label (object id or name — mask long identifiers upstream). */
  label: ReactNode;
  /** Right-aligned meta ("3 payments", "€25.00"). */
  meta?: ReactNode;
}

export interface RelatedObjectsGroup {
  id: string;
  /** Group title ("Payments", "Settlements", "Refunds"). */
  title: ReactNode;
  links: RelatedObjectLink[];
}

export interface RelatedObjectsProps extends HTMLAttributes<HTMLDivElement> {
  /** Cross-object groups (Payment → Settlement → Refund; Customer → Payments). */
  groups: RelatedObjectsGroup[];
  /** Rendered when every group is empty. */
  empty?: ReactNode;
}

/**
 * RelatedObjects (contract 03 §2.14 / 01 §4): the list of cross-object
 * links on a detail page. ONE component everywhere — every "related
 * objects" surface renders through it, so drill paths stay identical
 * across the product.
 */
export function RelatedObjects({
  groups,
  empty,
  className,
  ...rest
}: RelatedObjectsProps) {
  const populated = groups.filter((group) => group.links.length > 0);
  if (populated.length === 0 && empty !== undefined) {
    return <div className={cx("ps-related", className)} {...rest}>{empty}</div>;
  }
  return (
    <div className={cx("ps-related", className)} {...rest}>
      {populated.map((group) => (
        <section key={group.id} className="ps-related__group">
          <h3 className="ps-related__group-title">{group.title}</h3>
          <ul className="ps-related__list">
            {group.links.map((link) => (
              <li key={link.href} className="ps-related__item">
                <a className="ps-related__link" href={link.href}>
                  <span className="ps-related__label">{link.label}</span>
                  {link.meta ? (
                    <span className="ps-related__meta ps-num">{link.meta}</span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
