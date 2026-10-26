import { describe, expect, it } from 'vitest';

import {
  AGENT_PRESENCE_STATES,
  describePresence,
  describePresenceState,
  embodiedAgent,
  type AgentWorldPresence,
} from './world-presence.js';

import type { ConversationSnapshot } from './conversation.js';
import type { ConversationMessage, TypingState } from './types.js';

function message(over: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    body: 'hello',
    authorType: 'agent',
    createdAt: '2026-10-23T10:00:00.000Z',
    kind: 'text',
    bodyHtml: null,
    blocks: null,
    canvas: null,
    attachments: [],
    authorId: 'agent-1',
    streamState: null,
    hiddenFromContact: false,
    replyToMessageId: null,
    metadata: {},
    deletedAt: null,
    reactions: [],
    pending: false,
    ...over,
  };
}

function snapshot(over: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    conversationId: 'c1',
    messages: [message()],
    typing: null,
    connection: 'live',
    loaded: true,
    error: null,
    agentReadUpTo: null,
    ...over,
  };
}

const typing = (over: Partial<TypingState> = {}): TypingState => ({
  actorType: 'bot',
  actorId: 'bot-1',
  displayName: 'Mia',
  label: null,
  ...over,
});

const mia: AgentWorldPresence = {
  name: 'Mia',
  description: 'a guide in a red jacket',
  avatar: { url: 'https://cdn.test/mia.vrm', format: 'vrm' },
  clips: { speaking: 'Talk_01', idle: 'Idle_01' },
};

describe('the four states exist and nothing else does', () => {
  it('is exactly idle, listening, thinking, speaking', () => {
    expect([...AGENT_PRESENCE_STATES]).toEqual(['idle', 'listening', 'thinking', 'speaking']);
  });

  it('every state a snapshot can produce is one of the four', () => {
    const cases = [
      snapshot({ loaded: false }),
      snapshot({ messages: [] }),
      snapshot({ connection: 'closed' }),
      snapshot({ messages: [message({ streamState: 'streaming' })] }),
      snapshot({ typing: typing() }),
      snapshot({ messages: [message({ authorType: 'contact' })] }),
      snapshot(),
    ];
    for (const s of cases) {
      expect(AGENT_PRESENCE_STATES).toContain(embodiedAgent(s).state);
    }
  });
});

describe('idle', () => {
  it('is idle before history has loaded', () => {
    expect(embodiedAgent(snapshot({ loaded: false })).state).toBe('idle');
  });

  it('is idle with no messages', () => {
    expect(embodiedAgent(snapshot({ messages: [] })).state).toBe('idle');
  });

  it('is idle once the conversation is closed, even mid-stream', () => {
    const s = snapshot({
      connection: 'closed',
      messages: [message({ streamState: 'streaming' })],
    });
    expect(embodiedAgent(s).state).toBe('idle');
  });
});

describe('speaking beats everything below it', () => {
  it('a streaming agent message is speaking', () => {
    const s = snapshot({ messages: [message({ streamState: 'streaming' })] });
    expect(embodiedAgent(s).state).toBe('speaking');
  });

  it('a streaming bot message beats a concurrent typing event', () => {
    const s = snapshot({
      messages: [message({ authorType: 'bot', streamState: 'streaming' })],
      typing: typing(),
    });
    expect(embodiedAgent(s).state).toBe('speaking');
  });

  it('a streaming VISITOR message is not speaking: the visitor is not the agent', () => {
    const s = snapshot({
      messages: [message({ authorType: 'contact', streamState: 'streaming' })],
    });
    expect(embodiedAgent(s).state).toBe('thinking');
  });

  it('a completed agent message is not speaking', () => {
    const s = snapshot({ messages: [message({ streamState: 'complete' })] });
    expect(embodiedAgent(s).state).toBe('listening');
  });
});

describe('thinking', () => {
  it('a typing event is thinking', () => {
    expect(embodiedAgent(snapshot({ typing: typing() })).state).toBe('thinking');
  });

  it('a HUMAN agent typing is thinking too, not a separate state', () => {
    const s = snapshot({ typing: typing({ actorType: 'agent', actorId: 'agent-9' }) });
    expect(embodiedAgent(s).state).toBe('thinking');
  });

  it('typing beats the visitor composing: if both, the agent is mid-thought', () => {
    const s = snapshot({ typing: typing() });
    expect(embodiedAgent(s, { visitorComposing: true }).state).toBe('thinking');
  });

  it('the visitor having spoken last is thinking with no typing event at all', () => {
    const s = snapshot({ messages: [message({ authorType: 'contact' })] });
    expect(embodiedAgent(s).state).toBe('thinking');
  });

  it('a PENDING visitor row counts: the turn moves on send, not on acknowledgement', () => {
    const s = snapshot({
      messages: [message(), message({ id: 'm2', authorType: 'contact', pending: true })],
    });
    expect(embodiedAgent(s).state).toBe('thinking');
  });

  it('polling (no typing events) still reaches thinking', () => {
    const s = snapshot({
      connection: 'polling',
      messages: [message({ authorType: 'contact' })],
    });
    expect(embodiedAgent(s).state).toBe('thinking');
  });
});

describe('listening', () => {
  it('an answered thread awaiting the visitor is listening', () => {
    expect(embodiedAgent(snapshot()).state).toBe('listening');
  });

  it('the visitor composing is listening, even though they spoke last', () => {
    const s = snapshot({ messages: [message({ authorType: 'contact' })] });
    expect(embodiedAgent(s, { visitorComposing: true }).state).toBe('listening');
  });

  it('a system event last is listening, not thinking: nobody took a turn', () => {
    const s = snapshot({ messages: [message({ authorType: 'system', kind: 'system_event' })] });
    expect(embodiedAgent(s).state).toBe('listening');
  });
});

describe('which presence is chosen', () => {
  it('matches the acting agent by id', () => {
    const other: AgentWorldPresence = { name: 'Sam' };
    const s = snapshot({ typing: typing({ actorId: 'bot-1' }) });
    const agent = embodiedAgent(s, { presences: { 'bot-1': mia, 'agent-9': other } });
    expect(agent.presence?.name).toBe('Mia');
    expect(agent.actorId).toBe('bot-1');
    expect(agent.actorType).toBe('bot');
  });

  it("falls back to '*' for an actor with no presence of its own", () => {
    const s = snapshot({ typing: typing({ actorId: 'nobody-knows' }) });
    expect(embodiedAgent(s, { presences: { '*': mia } }).presence?.name).toBe('Mia');
  });

  it('prefers a per-id presence over the wildcard', () => {
    const star: AgentWorldPresence = { name: 'Fallback' };
    const s = snapshot({ typing: typing({ actorId: 'bot-1' }) });
    expect(embodiedAgent(s, { presences: { 'bot-1': mia, '*': star } }).presence?.name).toBe('Mia');
  });

  it('is null with no presences configured, and so is `described`', () => {
    const agent = embodiedAgent(snapshot());
    expect(agent.presence).toBeNull();
    expect(agent.described).toBeNull();
    expect(agent.clip).toBeNull();
  });

  it('a LIVE typing actor outranks the transcript: a human taking over a bot thread', () => {
    const s = snapshot({
      messages: [message({ authorType: 'bot', authorId: 'bot-1' })],
      typing: typing({ actorType: 'agent', actorId: 'agent-9', displayName: 'Dana' }),
    });
    const human: AgentWorldPresence = { name: 'Dana' };
    const agent = embodiedAgent(s, { presences: { 'bot-1': mia, 'agent-9': human } });
    expect(agent.presence?.name).toBe('Dana');
    expect(agent.displayName).toBe('Dana');
  });

  it('with no typing event, the newest SERVING author is the actor', () => {
    const s = snapshot({
      messages: [
        message({ id: 'm1', authorType: 'bot', authorId: 'bot-1' }),
        message({ id: 'm2', authorType: 'contact', authorId: 'contact-1' }),
      ],
    });
    const agent = embodiedAgent(s, { presences: { 'bot-1': mia } });
    expect(agent.actorId).toBe('bot-1');
    expect(agent.actorType).toBe('bot');
    // A message carries an authorId and no name, so there is nothing to show.
    expect(agent.displayName).toBeNull();
  });

  it('a thread with only visitor messages has no actor', () => {
    const s = snapshot({ messages: [message({ authorType: 'contact', authorId: 'c' })] });
    const agent = embodiedAgent(s);
    expect(agent.actorType).toBeNull();
    expect(agent.actorId).toBeNull();
  });
});

describe('clips are the host own names, per state', () => {
  it('gives the clip for the current state', () => {
    const s = snapshot({ messages: [message({ streamState: 'streaming' })] });
    expect(embodiedAgent(s, { presences: { '*': mia } }).clip).toBe('Talk_01');
  });

  it('is null for a state the presence did not name', () => {
    const s = snapshot({ messages: [message({ authorType: 'contact' })] });
    const agent = embodiedAgent(s, { presences: { '*': mia } });
    expect(agent.state).toBe('thinking');
    expect(agent.clip).toBeNull();
  });
});

describe('the non-spatial equivalent', () => {
  it('names the agent and describes the avatar', () => {
    expect(describePresence(mia)).toBe('Agent: Mia (a guide in a red jacket)');
  });

  it('omits empty parentheses when there is no description', () => {
    expect(describePresence({ name: 'Mia' })).toBe('Agent: Mia');
  });

  it('says what the agent is doing, which a narration user otherwise loses', () => {
    expect(describePresenceState(mia, 'thinking')).toBe(
      'Agent: Mia (a guide in a red jacket) — thinking',
    );
  });

  it('`described` on the embodied agent is the identity and the live state', () => {
    const s = snapshot({ messages: [message({ streamState: 'streaming' })] });
    expect(embodiedAgent(s, { presences: { '*': mia } }).described).toBe(
      'Agent: Mia (a guide in a red jacket) — speaking',
    );
  });

  it('calls a bot an agent: "bot" is a disclosure decision this does not make', () => {
    const s = snapshot({ typing: typing({ actorType: 'bot' }) });
    const agent = embodiedAgent(s, { presences: { '*': { name: 'Mia' } } });
    expect(agent.actorType).toBe('bot');
    expect(agent.described).toBe('Agent: Mia — thinking');
  });
});

describe('it is pure', () => {
  it('two calls on one snapshot agree, and neither touches the snapshot', () => {
    const s = snapshot({ typing: typing() });
    const before = JSON.stringify(s);
    expect(embodiedAgent(s, { presences: { '*': mia } })).toEqual(
      embodiedAgent(s, { presences: { '*': mia } }),
    );
    expect(JSON.stringify(s)).toBe(before);
  });
});
