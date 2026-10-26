/*
 * VERBATIM COPY of `packages/blocks/src/types.ts` from the first `export` down.
 *
 * The core publishes with zero dependencies and `@chatlychat/blocks` is a
 * separate package, so the types are restated here rather than imported
 * (a published declaration that names an uninstalled package is a type error
 * for every consumer). `blocks/src/core-types-parity.spec.ts` compares the two
 * texts and fails on any difference: edit them together or not at all.
 */
/** Every `kind` an action can have. */
export type ActionStyle = 'primary' | 'secondary' | 'danger';

export interface UrlAction {
  kind: 'url';
  label: string;
  href: string;
  style?: ActionStyle | undefined;
  icon?: string | undefined;
  target?: 'self' | undefined;
}

export interface PostbackAction {
  kind: 'postback';
  label: string;
  id?: string | undefined;
  value: string;
  payload?: Record<string, unknown> | undefined;
  silent?: boolean | undefined;
  style?: ActionStyle | undefined;
  icon?: string | undefined;
}

export interface HostEventAction {
  kind: 'host_event';
  label: string;
  id?: string | undefined;
  event: string;
  data?: Record<string, unknown> | undefined;
  style?: ActionStyle | undefined;
  icon?: string | undefined;
}

export interface StepAction {
  kind: 'step';
  label: string;
  id?: string | undefined;
  canvasId: string;
  params?: Record<string, unknown> | undefined;
  style?: ActionStyle | undefined;
  icon?: string | undefined;
}

export interface NavigateAction {
  kind: 'navigate';
  label: string;
  id?: string | undefined;
  /** A path on the integrator's own site, such as `/pricing?plan=pro`. */
  path: string;
  style?: ActionStyle | undefined;
  icon?: string | undefined;
}

export interface CopyAction {
  kind: 'copy';
  label: string;
  text: string;
  style?: ActionStyle | undefined;
  icon?: string | undefined;
}

export type Action =
  | UrlAction
  | PostbackAction
  | HostEventAction
  | StepAction
  | NavigateAction
  | CopyAction;
/** What a grid's "show me more" tile may carry. */
export type PagingAction = UrlAction | PostbackAction | NavigateAction;
/** What a card's image and title may fire. */
export type CardTapAction = UrlAction | HostEventAction | StepAction | NavigateAction;

export interface Field {
  label: string;
  value: string;
}

/** Minor units plus an ISO 4217 code; formatted in the visitor's locale. */
export interface Money {
  amount: number;
  currency: string;
  compareAt?: number | undefined;
}

export interface Variant {
  label: string;
  value: string;
  inStock?: boolean | undefined;
}

export type Stock = 'in_stock' | 'low' | 'out_of_stock';
export type Reaction = 'like' | 'dislike';

export interface Badge {
  text: string;
  tone?: 'success' | 'warning' | 'danger' | 'neutral' | undefined;
}

export type CardBadge = string | Badge | (string | Badge)[];

export interface Model {
  url: string;
  format?: 'gltf' | 'usdz' | undefined;
  scale?: number | undefined;
  anchor?: 'center' | 'base' | 'top' | 'back' | undefined;
}

export type GridPlacement = 'arc' | 'shelf' | 'wall' | 'table';

export interface GridMore {
  label: string;
  action: PagingAction;
}

export interface OrderStatusStep {
  label: string;
  at?: string | undefined;
  state: 'done' | 'current' | 'pending';
}

/** A card's fields without its `type` -- the shape inside a `card_grid`. */
export interface CardBody {
  id?: string | undefined;
  /** 1-128 of `[A-Za-z0-9:._-]`; a stable key the bot owns, for `PATCH /v1/bot/cards?ref=`. */
  ref?: string | undefined;
  title: string;
  subtitle?: string | undefined;
  image?: string | undefined;
  badge?: CardBadge | undefined;
  price?: Money | undefined;
  fields?: Field[] | undefined;
  variants?: Variant[] | undefined;
  stock?: Stock | undefined;
  model?: Model | undefined;
  actions?: Action[] | undefined;
  reactions?: Reaction[] | undefined;
  action?: CardTapAction | undefined;
  reaction?: Reaction | undefined;
}

export interface TextBlock {
  type: 'text';
  id?: string | undefined;
  markdown: string;
}

export interface MediaBlock {
  type: 'media';
  id?: string | undefined;
  url: string;
  alt: string;
  kind: 'image' | 'video';
  aspect?: string | undefined;
}

export interface FieldsBlock {
  type: 'fields';
  id?: string | undefined;
  items: Field[];
}

export interface Card extends CardBody {
  type: 'card';
}

export interface CardGridBlock {
  type: 'card_grid';
  id?: string | undefined;
  cards: CardBody[];
  columns?: 1 | 2 | 3 | undefined;
  layout?: 'grid' | 'carousel' | 'auto' | undefined;
  more?: GridMore | undefined;
  placement?: GridPlacement | undefined;
}

export interface ActionsBlock {
  type: 'actions';
  id?: string | undefined;
  actions: Action[];
}

export interface QuickRepliesBlock {
  type: 'quick_replies';
  id?: string | undefined;
  options: { label: string; value: string }[];
  silent?: boolean | undefined;
}

/** `id` is required: a status exists to be patched when the work finishes. */
export interface StatusBlock {
  type: 'status';
  id: string;
  text: string;
  done?: boolean | undefined;
}

export interface OrderStatusBlock {
  type: 'order_status';
  id?: string | undefined;
  steps: OrderStatusStep[];
}

export interface TableBlock {
  type: 'table';
  id?: string | undefined;
  caption?: string | undefined;
  columns: { label: string; image?: string | undefined }[];
  rows: { label: string; cells: string[] }[];
}

export interface PlaceBlock {
  type: 'place';
  id?: string | undefined;
  label: string;
  detail?: string | undefined;
  ref?: string | undefined;
}

export interface DividerBlock {
  type: 'divider';
  id?: string | undefined;
}

export type Block =
  | TextBlock
  | MediaBlock
  | FieldsBlock
  | Card
  | CardGridBlock
  | ActionsBlock
  | QuickRepliesBlock
  | StatusBlock
  | OrderStatusBlock
  | TableBlock
  | PlaceBlock
  | DividerBlock;

export interface BlockEnvelope {
  v: 1;
  blocks: Block[];
}

/** One thing the server would refuse. `path` is `blocks[2].cards[0].title`; '' is the envelope. */
export interface Issue {
  path: string;
  reason: string;
}
