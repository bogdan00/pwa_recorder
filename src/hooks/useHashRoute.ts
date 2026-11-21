import { useCallback, useEffect, useState } from 'react';
import {
  type JoinShareInvite,
  parseJoinInviteInput,
} from '../drive/shareUtils';

export type Route =
  | { view: 'library' }
  | { view: 'book'; projectId: string }
  | { view: 'compare'; projectId: string; recordingId: string }
  | { view: 'mic-compare' }
  | { view: 'record'; projectId: string; draftId?: string | null };

function parseHashRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);

  if (parts[0] === 'quality-lab' && parts[1] === 'mic-test') {
    return { view: 'mic-compare' };
  }
  if (parts[0] === 'book' && parts[1] && parts[2] === 'compare' && parts[3]) {
    return {
      view: 'compare',
      projectId: decodeURIComponent(parts[1]),
      recordingId: decodeURIComponent(parts[3]),
    };
  }
  if (parts[0] === 'book' && parts[1]) {
    return { view: 'book', projectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'record' && parts[1]) {
    const params = new URLSearchParams(queryPart || '');
    return {
      view: 'record',
      projectId: decodeURIComponent(parts[1]),
      draftId: params.get('draft') ?? undefined,
    };
  }
  return { view: 'library' };
}

function parseJoinInviteFromHash(): JoinShareInvite | null {
  if (typeof window === 'undefined') return null;
  if (!window.location.hash.includes('/join')) return null;
  return parseJoinInviteInput(window.location.hash);
}

function serializeRoute(route: Route): string {
  if (route.view === 'mic-compare') return '#/quality-lab/mic-test';
  if (route.view === 'compare') {
    return `#/book/${encodeURIComponent(route.projectId)}/compare/${encodeURIComponent(route.recordingId)}`;
  }
  if (route.view === 'book') {
    return `#/book/${encodeURIComponent(route.projectId)}`;
  }
  if (route.view === 'record') {
    const base = `#/record/${encodeURIComponent(route.projectId)}`;
    return route.draftId
      ? `${base}?draft=${encodeURIComponent(route.draftId)}`
      : base;
  }
  return '#/';
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHashRoute());
  const [pendingJoinInvite, setPendingJoinInvite] =
    useState<JoinShareInvite | null>(() => parseJoinInviteFromHash());

  const navigate = useCallback((next: Route) => {
    const hash = serializeRoute(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(next);
  }, []);

  const clearJoinHash = useCallback(() => {
    if (window.location.hash.includes('/join')) {
      window.location.hash = '#/';
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const invite = parseJoinInviteFromHash();
      if (invite) setPendingJoinInvite(invite);
      setRoute(parseHashRoute());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return {
    route,
    navigate,
    pendingJoinInvite,
    setPendingJoinInvite,
    clearJoinHash,
  };
}
