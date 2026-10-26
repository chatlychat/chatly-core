# @chatlychat/core

The headless Chatly conversation core: identity, conversations, realtime,
sending, postbacks, interactive steps, reactions and parsed rich blocks, as
typed data.

**No DOM. No React. No socket library. Zero dependencies.** Nothing in this
package names `window`, `document`, `localStorage`, `navigator`, `fetch` or
`process` — that is enforced by the compiler (`lib: ["ES2022"]`, `types: []`)
and by a runtime spec that replaces each of those globals with a getter that
throws. So it runs in a browser, in Node, in a worker, in a Unity WebGL or
Godot HTML5 export, and in a 3D world host that has a scene graph instead of a
page.

What it is **not**: a UI. There is no panel, no bubble, no launcher and no
stylesheet here. If you want the drop-in web widget, that is
`@chatlychat/widget-element` / `@chatlychat/sdk-js`. If you want to draw the
conversation yourself, this is the package.

```bash
pnpm add @chatlychat/core
```

## Everything the core needs from its host is injected

The core imports nothing, so every capability arrives as an option. All of
them are optional except `publicId`, and the defaults are the ones a browser
can satisfy on its own.

`SessionOptions` — identity and transport:

| option        | type                                       | default                               |
| ------------- | ------------------------------------------ | ------------------------------------- |
| `publicId`    | `string` (**required**)                    | —                                     |
| `apiUrl`      | `string`                                   | `https://api.chatlychat.com`          |
| `fetch`       | `FetchLike`                                | `globalThis.fetch`                    |
| `storage`     | `KeyValueStorage` or a thunk returning one | in-memory, nothing persisted          |
| `randomId`    | `() => string`                             | `crypto.randomUUID`, then Math.random |
| `locale`      | `string`                                   | not sent                              |
| `timezone`    | `string`                                   | not sent                              |
| `realtimeUrl` | `string`                                   | whatever `init` reports               |

`ChatlyCoreOptions` extends it — realtime, parsing and the clock:

| option           | type                                      | default                             |
| ---------------- | ----------------------------------------- | ----------------------------------- |
| `socket`         | `SocketFactory`                           | **omitted → the core polls**        |
| `pollIntervalMs` | `number`                                  | 6000, floored at 2000               |
| `readBlocks`     | `(raw: unknown) => BlockEnvelope \| null` | the envelope reader in this package |
| `now`            | `() => number`                            | `Date.now`                          |

Three of those deserve more than a table row.

**`socket` is a factory, and omitting it is a supported mode, not a
degradation to apologise for.** The core never imports a socket library — a
headless package that pulled in `socket.io-client` would cost every host the
transport whether or not it uses it, and a world engine may have its own. Pass
`socket.io-client`'s `io` (or anything shaped like `SocketFactory`) and the
conversation goes live over push; pass nothing and it polls. Polling is also
the automatic fallback when push cannot be set up at all, because a slow thread
is better than a dead one.

```ts
import { io } from 'socket.io-client';
import { createChatlyCore } from '@chatlychat/core';

const chatly = createChatlyCore({
  publicId: 'ch_pub_your_channel_id',
  fetch: globalThis.fetch.bind(globalThis),
  // A THUNK, not `localStorage` itself: reading that getter THROWS on an
  // opaque origin or with site data blocked, and a thunk moves the throw
  // inside the core's try/catch.
  storage: () => localStorage,
  socket: io,
});
```

**`storage` defaults to memory, and that is deliberate.** The core persists
nothing unless you hand it a store, because writing a visitor token on load —
before any consent decision — is a defect on a site that must not store
anything. With no store the session lives for the lifetime of the object: a
second call does not mint a second visitor, it is simply not remembered across
restarts. `createSafeStorage` is exported if you want the same
never-throws-falls-back-to-memory wrapper around something of your own.

**`fetch` is structural**, not the DOM `fetch` type:

```ts
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
```

`body` is `unknown` because the core hands your `fetch` either a JSON string
(every API call) or your opaque upload bytes (the presigned PUT) untouched.
Typing it as `BodyInit` would import a DOM type, which is the thing this
package does not do.

## A conversation

```ts
const conv = await chatly.startConversation('I need a hand with my order');

const stop = conv.subscribe(() => {
  const snapshot = conv.getSnapshot();
  // snapshot.messages, .typing, .connection, .loaded, .error, .agentReadUpTo
  // ...hand it to your renderer. Reference equality is a valid "changed?".
  void snapshot;
});

await conv.send('order #1182');
await conv.postback({ body: 'Track it', payload: { intent: 'track' } });
conv.setTyping(true);
await conv.markRead();
stop();
```

`Conversation` is a plain external store — `subscribe()` / `getSnapshot()` —
which is what a React hook, a game loop and an engine binding each want and
none of them has to adapt. The snapshot is replaced, never mutated, so
reference equality is a valid "did anything change".

The state machine you do not have to write: history is read first (`loaded`),
then the live channel opens; a reconnect re-reads the thread, because events
published while the socket was down are not replayed to a visitor; a sent
message appears at once as a `pending` row and is **replaced, not duplicated**,
by the server's copy; a failed send removes the row and throws, so you never
keep a bubble the server does not have.

Other verbs on a conversation: `react()`, `submitStep()`, `requestStep()`,
`reportAction()`, `upload()`, `refresh()`, `dismiss()`, `close()`.

On the core itself: `init()`, `identify()`, `listConversations()`,
`unreadCount()`, `track()`, `openConversation()`, `releaseConversation()`,
`startConversation()`, `close()`.

`openConversation()` is reference-counted and returns the **same** object for
one id, so two components cannot open two sockets for one thread. Match each
call with `releaseConversation()`.

## Identity

```ts
await chatly.identify({
  externalId: 'player-9381',
  name: 'Ada',
  // HMAC-SHA256(<channel IDV secret>, externalId), computed by YOUR server.
  // Never ship the secret in a client, a game build least of all.
  userHash: hashFromYourServer,
});
```

## Two credentials, never confused

`POST /v1/widget/init` returns a long-lived visitor token that rides every
REST body. The realtime gateway **does not accept it**. The realtime
credential is minted per conversation by `POST /v1/widget/realtime/token`, is
conversation-scoped with a 1h TTL, and is re-read per connect **attempt** —
a frozen auth object is replayed on reconnect and the socket dies silently for
the rest of the session. The core handles all of that; it is written down here
because four hand-written mobile SDKs got it wrong and each one shipped green.

## React

```ts
import { useConversation } from '@chatlychat/core/react';
```

`react` is an **optional** peer dependency. `useConversation`,
`useConversationSnapshot`, `useMessages` and `useTyping` live behind that entry
point so the core's main entry stays React-free.

## The 3D-world surface

A world host embeds this package rather than the 2D panel, and these three
pure functions are the whole of what it needs that a web page does not. All
three are synchronous, dependency-free and safe to call in a render.

```ts
import { embodiedAgent, resolveWorldPlacement, resolveWorldTheme } from '@chatlychat/core';

// Who is standing there and what are they doing — derived from the snapshot,
// never sent by the server. Four states: idle, listening, thinking, speaking.
const agent = embodiedAgent(conv.getSnapshot(), {
  presences: { '*': { name: 'Mia', description: 'a guide in a red jacket' } },
  visitorComposing: true,
});
// agent.state, agent.clip (your own animation name), agent.described

// Where the surface goes, resolved against what your host can actually do.
// An ABSENT ability means unknown, not unsupported, and there is no result
// that shows nothing.
const placement = resolveWorldPlacement(
  { anchor: 'agent', follow: 'lazy', distanceMetres: 1.2 },
  { anchors: ['viewer', 'agent'], hud: true },
);
// placement.mode, .anchor, .follow, .billboard, .distanceMetres, .changed[]

// One complete token set. A world has no cascade, so every token comes back
// filled.
const theme = resolveWorldTheme(
  { panelMaterial: 'glass', colorScheme: 'auto', darkTheme: { textColor: '#f8fafc' } },
  { scene: 'dark' },
);
```

Shared spaces (several visitors and an agent in one thread) are
`createSpaceClient()`; spatial voice is `VoiceSession` plus the signal codec in
`voice-signals`.

### Telling the bot what your world can do, and hearing it ask

```ts
await core.setSurface({
  kind: 'world',
  capabilities: [
    {
      name: 'world.walk_to',
      label: 'Take me there',
      unprompted: true, // the bot may fire it without a press
      equivalent: { kind: 'text', text: 'The shop is on level 2, by the lifts.' },
    },
  ],
  state: { room: 'lobby', near: ['red-jacket'] },
});

conv.onCapability(async (inv) => {
  // Your world acts on inv.args, or declines; `ok` is its answer.
  const ok = inv.capability === 'world.walk_to';
  await conv.reportAction({
    messageId: inv.messageId,
    actionId: inv.invocationId,
    status: ok ? 'done' : 'failed',
    ...(ok ? {} : { data: { refused: true } }),
  });
});
```

### The channel's look, a room's look, and the viewer's motion setting

```ts
await core.init();
const look = resolveWorldTheme(core.worldTheme ?? {}, {
  scene: 'dark',
  layers: [roomTheme], // a room's own look; Chatly stores no rooms
  reducedMotion: viewer.prefersReducedMotion, // always wins
});
```

### A reply's gesture

```ts
const cue = messageEmbodiment(message); // { expression: 'point', lookAt: { target: 'item', ref } }
const clip = expressionClip(presence, cue); // your rig's clip name, or null: play nothing
```

`WorldRenderers<N>` types the props a replaceable renderer receives
(`renderCard`, `renderPick`, `renderBubble`, `renderPanel`, `renderComposer`,
`renderAgent`). It is a contract only: this package draws nothing.

## Game engines

A Unity WebGL or Godot HTML5 export is a browser, so this package runs there
unchanged — the browser supplies `fetch`, `WebSocket` and `localStorage` as the
injected adapters. What it does not give you is the bridge between engine code
and JavaScript; that is `@chatlychat/game-bridge`, which is built on this
package and ships the `.jslib` plugin, the C# externs and the GDScript side.

A WebGL export is not a desktop or console build. For a native title you need
a visitor client in the engine's own language, which this package is not.

## License

MIT. © Chatly.

---

## About this repository

This is a **mirror**. `@chatlychat/core` is built from a private monorepo where the rest
of the platform, its migrations and its contract checks live, so a pull request here
cannot be merged directly — but a patch is still the fastest way to get something
fixed and we will port it with attribution.

What you can do here: read the source, run the tests, open an issue, or open a PR
and we will treat the diff as the proposal.

Not mirrored: src/package-shape.spec.ts — specs that assert a type restated here still
matches the monorepo's original, which is only a meaningful claim inside it. They
keep running there.

Issues: https://github.com/chatlychat/chatly-core/issues · Docs: https://chatlychat.com/docs
