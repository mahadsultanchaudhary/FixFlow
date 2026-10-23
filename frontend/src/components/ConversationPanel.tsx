import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/types';

interface RecognitionAlternative { transcript: string }
interface RecognitionResult extends ArrayLike<RecognitionAlternative> { isFinal?: boolean }
interface RecognitionEvent { results: ArrayLike<RecognitionResult> }
interface BrowserRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionConstructor = new () => BrowserRecognition;
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

const suggestions = ['What am I waiting for?', 'Repair partner missed visit', 'Show repair history'];

export function ConversationPanel({
  messages,
  onSubmit,
  busy,
  connectionState,
}: {
  messages: ChatMessage[];
  onSubmit: (command: string) => void;
  busy: boolean;
  connectionState: 'connecting' | 'connected' | 'error';
}) {
  const [draft, setDraft] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceHint, setVoiceHint] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<BrowserRecognition | null>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => () => {
    recognitionRef.current?.stop();
  }, []);

  function submit(command = draft) {
    const trimmed = command.trim();
    if (!trimmed || busy) return;
    setDraft('');
    setVoiceHint('');
    onSubmit(trimmed);
  }

  function startVoiceSimulation() {
    if (busy) return;
    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setListening(true);
      setVoiceHint('Voice capture isn’t available in this browser. Type your request below; every demo action works without a microphone.');
      window.setTimeout(() => setListening(false), 1800);
      return;
    }

    try {
      const recognition = new Recognition();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        const phrase = event.results[0]?.[0]?.transcript?.trim();
        if (phrase) {
          setDraft(phrase);
          setVoiceHint(`Heard: “${phrase}”`);
          submit(phrase);
        }
      };
      recognition.onerror = () => {
        setVoiceHint('I couldn’t hear that clearly. Type your request instead.');
        setListening(false);
      };
      recognition.onend = () => setListening(false);
      recognitionRef.current = recognition;
      setListening(true);
      setVoiceHint('Listening… tell FixFlow what you need.');
      recognition.start();
    } catch {
      setListening(false);
      setVoiceHint('Voice capture could not start. Type your request below.');
    }
  }

  return (
    <section className="conversation-card" aria-label="Talk to FixFlow">
      <div className="conversation-heading">
        <div className="assistant-avatar"><span>✦</span><i /></div>
        <div className="conversation-title">
          <h3>Talk to FixFlow</h3>
          <span>Your household repairs, remembered.</span>
        </div>
        <button className={`mic-button ${listening ? 'mic-live' : ''}`} onClick={startVoiceSimulation} type="button" aria-label="Start voice interaction" title="Try voice input">
          <span aria-hidden="true">{listening ? '◉' : '♩'}</span>
        </button>
      </div>
      <div className="mcp-connection-line">
        <span className={`connection-dot connection-${connectionState}`} />
        {connectionState === 'connected' ? 'FixFlow is ready' : connectionState === 'connecting' ? 'Connecting to your household…' : 'Repair service unavailable'}
      </div>
      <div className="chat-messages" ref={listRef} aria-live="polite">
        {messages.map((message) => (
          <div className={`chat-row chat-${message.role}`} key={message.id}>
            {message.role === 'assistant' && <span className="chat-avatar">✦</span>}
            <div className="chat-bubble">
              <p>{message.content}</p>
              {message.timestamp && <time>{new Intl.DateTimeFormat('en-PK', { hour: 'numeric', minute: '2-digit' }).format(new Date(message.timestamp))}</time>}
            </div>
          </div>
        ))}
        {busy && <div className="chat-row chat-assistant"><span className="chat-avatar">✦</span><div className="chat-bubble typing-bubble"><span /><span /><span /></div></div>}
      </div>
      {voiceHint && <div className={`voice-hint ${listening ? 'voice-hint-live' : ''}`} role="status">{voiceHint}</div>}
      <div className="suggestion-chips" aria-label="Suggested commands">
        {suggestions.map((suggestion) => <button type="button" disabled={busy || connectionState !== 'connected'} key={suggestion} onClick={() => submit(suggestion)}>{suggestion}</button>)}
      </div>
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="sr-only" htmlFor="fixflow-command">Tell FixFlow what happened</label>
        <input
          id="fixflow-command"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Tell me what happened…"
          disabled={busy || connectionState !== 'connected'}
        />
        <button className="send-button" type="submit" disabled={busy || connectionState !== 'connected' || !draft.trim()} aria-label="Send message">↗</button>
      </form>
      <div className="composer-foot"><span aria-hidden="true">⌁</span> Your repair history stays saved. Visits and prices are simulated; FixFlow never processes payments.</div>
    </section>
  );
}
