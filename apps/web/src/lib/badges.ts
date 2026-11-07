import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

export type BadgeDefinition = {
  key: string;
  name: string;
  description: string;
  howToEarn: string;
  color: string;
  icon: string;
  automatic: boolean;
};

type BadgeState = {
  catalog: BadgeDefinition[] | null;
  canGrant: boolean;
  loading: boolean;
  error: string | null;
};

let state: BadgeState = { catalog: null, canGrant: false, loading: false, error: null };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads the server's badge catalog once per session. */
export function loadBadges(force = false): void {
  if (state.loading) return;
  if (state.catalog && !force) return;
  state = { ...state, loading: true, error: null };
  emit();
  api<{ badges: BadgeDefinition[]; mine: string[]; canGrant: boolean }>('/api/badges')
    .then((data) => {
      state = { catalog: data.badges, canGrant: data.canGrant, loading: false, error: null };
      emit();
    })
    .catch((err) => {
      state = { ...state, loading: false, error: err instanceof Error ? err.message : 'Could not load badges' };
      emit();
    });
}

export function resetBadges(): void {
  state = { catalog: null, canGrant: false, loading: false, error: null };
  emit();
}

export function useBadgeCatalog(): BadgeState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    loadBadges();
  }, []);
  return snapshot;
}

export function badgeDefinition(key: string): BadgeDefinition | null {
  return state.catalog?.find((badge) => badge.key === key) ?? null;
}

export function badgeName(key: string): string {
  const definition = badgeDefinition(key);
  if (definition) return definition.name;
  return key
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function grantBadge(userId: string, key: string): Promise<string[]> {
  const result = await api<{ badges: string[] }>(`/api/badges/${encodeURIComponent(key)}/grant`, {
    method: 'POST',
    body: { userId },
  });
  return result.badges;
}

export async function revokeBadge(userId: string, key: string): Promise<string[]> {
  const result = await api<{ badges: string[] }>(
    `/api/badges/${encodeURIComponent(key)}/grant/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  return result.badges;
}
