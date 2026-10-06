/**
 * @payswap/design — public API.
 *
 * Presentation-only design system (Work Order P3-W2-001): tokens, hooks and
 * accessible component primitives distilled from the You-platform reference
 * extraction (2026-10-02). No financial semantics, no business logic, no
 * network, no env reads — surfaces render what they are told, honestly.
 */

// Tokens (programmatic mirror of tokens.css)
export * from "./tokens.js";

// Utilities + hooks
export { cx } from "./utils/cx.js";
export { getFocusable, useFocusTrap } from "./hooks/useFocusTrap.js";
export { useCommandKey } from "./hooks/useCommandKey.js";
export { useReducedMotion } from "./hooks/useReducedMotion.js";
export { useId } from "./hooks/useId.js";
export { useGlobalChord, type ChordMap } from "./hooks/useGlobalChord.js";

// Primitives
export { Button, type ButtonProps, type ButtonVariant } from "./components/Button.js";
export {
  Card,
  CardMeta,
  CardSubtitle,
  CardTitle,
  type CardProps,
} from "./components/Card.js";
export { Panel, type PanelProps } from "./components/Panel.js";
export { Badge, StatusPill, STATUS_PILL_TONES, type StatusPillProps } from "./components/StatusPill.js";
export {
  StatusChip,
  STATUS_CHIP_STATES,
  type StatusChipProps,
  type OutcomeState,
} from "./components/StatusChip.js";
export { Field, FieldContext, type FieldContextValue, type FieldProps } from "./components/Field.js";
export { Input, type InputProps } from "./components/Input.js";
export { Select, type SelectProps } from "./components/Select.js";
export { MoneyInput, groupDigits, type MoneyInputProps } from "./components/MoneyInput.js";
export { Tabs, type TabItem, type TabsProps } from "./components/Tabs.js";
export { Dialog, type DialogProps } from "./components/Dialog.js";
export {
  CommandPalette,
  fuzzyMatch,
  type CommandPaletteProps,
  type PaletteCommand,
  type PaletteSection,
} from "./components/CommandPalette.js";
export {
  Sidebar,
  SidebarDrawer,
  SidebarSection,
  SidebarItem,
  type SidebarProps,
  type SidebarDrawerProps,
  type SidebarSectionProps,
} from "./components/Sidebar.js";
export { Topbar, type TopbarProps } from "./components/Topbar.js";
export { SkipLink, type SkipLinkProps } from "./components/SkipLink.js";

// Honest states
export { Skeleton, type SkeletonProps } from "./components/Skeleton.js";
export {
  EmptyState,
  ErrorState,
  UnknownState,
  AuthRequiredState,
  type EmptyStateProps,
  type ErrorStateProps,
  type UnknownStateProps,
  type AuthRequiredStateProps,
} from "./components/States.js";
export {
  Toast,
  ToastViewport,
  TOAST_TONES,
  type ToastProps,
  type ToastTone,
  type ToastViewportProps,
} from "./components/Toast.js";
export { KeyValue, type KeyValueEntry, type KeyValueProps } from "./components/KeyValue.js";

// UX-001 catalog convergence (contracts 02/03, v1.1)
export {
  ListPage,
  type ListPageProps,
  type ListPageRow,
  type ListPagePagination,
} from "./components/ListPage.js";
export {
  ObjectDetailHeader,
  type ObjectDetailHeaderProps,
} from "./components/ObjectDetailHeader.js";
export {
  ActivityTimeline,
  type ActivityTimelineProps,
  type ActivityTimelineEntry,
} from "./components/ActivityTimeline.js";
export {
  MetricCard,
  type MetricCardProps,
  type MetricCardComparison,
} from "./components/MetricCard.js";
export {
  CreateMenu,
  CREATE_CHORDS,
  type CreateMenuItem,
  type CreateMenuProps,
} from "./components/CreateMenu.js";
export {
  SetupGuideWidget,
  type SetupGuideStep,
  type SetupGuideWidgetProps,
} from "./components/SetupGuideWidget.js";
export {
  EnvironmentBanner,
  type EnvironmentBannerProps,
} from "./components/EnvironmentBanner.js";
export {
  RelatedObjects,
  type RelatedObjectsProps,
  type RelatedObjectsGroup,
  type RelatedObjectLink,
} from "./components/RelatedObjects.js";
export {
  ConfirmationButton,
  type ConfirmationButtonProps,
} from "./components/ConfirmationButton.js";
export {
  RecommendationsCard,
  type RecommendationsCardProps,
} from "./components/RecommendationsCard.js";
