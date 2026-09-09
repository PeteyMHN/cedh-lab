'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/store/gameStore';

export const ChatPanel = React.memo(function ChatPanel() {
  const chat = useGameStore((s) => s.chat);
  const sendChat = useGameStore((s) => s.sendChat);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chat, open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    sendChat(t);
    setText('');
  };

  return (
    <section aria-label="Table chat" className="rounded-lg border border-[#2a352e] bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Table chat, ${chat.length} messages`}
        className="flex w-full items-center justify-between p-2 text-xs font-bold uppercase tracking-wider text-gray-400"
      >
        <span>Chat · {chat.length}</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-[#2a352e] p-2">
          <div
            className="mb-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-xs"
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
          >
            {chat.length === 0 && <p className="italic text-gray-500">No messages yet.</p>}
            {chat.map((m, i) => (
              <p key={i}>
                <span className="font-bold text-seat0">{m.from}:</span>{' '}
                <span className="text-gray-200">{m.text}</span>
              </p>
            ))}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={submit} className="flex gap-1">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Say something…"
              aria-label="Chat message"
              className="min-w-0 flex-1 rounded border border-[#3a4a3f] bg-black/40 px-2 py-1 text-xs text-parchment"
            />
            <button
              type="submit"
              aria-label="Send chat message"
              className="rounded bg-seat0 px-2 py-1 text-xs font-bold text-black"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </section>
  );
});
