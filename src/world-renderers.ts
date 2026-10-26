/**
 * The replaceable-renderer CONTRACT for a world SDK — types only.
 *
 * A world draws Chatly with its own engine, so the parts it draws must be
 * swappable one at a time: keep Chatly's speech bubble, replace its card with
 * the shop's own shelf model. This file fixes what each override RECEIVES —
 * the data it draws and the handlers it calls — so a renderer written for one
 * world SDK is a renderer for any, and so the handlers are the same calls this
 * package already makes (`postback`, `react`, `send`, `reportAction`).
 *
 * There is deliberately no implementation here. A renderer needs a scene
 * graph, and this package has none and imports none (no three.js, Babylon or
 * engine binding: zero dependencies is what lets Unity, Unreal and a headset
 * runtime all embed it). A world SDK that implements these is a separate
 * package and a separate decision; until one exists, a host implements the
 * ones it wants and draws the rest itself.
 *
 * Every override returns the host's own node type (`N`), opaque here.
 */
import type { Conversation } from './conversation.js';
import type { Block, ConversationMessage, TypingState } from './types.js';
import type { MessageEmbodiment } from './world-embodiment.js';
import type { ResolvedWorldPlacement } from './world-placement.js';
import type { EmbodiedAgent } from './world-presence.js';
import type { ResolvedWorldTheme } from './world-theme.js';

/** A block narrowed to its `type`. The full shape is the block protocol's. */
export type BlockOf<T extends string> = Block & { readonly type: T };

/** What every override can reach: the look, and where the surface sits. */
export interface RenderContext {
  readonly theme: ResolvedWorldTheme;
  readonly placement: ResolvedWorldPlacement;
  /** The viewer asked for less motion. Already applied to `theme`; here for custom effects. */
  readonly reducedMotion: boolean;
}

/** The three things a visitor can do to a block, as the calls the core already makes. */
export interface BlockHandlers {
  /** Choose a card, chip or option: a postback with the block's own payload. */
  readonly select: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Press a button or card action; host actions arrive on the widget-style `action` path. */
  readonly press: (actionId: string) => Promise<void>;
  /** React to the message the block belongs to. */
  readonly react: (emoji: string) => Promise<void>;
}

export interface CardRenderProps extends RenderContext, BlockHandlers {
  readonly block: BlockOf<'card'>;
  readonly message: ConversationMessage;
  readonly selected: boolean;
}

/** A card the visitor has picked off a grid — the object in their hand. */
export interface PickRenderProps extends RenderContext, BlockHandlers {
  readonly block: BlockOf<'card'>;
  readonly message: ConversationMessage;
  /** Put it back: the pick is undone and the grid shows it again. */
  readonly release: () => void;
}

export interface BubbleRenderProps extends RenderContext {
  readonly message: ConversationMessage;
  /** The cue the message carries, already read. Null when none. */
  readonly embodiment: MessageEmbodiment | null;
  /** True while the message is streaming. */
  readonly streaming: boolean;
}

export interface PanelRenderProps extends RenderContext {
  readonly conversation: Conversation;
  readonly messages: readonly ConversationMessage[];
  readonly typing: TypingState | null;
}

export interface ComposerRenderProps extends RenderContext {
  readonly send: (body: string) => Promise<void>;
  /** Report composing, so the agent's body can turn to listen. */
  readonly setComposing: (composing: boolean) => void;
  readonly disabled: boolean;
}

export interface AgentRenderProps extends RenderContext {
  readonly agent: EmbodiedAgent;
  /** The latest cue, to play once. Null when none. */
  readonly embodiment: MessageEmbodiment | null;
  /** The host clip for that cue, from `presence.expressions`. Null = do not play. */
  readonly expressionClip: string | null;
}

/** Any subset may be supplied; an absent one is drawn by whatever the SDK ships. */
export interface WorldRenderers<N> {
  readonly renderCard?: (props: CardRenderProps) => N;
  readonly renderPick?: (props: PickRenderProps) => N;
  readonly renderBubble?: (props: BubbleRenderProps) => N;
  readonly renderPanel?: (props: PanelRenderProps) => N;
  readonly renderComposer?: (props: ComposerRenderProps) => N;
  readonly renderAgent?: (props: AgentRenderProps) => N;
}
