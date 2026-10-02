"use client";

import {
  useEffect,
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";

/* ------------------------------ items ------------------------------- */

export interface SidebarItemProps {
  /** Destination — renders a real anchor (deep-linkable, middle-clickable). */
  href?: string;
  /** Active page state (aria-current="page" + accent styling). */
  active?: boolean;
  /** Optional leading icon (decorative; the text label carries meaning). */
  icon?: ReactNode;
  children: ReactNode;
}

type SidebarItemAnchorProps = SidebarItemProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children">;
type SidebarItemButtonProps = SidebarItemProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

/**
 * One navigation entry. Renders a real link when `href` is given (PaySwap
 * improvement over the reference's button-nav: deep-linkable, semantic),
 * else a button for SPA-internal view switches. Active state is carried by
 * aria-current (not color alone).
 */
export function SidebarItem(props: SidebarItemAnchorProps | SidebarItemButtonProps) {
  const { active = false, icon, className, children, ...rest } = props;
  const shared = cx(
    "ps-sidebar__item",
    active && "ps-sidebar__item--active",
    className,
  );
  const inner = (
    <>
      {icon ? (
        <span className="ps-sidebar__item-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ps-sidebar__item-label">{children}</span>
    </>
  );

  if (props.href !== undefined) {
    const { href, ...anchorRest } = rest as AnchorHTMLAttributes<HTMLAnchorElement> &
      Pick<SidebarItemProps, "href">;
    return (
      <a href={href} aria-current={active ? "page" : undefined} className={shared} {...anchorRest}>
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={shared}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
    >
      {inner}
    </button>
  );
}

export interface SidebarSectionProps extends HTMLAttributes<HTMLDivElement> {
  /** Small-caps group label (BUILD/TRUST-style — the reference pattern). */
  label: string;
  children: ReactNode;
}

/** A grouped navigation section with a small-caps label. */
export function SidebarSection({ label, className, children, ...rest }: SidebarSectionProps) {
  return (
    <div className={cx("ps-sidebar__section", className)} {...rest}>
      <div className="ps-label ps-sidebar__section-label" aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------ shared nav -------------------------- */

export interface SidebarNavProps {
  /** Accessible name for the navigation landmark (default "Primary"). */
  label?: string | undefined;
  /** Brand block (monogram + wordmark), rendered in the header. */
  brand?: ReactNode | undefined;
  /** Context footer (user, workspace, environment badges). */
  footer?: ReactNode | undefined;
  children: ReactNode;
  id?: string | undefined;
}

function SidebarNav({ label = "Primary", brand, footer, children, id }: SidebarNavProps) {
  const navId = useId("ps-sidebar", id);
  return (
    <>
      {brand ? <div className="ps-sidebar__brand">{brand}</div> : null}
      <nav id={navId} aria-label={label} className="ps-sidebar__nav">
        {children}
      </nav>
      {footer ? <div className="ps-sidebar__footer">{footer}</div> : null}
    </>
  );
}

/* ------------------------------ static ------------------------------ */

export interface SidebarProps
  extends Omit<SidebarNavProps, "children" | "id">,
    Omit<HTMLAttributes<HTMLElement>, "children"> {
  children: ReactNode;
}

/**
 * Static application sidebar: 240px aside landmark with grouped nav.
 * Hidden below the lg breakpoint via CSS; pair with `SidebarDrawer`
 * (same content, overlay semantics) for the mobile navigation pattern.
 */
export function Sidebar({ label, brand, footer, children, className, ...rest }: SidebarProps) {
  return (
    <aside className={cx("ps-sidebar", "ps-sidebar--static", className)} {...rest}>
      <SidebarNav label={label} brand={brand} footer={footer}>
        {children}
      </SidebarNav>
    </aside>
  );
}

/* ------------------------------ drawer ------------------------------ */

export interface SidebarDrawerProps extends SidebarNavProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (default "Navigation"). */
  dialogLabel?: string;
}

/**
 * Mobile navigation drawer (<lg): the sidebar collapses into a modal dialog
 * (the reference's verified pattern) — scrim, aria-modal, h2 heading,
 * explicit Close button, Escape, focus trap with restore.
 */
export function SidebarDrawer({
  open,
  onClose,
  dialogLabel = "Navigation",
  label,
  brand,
  footer,
  children,
}: SidebarDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const titleId = useId("ps-sidebar-drawer-title");
  useFocusTrap(drawerRef, open);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="ps-dialog-layer">
      <div className="ps-dialog-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ps-sidebar ps-sidebar--drawer"
        onKeyDown={handleKeyDown}
      >
        <div className="ps-sidebar__drawer-header">
          <h2 id={titleId} className="ps-sidebar__drawer-title">
            {dialogLabel}
          </h2>
          <button
            type="button"
            className="ps-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            <span aria-hidden="true">&#215;</span>
          </button>
        </div>
        <SidebarNav label={label} brand={brand} footer={footer}>
          {children}
        </SidebarNav>
      </div>
    </div>
  );
}
