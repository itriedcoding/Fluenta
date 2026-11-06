import { useEffect, useRef, useState } from 'react';
import { uploadFile } from '../lib/api';
import { notifyTyping, sendMessage, setReply, toastError, useStore } from '../lib/store';
import { EMOJI, cx, formatBytes } from '../lib/util';
import type { Channel, Message, Scope } from '../lib/types';
import { Icon, Spinner } from './ui';
import { ReplyBanner } from './MessageItem';

type PendingFile = {
  key: string;
  file: File;
  preview: string | null;
  progress: number;
  uploadId?: string;
  error?: string;
};

export function Composer({
  scope,
  channel,
  onSent,
}: {
  scope: Scope;
  channel?: Channel;
  onSent?: () => void;
}) {
  const replyTo = useStore((state) => state.replyTo);
  const me = useStore((state) => state.me);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showSlowmode, setShowSlowmode] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    textarea.current?.focus();
  }, [scope.kind, scope.id]);

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).slice(0, 5 - files.length);
    if (incoming.length === 0) return;
    const next = incoming.map((file) => ({
      key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 6)}`,
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      progress: 0,
    }));
    setFiles((current) => [...current, ...next].slice(0, 5));
  }

  function removeFile(key: string) {
    setFiles((current) => {
      const target = current.find((entry) => entry.key === key);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return current.filter((entry) => entry.key !== key);
    });
  }

  async function uploadAll(): Promise<string[]> {
    const ids: string[] = [];
    for (const entry of files) {
      if (entry.uploadId) {
        ids.push(entry.uploadId);
        continue;
      }
      try {
        const uploaded = await uploadFile(entry.file, (fraction) => {
          setFiles((current) => current.map((item) => (item.key === entry.key ? { ...item, progress: fraction } : item)));
        });
        ids.push(uploaded.id);
        setFiles((current) => current.map((item) => (item.key === entry.key ? { ...item, progress: 1, uploadId: uploaded.id } : item)));
      } catch (err) {
        setFiles((current) => current.map((item) => (item.key === entry.key ? { ...item, error: 'Upload failed' } : item)));
        throw err;
      }
    }
    return ids;
  }

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    const content = text.trim();
    if (!content && files.length === 0) return;
    if (sending) return;
    setSending(true);
    try {
      const attachmentIds = files.length > 0 ? await uploadAll() : [];
      await sendMessage({ content, attachmentIds, replyToId: replyTo?.id ?? null });
      setText('');
      files.forEach((entry) => entry.preview && URL.revokeObjectURL(entry.preview));
      setFiles([]);
      setEmojiOpen(false);
      onSent?.();
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }

  function insertEmoji(emoji: string) {
    const node = textarea.current;
    if (!node) {
      setText((current) => current + emoji);
      return;
    }
    const start = node.selectionStart ?? text.length;
    const end = node.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  const tooLong = text.length > 4000;
  const canAttach = !channel || channel.slowmode === 0;

  return (
    <div
      className={cx('composer-wrap', dragging && 'dragging')}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
      }}
    >
      {dragging && <div className="drop-overlay">Drop files to attach</div>}
      {replyTo && <ReplyBanner message={replyTo} onCancel={() => setReply(null)} />}

      {files.length > 0 && (
        <div className="composer-attachments">
          {files.map((entry) => (
            <div key={entry.key} className={cx('attachment-chip', entry.error && 'error')}>
              {entry.preview ? (
                <img src={entry.preview} alt="" />
              ) : (
                <span className="attachment-chip-icon"><Icon name="paperclip" size={16} /></span>
              )}
              <span className="attachment-chip-text">
                <strong>{entry.file.name}</strong>
                <span>{entry.error ? entry.error : entry.progress > 0 && entry.progress < 1 ? `${Math.round(entry.progress * 100)}%` : formatBytes(entry.file.size)}</span>
              </span>
              <button type="button" className="icon-btn icon-btn-sm" onClick={() => removeFile(entry.key)} aria-label="Remove attachment">
                <Icon name="close" size={13} />
              </button>
              {entry.progress > 0 && entry.progress < 1 && (
                <span className="attachment-progress" style={{ width: `${entry.progress * 100}%` }} />
              )}
            </div>
          ))}
        </div>
      )}

      <form className="composer" onSubmit={submit}>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="icon-btn composer-btn"
          title="Attach a file"
          onClick={() => fileInput.current?.click()}
          disabled={!canAttach}
        >
          <Icon name="paperclip" size={18} />
        </button>

        <div className="composer-input-wrap">
          <textarea
            ref={textarea}
            className="composer-input"
            value={text}
            rows={1}
            maxLength={4000}
            placeholder={
              replyTo
                ? `Reply to ${replyTo.author.displayName}…`
                : channel
                  ? `Message #${channel.name}`
                  : 'Write a message…'
            }
            onChange={(event) => {
              setText(event.target.value);
              notifyTyping();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            onPaste={(event) => {
              const pasted = Array.from(event.clipboardData.files);
              if (pasted.length > 0) {
                event.preventDefault();
                addFiles(pasted);
              }
            }}
          />
          {text.length > 3500 && (
            <span className={cx('composer-count', tooLong && 'over')}>{4000 - text.length}</span>
          )}
        </div>

        <div className="composer-tools">
          <div className="emoji-anchor">
            <button
              ref={emojiButton}
              type="button"
              className="icon-btn composer-btn"
              title="Emoji"
              onClick={() => setEmojiOpen((open) => !open)}
            >
              <Icon name="smile" size={18} />
            </button>
            {emojiOpen && (
              <div className="emoji-panel" onMouseLeave={() => setEmojiOpen(false)}>
                {EMOJI.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => insertEmoji(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="submit"
            className="btn btn-primary composer-send"
            disabled={sending || tooLong || (!text.trim() && files.length === 0)}
            title="Send message"
          >
            {sending ? <Spinner size={16} /> : <Icon name="send" size={16} />}
          </button>
        </div>
      </form>

      {channel && channel.slowmode > 0 && (
        <p className="composer-hint" onClick={() => setShowSlowmode((value) => !value)}>
          Slow mode is on · one message every {channel.slowmode}s
        </p>
      )}
      {showSlowmode && null}
      {me && text.length === 0 && files.length === 0 && (
        <p className="composer-hint subtle">Enter to send · Shift+Enter for a new line · drag files anywhere</p>
      )}
    </div>
  );
}
