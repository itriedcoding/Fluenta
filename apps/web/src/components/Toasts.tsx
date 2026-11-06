import { dismissToast, useStore } from '../lib/store';
import { Icon } from './ui';

export function Toasts() {
  const toasts = useStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <Icon name={toast.kind === 'error' ? 'close' : toast.kind === 'success' ? 'check' : 'bell'} size={16} />
          <span>{toast.message}</span>
          <button type="button" className="icon-btn icon-btn-sm" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
