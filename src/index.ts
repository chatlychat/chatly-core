/**
 * `@chatlychat/core` -- the headless conversation core.
 *
 *   const chatly = createChatlyCore({ publicId, fetch, storage, socket: io });
 *   const conv = await chatly.startConversation('hello');
 *   conv.subscribe(() => render(conv.getSnapshot()));
 *   await conv.postback({ body: 'Buy', payload: { sku: 'x' } });
 *
 * No DOM, no React, no dependencies. React hooks are a separate entry point:
 * `@chatlychat/core/react`.
 */
export { ChatlyCore, createChatlyCore, type ChatlyCoreOptions } from './core.js';
export {
  Conversation,
  TYPING_STOP_AFTER_MS,
  type ConnectionState,
  type ConversationSnapshot,
} from './conversation.js';
export { VisitorSession, DEFAULT_API_URL, type SessionOptions } from './session.js';
export {
  VisitorApi,
  type ActionResult,
  type ContextInput,
  type ContextResult,
  type PostbackInput,
  type ProfileView,
  type PresignedUpload,
  type ReactionSummary,
  type SendOptions,
  type StartOptions,
  type StepRequestResult,
  type StepResult,
} from './visitor-api.js';
export { connectRealtime, type RealtimeConnectOptions, type RealtimeHandle } from './realtime.js';
export { VoiceSession, FLOOR_CLAIM_TTL_MS } from './voice.js';
export {
  VOICE_SIGNAL_VERSION,
  decodeVoiceSignal,
  encodeVoiceSignal,
  readVoiceSignal,
  type VoiceFloorSignal,
  type VoiceFloorState,
  type VoiceMuteSignal,
  type VoiceSignal,
  type VoiceSignalInput,
  type VoiceSignalRead,
  type VoiceSignalRefusal,
} from './voice-signals.js';
export {
  IDLE_TURN,
  foldVoiceTurn,
  sameActivity,
  type VoiceFloor,
  type VoiceSpeaker,
  type VoiceTurnInput,
  type VoiceTurnState,
} from './voice-turn.js';
export {
  VISEME_NAMES,
  createSpeechFrameReader,
  visemeAt,
  type MessageSpeech,
  type SpeechFormat,
  type SpeechFrame,
  type SpeechFrameReader,
  type VisemeCue,
  type VisemeName,
  type VisemeTiming,
} from './speech.js';
export { createSafeStorage } from './storage.js';
export {
  SpaceClient,
  createSpaceClient,
  applySpacePolicy,
  retractedTurnIds,
  SPACES_DEFAULT_API_URL,
  type JoinSpaceOptions,
  type JoinedSpace,
  type RecordedOutcome,
  type SpaceClientOptions,
  type SpaceThread,
  type SpaceTurn,
  type SpatialOutcome,
} from './spaces.js';
export { readBlockEnvelope, BLOCK_PROTOCOL_VERSION } from './blocks.js';
export {
  dispatchPress,
  messageActions,
  type PressHooks,
  type PressRef,
  type PressTarget,
  type PressableAction,
} from './press.js';
export { parseMessage, mergeMessages, type BlocksReader } from './message.js';
export { ChatlyError, type ChatlyErrorCode } from './errors.js';
export type { ConversationNotice } from './card-telemetry.js';
/*
 * The 3D-world surface (ADR 0064). A world host embeds this package, not the
 * 2D DOM panel: these three modules are the whole of what it needs from
 * Chatly that a web page does not.
 */
export {
  AGENT_PRESENCE_STATES,
  AVATAR_ANCHORS,
  AVATAR_FORMATS,
  AVATAR_SCALE_MAX,
  AVATAR_SCALE_MIN,
  PRESENCE_IDLE_BEHAVIOURS,
  PRESENCE_PERSONAL_SPACE_MAX_METRES,
  PRESENCE_PERSONAL_SPACE_MIN_METRES,
  PRESENCE_VOICE_RATE_MAX,
  PRESENCE_VOICE_RATE_MIN,
  describePresence,
  describePresenceState,
  embodiedAgent,
  type AgentPresenceState,
  type AgentWorldPresence,
  type AvatarAnchor,
  type AvatarAsset,
  type AvatarFormat,
  type EmbodiedAgent,
  type EmbodiedAgentOptions,
  type PresenceClips,
  type PresenceMap,
} from './world-presence.js';
export {
  PLACEMENT_ANCHORS,
  PLACEMENT_BILLBOARDS,
  PLACEMENT_DEFAULTS,
  PLACEMENT_FALLBACKS,
  PLACEMENT_FOLLOWS,
  resolveWorldPlacement,
  type PlacementAnchor,
  type PlacementBillboard,
  type PlacementChange,
  type PlacementFallback,
  type PlacementFollow,
  type ResolvedWorldPlacement,
  type WorldHostAbilities,
  type WorldPlacementRequest,
} from './world-placement.js';
export {
  BUBBLE_SHAPES,
  CARD_PEDESTALS,
  MOTION_ENTRANCES,
  MOTION_PICKS,
  PANEL_MATERIALS,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TYPING_LOOKS,
  WORLD_THEME_BASE_DEFAULTS,
  WORLD_THEME_DARK_DEFAULTS,
  WORLD_THEME_LIGHT_DEFAULTS,
  WORLD_THEME_TEXT_SCALE_DEFAULT,
  resolveWorldTheme,
  type PanelMaterial,
  type ResolveWorldThemeOptions,
  type ResolvedWorldTheme,
  type WorldTheme,
  type WorldThemeBase,
  type WorldThemeOverlay,
} from './world-theme.js';
export {
  AGENT_EXPRESSIONS,
  LOOK_AT_TARGETS,
  expressionClip,
  messageEmbodiment,
  type AgentExpression,
  type LookAt,
  type MessageEmbodiment,
} from './world-embodiment.js';
export type {
  CapabilityEquivalent,
  HostCapabilityDeclaration,
  HostCapabilityInvocation,
  HostSurface,
  HostSurfaceState,
  SurfaceResult,
} from './host-surface.js';
export type {
  AgentRenderProps,
  BlockHandlers,
  BlockOf,
  BubbleRenderProps,
  CardRenderProps,
  ComposerRenderProps,
  PanelRenderProps,
  PickRenderProps,
  RenderContext,
  WorldRenderers,
} from './world-renderers.js';
export type {
  VoiceActivity,
  VoiceConnectionState,
  VoiceGrant,
  VoiceMicrophoneState,
  VoiceSessionOptions,
  VoiceSnapshot,
  VoiceTimings,
  VoiceTransportConnectInput,
  VoiceTransportFactory,
  VoiceTransportHandle,
  VoiceTransportHooks,
} from './voice-types.js';
export type {
  Block,
  BlockEnvelope,
  ConversationMessage,
  ConversationSummary,
  FetchLike,
  FetchResponseLike,
  IdentifyResult,
  KeyValueStorage,
  MessageAttachment,
  ReactionEntry,
  SocketFactory,
  SocketLike,
  SocketOptions,
  StorageSource,
  TypingState,
  VisitorIdentity,
} from './types.js';
export { actionsOf, cardsOf, findAction, readBlockEnvelopeTyped } from './typed/readers.js';
export type {
  Action as TypedAction,
  ActionStyle,
  Block as TypedBlock,
  BlockEnvelope as TypedBlockEnvelope,
  Card as TypedCard,
  CardBody as TypedCardBody,
  CardGridBlock,
  CopyAction,
  HostEventAction,
  PostbackAction,
  StepAction,
  UrlAction,
} from './typed/block-types.js';
