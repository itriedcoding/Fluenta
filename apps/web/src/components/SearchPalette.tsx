import { useEffect, useRef, useState } from 'react';
import { openModal, search, selectScope, setOverlay, startDm, toastError, useStore } from '../lib/store';
import type { SearchResults } from '../lib/types';
import { Avatar, Icon, Spinner } from './ui';
import { formatTimestamp } from '../lib/util';

export function SearchPalette() {
  const communities = useStore((state) => state.communities);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlay(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 2) {
      setResults(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    timer.current = setTimeout(async () => {
      try {
        const data = await search(query.trim());
        setResults(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setBusy(false);
      }
    }, 220);
    return () => timer.current && clearTimeout(timer.current);
  }, [query]);

  const total =
    (results?.messages.length ?? 0) +
    (results?.users.length ?? 0) +
    (results?.channels.length ?? 0) +
    (results?.communities.length ?? 0);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && setOverlay(null)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search messages, people, channels and communities"
          />
          {busy && <Spinner size={16} />}
          <button type="button" className="kbd" onClick={() => setOverlay(null)}>Esc</button>
        </div>

        <div className="palette-body">
          {error && <p className="auth-error">{error}</p>}
          {!results && !busy && (
            <div className="palette-hint">
              <p>Type at least two characters.</p>
              <ul>
                <li><Icon name="hash" size={14} /> Messages you can see across your channels</li>
                <li><Icon name="users" size={14} /> People you share a community with</li>
                <li><Icon name="compass" size={14} /> Your communities and channels</li>
              </ul>
            </div>
          )}
          {results && total === 0 && !busy && <p className="palette-empty">No results for “{query.trim()}”.</p>}

          {results && results.messages.length > 0 && (
            <section className="palette-section">
              <h4>Messages</h4>
              {results.messages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  className="palette-row"
                  onClick={() => {
                    const community = communities.find((c) => c.id === message.context.communityId);
                    if (community) {
                      setOverlay(null);
                      selectScope({ kind: 'channel', id: message.context.channelId });
                      setTimeout(() => {
                        const node = document.getElementById(`message-${message.id}`);
                        node?.scrollIntoView({ block: 'center' });
                        node?.classList.add('flash');
                        setTimeout(() => node?.classList.remove('flash'), 1400);
                      }, 350);
                    }
                  }}
                >
                  <Avatar size={28} name={message.author.displayName} url={message.author.avatarUrl} id={message.author.id} />
                  <span className="palette-row-text">
                    <span className="palette-row-title">
                      {message.author.displayName}
                      <small>#{message.context.channelName} · {message.context.communityName}</small>
                    </span>
                    <span className="palette-snippet">{stripMarkers(message.snippet)}</span>
                  </span>
                  <span className="palette-row-meta">{formatTimestamp(message.createdAt)}</span>
                </button>
              ))}
            </section>
          )}

          {results && results.users.length > 0 && (
            <section className="palette-section">
              <h4>People</h4>
              {results.users.map((user) => (
                <div key={user.id} className="palette-row">
                  <Avatar size={28} name={user.displayName} url={user.avatarUrl} id={user.id} presence={user.presence} />
                  <span className="palette-row-text">
                    <span className="palette-row-title">{user.displayName}<small>@{user.username}</small></span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-soft btn-xs"
                    onClick={async () => {
                      try {
                        await startDm(user.id);
                        setOverlay(null);
                      } catch (err) {
                        toastError(err);
                      }
                    }}
                  >
                    Message
                  </button>
                </div>
              ))}
            </section>
          )}

          {results && results.channels.length > 0 && (
            <section className="palette-section">
              <h4>Channels</h4>
              {results.channels.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  className="palette-row"
                  onClick={() => {
                    setOverlay(null);
                    selectScope({ kind: 'channel', id: channel.id });
                  }}
                >
                  <span className="palette-icon"><Icon name="hash" size={15} /></span>
                  <span className="palette-row-text">
                    <span className="palette-row-title">#{channel.name}<small>{channel.communityName}</small></span>
                  </span>
                </button>
              ))}
            </section>
          )}

          {results && results.communities.length > 0 && (
            <section className="palette-section">
              <h4>Communities</h4>
              {results.communities.map((community) => {
                const full = communities.find((entry) => entry.id === community.id);
                return (
                  <button
                    key={community.id}
                    type="button"
                    className="palette-row"
                    onClick={() => {
                      const channel = full?.channels.find((entry) => entry.type === 'text');
                      if (channel) {
                        setOverlay(null);
                        selectScope({ kind: 'channel', id: channel.id });
                      } else {
                        openModal({ kind: 'invite', communityId: community.id });
                      }
                    }}
                  >
                    {community.iconUrl ? (
                      <img src={community.iconUrl} alt="" className="palette-avatar" />
                    ) : (
                      <span className="palette-icon">{community.name.slice(0, 1).toUpperCase()}</span>
                    )}
                    <span className="palette-row-text">
                      <span className="palette-row-title">{community.name}</span>
                      <span className="palette-snippet">{community.description}</span>
                    </span>
                  </button>
                );
              })}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function stripMarkers(snippet: string) {
  return snippet.replace(/\u0001/g, '').replace(/\u0002/g, '');
}
