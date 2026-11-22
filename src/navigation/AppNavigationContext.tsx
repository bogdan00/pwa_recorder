import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  AppHistoryController,
  type BackGuard,
  type NavigationOverlay,
  type NavigationOverlayKind,
  type NavigationSnapshot,
  type Route,
} from './appHistory';
import type { JoinShareInvite } from '../drive/shareUtils';

export interface AppNavigationContextValue {
  snapshot: NavigationSnapshot;
  route: Route;
  overlays: NavigationOverlay[];
  pendingJoinInvite: JoinShareInvite | null;
  setPendingJoinInvite: (invite: JoinShareInvite | null) => void;
  clearJoinHash: () => void;
  navigate: (nextRoute: Route, overlays?: NavigationOverlay[]) => void;
  replace: (nextRoute: Route, overlays?: NavigationOverlay[]) => void;
  openOverlay: (overlay: NavigationOverlay) => void;
  updateOverlayInPlace: (overlay: NavigationOverlay) => void;
  replaceOverlays: (overlays: NavigationOverlay[]) => void;
  closeOverlay: (kind: NavigationOverlayKind) => void;
  pushTransient: (tag: string, onDismiss: () => void) => string;
  dismissTransient: (transientId: string) => void;
  goBackOrReplace: (fallbackRoute: Route) => void;
  unwindToRoute: (
    targetRoute: Route,
    options?: { unwindFromViews?: Route['view'][] },
  ) => void;
  registerBackGuard: (guard: BackGuard) => () => void;
}

const AppNavigationContext = createContext<AppNavigationContextValue | null>(
  null,
);

export const AppNavigationProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const controller = useMemo(() => new AppHistoryController(), []);

  useEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const value = useMemo<AppNavigationContextValue>(
    () => ({
      snapshot,
      route: snapshot.route,
      overlays: snapshot.overlays,
      pendingJoinInvite: snapshot.pendingJoinInvite,
      setPendingJoinInvite: (invite) => controller.setPendingJoinInvite(invite),
      clearJoinHash: () => controller.clearJoinHash(),
      navigate: (nextRoute, overlays) => controller.navigate(nextRoute, overlays),
      replace: (nextRoute, overlays) => controller.replace(nextRoute, overlays),
      openOverlay: (overlay) => controller.openOverlay(overlay),
      updateOverlayInPlace: (overlay) => controller.updateOverlayInPlace(overlay),
      replaceOverlays: (overlays) => controller.replaceOverlays(overlays),
      closeOverlay: (kind) => controller.closeOverlay(kind),
      pushTransient: (tag, onDismiss) => controller.pushTransient(tag, onDismiss),
      dismissTransient: (id) => controller.dismissTransient(id),
      goBackOrReplace: (fallbackRoute) =>
        controller.goBackOrReplace(fallbackRoute),
      unwindToRoute: (targetRoute, options) =>
        controller.unwindToRoute(targetRoute, options),
      registerBackGuard: (guard) => controller.registerBackGuard(guard),
    }),
    [controller, snapshot],
  );

  return (
    <AppNavigationContext.Provider value={value}>
      {children}
    </AppNavigationContext.Provider>
  );
};

export function useAppNavigation(): AppNavigationContextValue {
  const ctx = useContext(AppNavigationContext);
  if (!ctx) {
    throw new Error(
      'useAppNavigation must be used within AppNavigationProvider',
    );
  }
  return ctx;
}

/**
 * Optional navigation hook so components like PlayerProvider, ConfirmProvider,
 * and RecordingStudioView remain usable in standalone unit tests without a provider.
 */
export function useOptionalAppNavigation(): AppNavigationContextValue | null {
  return useContext(AppNavigationContext);
}
