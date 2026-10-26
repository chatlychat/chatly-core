# @chatlychat/core

## 0.6.0 — 2026-10-26

A minor, not a patch: index-based presses on a message with a card tap or a `more` tile now point at different actions.

- `navigate` is accepted as a card's tap target and as a grid's `more` tile (`CardTapAction`, `PagingAction`).
- `messageActions` (and so `conversation.press`) now enumerate a card's own `action` (id `b0.c1.a-1`, `b0.a-1` on a standalone card) and a grid's `more` action (`b0.a0`), tap first, then the card's buttons. Index-based presses on a message with a card tap or a `more` tile shift by the new entries.
- `dispatchPress` refuses a `navigate` whose path fails the sink check (`//evil.example`, a backslash, a control character): no hook is called and it resolves `false`.

## 0.5.0 — 2026-10-26

What a 3D shopping agent needs to act on cards and to know its audience.

- `conversation.press(messageId, actionId | index, hooks?)` presses an action on a message. The id is the action's own `id` or the widget's positional one (`b0.a1`, `b0.c2.a0`, the same ids `reportAction` is keyed on); the index counts the message's actions in document order. `postback` and `step` go to the server; `host_event`, `url` and `navigate` go to your hooks `onHostEvent`, `onOpenUrl` and `onNavigate` (given per call, or once with `conversation.setPressHooks`). Resolves to whether anything acted; an unknown message or action throws `unknown_message` / `unknown_action`.
- `dispatchPress`, `messageActions` and the `PressHooks` types are exported. `@chatlychat/world` now calls the same `dispatchPress`, so there is one implementation.
- `conversation.reactToCard(messageId, cardId, 'like' | 'dislike' | null)` sends what the widget's card thumbs send: a silent `card.reaction` postback with `{ card, reaction }`. The bot receives `card.reaction` with `interaction.messageId` of the message carrying the card.
- `core.profile({ locale? })` returns the audience profile this visitor matches, resolved on the server with the widget's own matcher: `{ profile, matched, starterPrompts, quickLinks, copy }`. Identity and signed context come from the server's session, never from the caller. Calls `POST /v1/widget/profile/resolve`.
- `ChatlyErrorCode` gains `unknown_message` and `unknown_action`.

## Unreleased

- `conversation.onNotice(handler)`: the ephemeral one-line toast a bot sends to answer a silent postback (`{ replyTo, body }`). Not a message: never in the snapshot, live socket only.
- `conversation.reportCardView(messageId, cardId)` and `reportCardAction(messageId, cardId, actionIndex)` send `card.viewed` / `card.action` for a host that draws its own cards. Consent-gated and default no: pass `analytics: true` or call `core.setAnalyticsConsent(true)`, else they resolve `false` and send nothing. `navigate` actions carry a validated `path`; your `onNavigate` hook receives the whole action.
- `readBlockEnvelopeTyped(message)`, `cardsOf(message)`, `actionsOf(message)` and `findAction(message, { kind?, event? })`: the message's blocks as a typed union (exported as `TypedBlock`, `TypedBlockEnvelope`, `TypedCard`, `TypedCardBody`, `TypedAction`, plus each action interface). A block type this version does not know is omitted from the typed view; `message.blocks` still holds it.

## 0.4.0 — 2026-10-26

Identity parity with the web widget, so a signed-in visitor is not anonymous in a 3D world.

- `core.identify(identity)` / `core.init(identity?)` resolve to `{ contactId, identityVerified, externalId }`. `identityVerified` is the server's verdict, the same one the widget gets; a bot delivery reads it.
- `VisitorIdentity` gains `userToken` (OIDC / Atlas channels) and `identityToken` (IDV v2 signed identity). Both go on the wire under those exact names, inside `identity`, as the widget sends them.
- `core.on('identified', handler)` fires after every init/identify, so a host knows who the visitor is before it starts a conversation. Returns an unsubscribe.
- `core.reset()` forgets the visitor: closes open conversations, drops the session token, contact and remembered identity, and clears the stored token.
- `core.setContext({ audience?, contextToken?, surface? })` posts to `/v1/widget/context` with the widget's body and resolves `{ surfaceRejected, verified }`. `setSurface` is unchanged.
- `VisitorSession.reset()` now also forgets the remembered identity (it used to replay it on the next 403 recovery).

## 0.3.1 — 2026-10-26

- `applySpacePolicy(conversation, joined)`: in a space that refuses bot-fired actions (`space.unpromptedCapabilities: false`, the default for shared spaces), a bot-fired host-capability invocation is dropped and reported refused to the server.
- `join` returns `space.unpromptedCapabilities`; a hidden turn in a shared space reads `hidden: true` with a neutral body.

## 0.3.0 — 2026-10-25

The first version prepared for npm. Everything a 3D world, game or headset needs from Chatly without the web widget:

- `core.setSurface({ kind, capabilities, state })` declares this client as a host surface — what kind of place it is, what it can do, and where the visitor is in names (`room`, `zone`, `near`, `lookingAt`, `holding`). The server reports what it dropped in `surfaceRejected`.
- `conversation.onCapability(handler)` hears a bot fire a capability without a press. Answer with `conversation.reportAction({ messageId, actionId: invocationId, status })`; refuse with `status: 'failed', data: { refused: true }`.
- `core.worldTheme` is the channel's `worldTheme` from init. `resolveWorldTheme` gains the cards, speech, type, sound and motion token groups, `layers` for a per-room look over the channel's, and `reducedMotion`, which beats every motion token.
- `messageEmbodiment(message)` reads a reply's `expression` cue and `lookAt` target; `expressionClip(presence, cue)` maps it to your rig's clip. A presence gains `expressions`, `nameTag`, `voice`, `idle` and `personalSpaceMetres`.
- `WorldRenderers` and its props types: the contract a world SDK's replaceable renderers (`renderCard`, `renderPick`, `renderBubble`, `renderPanel`, `renderComposer`, `renderAgent`) receive. Types only.
- Bot voice (ADR 0073): `api.speech(conversationId, messageId, format?)` returns a short-lived `MessageSpeech` URL, or `null` when the bot has no voice. `createSpeechFrameReader()` reads the `ndjson` stream into `SpeechFrame`s (an unknown frame type is skipped), and `visemeAt(cues, ms)` gives the mouth shape at a playback position. New types: `MessageSpeech`, `SpeechFrame`, `SpeechFrameReader`, `SpeechFormat`, `VisemeCue`, `VisemeName`, `VisemeTiming`.
- `@chatlychat/core/react` is a second entry point: the React hooks, for a host that renders with React.
- The `embodiment` and `worldTheme` types are exported, so a host can type what it reads from a message and from init.
- Spatial outcomes accept `looked_at` and `picked_up`.

## 0.2.0 — 2026-10-25

Unpublished. `private` dropped and the package shaped for npm alongside `@chatlychat/game-bridge`.

## 0.1.0 — 2026-10-23

Unpublished. The headless conversation core (identity, conversations, realtime, sending, postbacks, steps, reactions, parsed blocks, the `./react` hooks) and the world surface: `embodiedAgent`, `resolveWorldPlacement`, `resolveWorldTheme`, shared spaces (`createSpaceClient`) and spatial voice (`VoiceSession`).
