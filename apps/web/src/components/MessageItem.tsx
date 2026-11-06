import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteMessage,
  editMessage,
  openModal,
  setReply,
  toggleReaction,
  useStore,
} from '../lib/store';
import { formatBytes, formatTime, tokenize, cx, EMOJI } from '../lib/util';
import type { Attachment, Community, Member, Message } from '../lib/types';
import { Avatar, Icon } from './ui';

export function MessageItem({
  message,
  compact,
  meId,
  canManage,
  community,
  readers,
  onReply,
  onJumpTo,
}: {
  message: Message;
  compact: boolean;
  meId: string;
  canManage: boolean;
  community: Community | null;
  readers: Member[];
  onReply: () => void;
  onJumpTo: (id: string) => void;
}) {
  const people = useStore((state) => state.people);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const mine = message.author.id === meId;
  const deleted = Boolean(message.deletedAt);
  const author = people[message.author.id];
  const name = author?.displayName ?? message.author.displayName;
  const avatarUrl = author?.avatarUrl ?? message.author.avatarUrl;

  const roleColor = useMemo(() => {
    if (!community) return undefined;
    const member = community.members.find((entry) => entry.userId === message.author.id);
    if (!member) return undefined;
    const roles = member.roles
      .map((roleId) => community.roles.find((role) => role.id === roleId))
      .filter((role): role is NonNullable<typeof role> => Boolean(role))
      .sort((a, b) => b.position - a.position);
    return roles.find((role) => !role.isDefault)?.color;
  }, [community, message.author.id]);

  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      editRef.current?.setSelectionRange(draft.length, draft.length);
    }
  }, [editing, draft.length]);

  async function saveEdit() {
    const next = draft.trim();
    if (!next) return;
    setEditing(false);
    if (next !== message.content) await editMessage(message.id, next);
  }

  return (
    <div
      id={`message-${message.id}`}
      className={cx('message', compact && 'compact', message.pending && 'pending', message.failed && 'failed', deleted && 'is-deleted')}
      onDoubleClick={() => !deleted && onReply()}
    >
      {message.replyTo && !deleted && (
        <button type="button" className="reply-ref" onClick={() => onJumpTo(message.replyTo!.id)}>
          <Icon name="reply" size={12} />
          <span className="reply-author">{message.replyTo.author.displayName}</span>
          <span className="reply-text">{message.replyTo.content}</span>
        </button>
      )}

      <div className="message-row">
        {compact ? (
          <span className="message-gutter">{formatTime(message.createdAt)}</span>
        ) : (
          <button
            type="button"
            className="message-avatar"
            onClick={() => openModal({ kind: 'profile', userId: message.author.id })}
          >
            <Avatar name={name} url={avatarUrl} id={message.author.id} size={38} />
          </button>
        )}

        <div className="message-body">
          {!compact && (
            <div className="message-meta">
              <button
                type="button"
                className="message-author"
                style={roleColor ? { color: roleColor } : undefined}
                onClick={() => openModal({ kind: 'profile', userId: message.author.id })}
              >
                {name}
              </button>
              {community?.ownerId === message.author.id && (
                <span className="tag tag-owner" title="Community owner">
                  <Icon name="crown" size={10} /> owner
                </span>
              )}
              <time className="message-time" dateTime={new Date(message.createdAt).toISOString()}>
                {formatTime(message.createdAt)}
              </time>
              {message.editedAt && <span className="message-edited">(edited)</span>}
              {message.pending && <span className="message-edited">sending…</span>}
              {message.failed && <span className="message-failed">failed to send</span>}
            </div>
          )}

          {deleted ? (
            <p className="message-deleted">This message was deleted.</p>
          ) : editing ? (
            <div className="message-edit">
              <textarea
                ref={editRef}
                className="input textarea"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setDraft(message.content);
                    setEditing(false);
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void saveEdit();
                  }
                }}
                rows={Math.min(8, draft.split('\n').length + 1)}
              />
              <div className="message-edit-actions">
                <button type="button" className="link-btn" onClick={() => { setDraft(message.content); setEditing(false); }}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary btn-xs" onClick={() => void saveEdit()}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            message.content && (
              <div className="message-content">
                {tokenize(message.content).map((token, index) => {
                  switch (token.kind) {
                    case 'code':
                      return <code key={index}>{token.value}</code>;
                    case 'bold':
                      return <strong key={index}>{token.value}</strong>;
                    case 'italic':
                      return <em key={index}>{token.value}</em>;
                    case 'strike':
                      return <s key={index}>{token.value}</s>;
                    case 'link':
                      return (
                        <a key={index} href={token.href} target="_blank" rel="noopener noreferrer nofollow">
                          {token.value}
                        </a>
                      );
                    case 'mention':
                      return (
                        <span key={index} className="mention">
                          {token.value}
                        </span>
                      );
                    case 'everyone':
                      return (
                        <span key={index} className="mention mention-everyone">
                          {token.value}
                        </span>
                      );
                    case 'emoji':
                      return <span key={index}>{token.value}</span>;
                    default:
                      return <span key={index}>{token.value}</span>;
                  }
                })}
              </div>
            )
          )}

          {!deleted && message.attachments.length > 0 && (
            <div className={cx('attachments', message.attachments.every((file) => file.isImage) && 'attachments-grid')}>
              {message.attachments.map((file) => (
                <AttachmentView key={file.id} file={file} onOpen={() => setLightbox(file)} />
              ))}
            </div>
          )}

          {!deleted && (message.reactions.length > 0 || pickerOpen) && (
            <div className="reactions">
              {message.reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={cx('reaction', reaction.me && 'mine')}
                  onClick={() => void toggleReaction(message.id, reaction.emoji)}
                  title={reaction.users
                    .map((userId) => people[userId]?.displayName ?? 'Someone')
                    .join(', ')}
                >
                  <span>{reaction.emoji}</span>
                  <span className="reaction-count">{reaction.count}</span>
                </button>
              ))}
              {!pickerOpen && (
                <button type="button" className="reaction reaction-add" onClick={() => setPickerOpen(true)} title="Add reaction">
                  <Icon name="smile" size={13} />
                </button>
              )}
              {pickerOpen && (
                <div className="reaction-picker" onMouseLeave={() => setPickerOpen(false)}>
                  {EMOJI.slice(0, 12).map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        void toggleReaction(message.id, emoji);
                        setPickerOpen(false);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {readers.length > 0 && (
            <div className="read-receipt">
              <span className="read-avatars">
                {readers.slice(0, 3).map((member) => (
                  <Avatar key={member.userId} size={14} name={member.displayName} url={member.avatarUrl} id={member.userId} />
                ))}
              </span>
              Read by {readers.length === 1 ? readers[0].displayName : `${readers.length} people`}
            </div>
          )}
        </div>

        {!deleted && !editing && (
          <div className="message-actions">
            <button type="button" className="icon-btn icon-btn-sm" title="React" onClick={() => setPickerOpen(true)}>
              <Icon name="smile" size={15} />
            </button>
            <button type="button" className="icon-btn icon-btn-sm" title="Reply" onClick={onReply}>
              <Icon name="reply" size={15} />
            </button>
            {(mine || canManage) && (
              <button type="button" className="icon-btn icon-btn-sm" title="Edit" onClick={() => { setDraft(message.content); setEditing(true); }}>
                <Icon name="edit" size={15} />
              </button>
            )}
            {(mine || canManage) && (
              <button
                type="button"
                className="icon-btn icon-btn-sm danger"
                title="Delete"
                onClick={() =>
                  openModal({
                    kind: 'confirm',
                    title: 'Delete message',
                    message: 'This message will be removed for everyone. This cannot be undone.',
                    confirmLabel: 'Delete',
                    run: () => deleteMessage(message.id),
                  })
                }
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </div>
        )}
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-modal="true">
          <img src={lightbox.url} alt={lightbox.name} />
          <a className="lightbox-download" href={lightbox.url} download={lightbox.name} onClick={(event) => event.stopPropagation()}>
            <Icon name="download" size={16} /> Download
          </a>
          <button type="button" className="icon-btn lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </div>
      )}
    </div>
  );
}

function AttachmentView({ file, onOpen }: { file: Attachment; onOpen: () => void }) {
  if (file.isImage) {
    return (
      <button type="button" className="attachment-image" onClick={onOpen}>
        <img src={file.url} alt={file.name} loading="lazy" />
      </button>
    );
  }
  if (file.mime.startsWith('video/')) {
    return (
      <video className="attachment-video" src={file.url} controls preload="metadata">
        <track kind="captions" />
      </video>
    );
  }
  if (file.mime.startsWith('audio/')) {
    return <audio className="attachment-audio" src={file.url} controls preload="metadata" />;
  }
  return (
    <a className="attachment-file" href={file.url} download={file.name} target="_blank" rel="noreferrer">
      <span className="attachment-file-icon">
        <Icon name="paperclip" size={18} />
      </span>
      <span className="attachment-file-text">
        <strong>{file.name}</strong>
        <span>{formatBytes(file.size)}</span>
      </span>
      <Icon name="download" size={16} />
    </a>
  );
}

export function ReplyBanner({ message, onCancel }: { message: Message; onCancel: () => void }) {
  return (
    <div className="composer-reply">
      <Icon name="reply" size={14} />
      <span>
        Replying to <strong>{message.author.displayName}</strong> — {message.content.slice(0, 90) || 'attachment'}
      </span>
      <button type="button" className="icon-btn icon-btn-sm" onClick={onCancel} aria-label="Cancel reply">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function useReply() {
  const replyTo = useStore((state) => state.replyTo);
  return { replyTo, clear: () => setReply(null) };
}
