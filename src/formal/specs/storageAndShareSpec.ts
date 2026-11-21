/**
 * Formal Specification: Storage, Audiobook Player Queue & Share-Link Contracts
 *
 * Related ADR: adr/ADR-02-indexeddb-arraybuffer-storage-and-drafts.md
 * Related ADR: adr/ADR-06-shared-folder-unlock-with-google-picker.md
 * Related ADR: adr/ADR-08-persistent-player-and-media-session.md
 * Related ADR: adr/ADR-11-two-tier-formal-verification.md
 * Production implementations:
 *   - src/storage/db.ts
 *   - src/drive/shareUtils.ts
 *   - src/player/PlayerContext.tsx
 */

import type { JoinShareInvite, ShareScope } from '../../drive/shareUtils';
import type { SleepTimerMode } from '../../player/PlayerContext';
import type {
  LabeledTransitionSystem,
  ReachabilityGoal,
  SafetyInvariant,
} from '../core/modelChecker';

// ============================================================================
// 1. Audiobook Player Queue State Machine (LTS)
// ============================================================================

export interface PlayerQueueFormalState {
  readonly chapterCount: number; // 0 when closed, > 0 when book loaded
  readonly currentIndex: number; // -1 when closed, 0..chapterCount-1 when loaded
  readonly isPlaying: boolean;
  readonly isExpanded: boolean;
  readonly sleepTimerMode: SleepTimerMode;
  readonly completedMask: number; // bitmask of completed chapters
}

export type PlayerQueueAction =
  | 'load_book_1ch'
  | 'load_book_3ch'
  | 'toggle_play'
  | 'next_chapter'
  | 'prev_chapter'
  | 'chapter_ended'
  | 'set_sleep_end_of_chapter'
  | 'set_sleep_15m'
  | 'set_sleep_off'
  | 'expand'
  | 'collapse'
  | 'pause_for_recording'
  | 'close';

export const PLAYER_INITIAL_STATE: PlayerQueueFormalState = {
  chapterCount: 0,
  currentIndex: -1,
  isPlaying: false,
  isExpanded: false,
  sleepTimerMode: 'off',
  completedMask: 0,
};

export const PLAYER_QUEUE_INVARIANTS: readonly SafetyInvariant<PlayerQueueFormalState>[] =
  [
    {
      name: 'closed_iff_no_chapters_and_index_minus_one',
      check: (s) => (s.chapterCount === 0) === (s.currentIndex === -1),
    },
    {
      name: 'index_strictly_in_chapter_bounds',
      check: (s) =>
        s.chapterCount === 0 ||
        (s.currentIndex >= 0 && s.currentIndex < s.chapterCount),
    },
    {
      name: 'playing_requires_loaded_chapter',
      check: (s) => !s.isPlaying || s.currentIndex >= 0,
    },
    {
      name: 'expanded_requires_loaded_book',
      check: (s) => !s.isExpanded || s.chapterCount > 0,
    },
    {
      name: 'completed_mask_within_chapter_count',
      check: (s) => (s.completedMask >> s.chapterCount) === 0,
    },
  ];

export const PLAYER_QUEUE_GOALS: readonly ReachabilityGoal<PlayerQueueFormalState>[] =
  [
    {
      name: 'can_advance_to_final_chapter',
      check: (s) => s.chapterCount === 3 && s.currentIndex === 2 && s.isPlaying,
    },
    {
      name: 'can_finish_chapter_and_stop_on_sleep_timer',
      check: (s) =>
        s.chapterCount > 0 &&
        !s.isPlaying &&
        s.sleepTimerMode === 'off' &&
        s.completedMask !== 0,
    },
    {
      name: 'can_expand_and_close_cleanly',
      check: (s) => s.chapterCount === 3 && s.isExpanded,
    },
  ];

export function stepPlayerQueue(
  s: PlayerQueueFormalState,
  action: PlayerQueueAction,
): PlayerQueueFormalState | null {
  switch (action) {
    case 'load_book_1ch':
      return {
        chapterCount: 1,
        currentIndex: 0,
        isPlaying: true,
        isExpanded: s.isExpanded,
        sleepTimerMode: s.sleepTimerMode,
        completedMask: 0,
      };
    case 'load_book_3ch':
      return {
        chapterCount: 3,
        currentIndex: 0,
        isPlaying: true,
        isExpanded: s.isExpanded,
        sleepTimerMode: s.sleepTimerMode,
        completedMask: 0,
      };
    case 'toggle_play':
      if (s.chapterCount === 0) return null;
      return { ...s, isPlaying: !s.isPlaying };
    case 'next_chapter':
      if (s.chapterCount === 0 || s.currentIndex + 1 >= s.chapterCount) return null;
      return { ...s, currentIndex: s.currentIndex + 1, isPlaying: true };
    case 'prev_chapter':
      if (s.chapterCount === 0 || s.currentIndex <= 0) return null;
      return { ...s, currentIndex: s.currentIndex - 1, isPlaying: true };
    case 'chapter_ended': {
      if (!s.isPlaying || s.currentIndex < 0) return null;
      const nextMask = s.completedMask | (1 << s.currentIndex);
      if (s.sleepTimerMode === 'end_of_chapter') {
        return {
          ...s,
          isPlaying: false,
          sleepTimerMode: 'off',
          completedMask: nextMask,
        };
      }
      if (s.currentIndex + 1 < s.chapterCount) {
        return {
          ...s,
          currentIndex: s.currentIndex + 1,
          isPlaying: true,
          completedMask: nextMask,
        };
      }
      // Last chapter completed -> stop cleanly
      return {
        ...s,
        isPlaying: false,
        completedMask: nextMask,
      };
    }
    case 'set_sleep_end_of_chapter':
      if (s.chapterCount === 0) return null;
      return { ...s, sleepTimerMode: 'end_of_chapter' };
    case 'set_sleep_15m':
      if (s.chapterCount === 0) return null;
      return { ...s, sleepTimerMode: '15m' };
    case 'set_sleep_off':
      return { ...s, sleepTimerMode: 'off' };
    case 'expand':
      if (s.chapterCount === 0) return null;
      return { ...s, isExpanded: true };
    case 'collapse':
      return { ...s, isExpanded: false };
    case 'pause_for_recording':
      return { ...s, isPlaying: false };
    case 'close':
      return { ...PLAYER_INITIAL_STATE };
  }
}

export function createPlayerQueueLts(): LabeledTransitionSystem<
  PlayerQueueFormalState,
  PlayerQueueAction
> {
  return {
    name: 'AudiobookPlayerQueue',
    initialStates: [PLAYER_INITIAL_STATE],
    actions: [
      'load_book_1ch',
      'load_book_3ch',
      'toggle_play',
      'next_chapter',
      'prev_chapter',
      'chapter_ended',
      'set_sleep_end_of_chapter',
      'set_sleep_15m',
      'set_sleep_off',
      'expand',
      'collapse',
      'pause_for_recording',
      'close',
    ],
    step: stepPlayerQueue,
    serialize: (s) =>
      `${s.chapterCount}|${s.currentIndex}|${s.isPlaying ? 1 : 0}|${s.isExpanded ? 1 : 0}|${s.sleepTimerMode}|${s.completedMask}`,
    invariants: PLAYER_QUEUE_INVARIANTS,
    reachabilityGoals: PLAYER_QUEUE_GOALS,
    maxStates: 5_000,
  };
}

// ============================================================================
// 2. Share-Link Canonical Round-Trip Domain
// ============================================================================

export function generateCanonicalShareInvites(): readonly JoinShareInvite[] {
  const folderIds = ['1AbCdEfGhIjKlMnOpQrStUvWxYz', 'folder_01-XYZ_9876'];
  const names = [
    'Bedtime Stories',
    'Mom & Dad: Stories? #1',
    'Сказки & Contes 日本語',
  ];
  const scopes: readonly ShareScope[] = ['library', 'book'];
  const roles: ReadonlyArray<'writer' | 'reader'> = ['writer', 'reader'];
  const clientIds: ReadonlyArray<string | undefined> = [
    undefined,
    '123456-abc.apps.googleusercontent.com',
  ];

  const invites: JoinShareInvite[] = [];
  for (const folderId of folderIds) {
    for (const name of names) {
      for (const scope of scopes) {
        for (const role of roles) {
          for (const clientId of clientIds) {
            invites.push({ folderId, name, scope, role, clientId });
          }
        }
      }
    }
  }
  return invites;
}

// ============================================================================
// 3. IndexedDB Binary Storage Canonical Domain
// ============================================================================

export interface BinaryPayloadCase {
  readonly label: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}

export function generateCanonicalBinaryPayloads(): readonly BinaryPayloadCase[] {
  const allByteValues = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) allByteValues[i] = i;

  const multiKb = new Uint8Array(4096);
  for (let i = 0; i < multiKb.length; i += 1) {
    multiKb[i] = (i * 31 + 17) & 0xff;
  }

  return [
    { label: 'empty-audio', bytes: new Uint8Array(0), mimeType: 'audio/mp4' },
    { label: 'single-zero-byte', bytes: new Uint8Array([0]), mimeType: 'audio/webm' },
    { label: 'all-256-byte-values', bytes: allByteValues, mimeType: 'audio/wav' },
    { label: 'multi-kb-cover-jpeg', bytes: multiKb, mimeType: 'image/jpeg' },
  ];
}
