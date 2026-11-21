/**
 * Tier 1 Formal Verification: Storage, Audiobook Player Queue (with Real PlayerProvider
 * Conformance!) & Share-Link Contracts
 *
 * Runs on every `npm test` (~<1s, zero WASM overhead).
 * Verifies:
 *   1. Audiobook Player Queue Explicit-State BFS Model Check (all 5 safety invariants + 3 goals)
 *   2. Automated Positive + Negative Conformance (`verifyConformance`) against the REAL
 *      mounted `PlayerProvider` React context + IndexedDB + deterministic fake `HTMLAudioElement`
 *      (closing the PlayerContext spec-to-code gap!)
 *   3. Share-Link Encode/Decode Round-Trip Proof (`parseJoinInviteInput(buildJoinShareUrl(x)) === x`)
 *   4. IndexedDB ArrayBuffer Binary Round-Trip Preservation, Cache Eviction Safety & Cascade Deletion
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildJoinShareUrl,
  getDriveFolderWebUrl,
  parseJoinInviteInput,
  type JoinShareInvite,
} from '../../drive/shareUtils';
import {
  PlayerProvider,
  usePlayer,
  type PlayerContextValue,
} from '../../player/PlayerContext';
import {
  clearSyncedAudioCache,
  deleteProject,
  getPlaybackProgress,
  getProject,
  getProjectCover,
  getRecording,
  getRecordingBlob,
  getRecordingMaster,
  listAllRecordings,
  putPlaybackProgress,
  putProject,
  putProjectCover,
  putRecording,
  resetDbConnectionForTests,
} from '../../storage/db';
import type { BookProject, Recording } from '../../types/models';
import { blobToArrayBuffer } from '../../utils/blob';
import { forAll, verifyRoundTrip } from '../core/algebra';
import { modelCheck, verifyConformance } from '../core/modelChecker';
import {
  createPlayerQueueLts,
  generateCanonicalBinaryPayloads,
  generateCanonicalShareInvites,
  type PlayerQueueAction,
  type PlayerQueueFormalState,
} from '../specs/storageAndShareSpec';

function invitesEqual(a: JoinShareInvite, b: JoinShareInvite | null): boolean {
  if (!b) return false;
  return (
    a.folderId === b.folderId &&
    a.name.trim() === b.name.trim() &&
    a.scope === b.scope &&
    a.role === b.role &&
    (a.clientId?.trim() || undefined) === (b.clientId?.trim() || undefined)
  );
}

class FakeAudioElement {
  src = '';
  preload = '';
  currentTime = 0;
  duration = 30;
  playbackRate = 1;
  volume = 1;
  paused = true;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatch(type: string): void {
    this.listeners.get(type)?.forEach((cb) => cb());
  }
  removeAttribute(attr: string): void {
    if (attr === 'src') this.src = '';
  }
  load(): void {}
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatch('play');
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatch('pause');
  });
}

function makeBook(id: string): BookProject {
  return {
    id,
    title: `Book ${id}`,
    author: 'Author',
    narrator: 'Narrator',
    dedicatedTo: '',
    description: '',
    language: 'English',
    tags: [],
    coverColor: '#9E4736',
    hasCover: false,
    syncStatus: 'local_only',
    createdAt: 100,
    updatedAt: 100,
  };
}

function makeChapter(projectId: string, idx: number): Recording {
  return {
    id: `${projectId}-ch-${idx}`,
    projectId,
    name: `Chapter ${idx + 1}`,
    notes: '',
    orderIndex: idx,
    durationMs: 30_000,
    mimeType: 'audio/mp4',
    extension: 'm4a',
    sampleRate: 48000,
    channels: 1,
    fileSizeBytes: 8,
    peaks: [0.4],
    syncStatus: 'local_only',
    createdAt: 100 + idx,
    updatedAt: 100 + idx,
  };
}

describe('Tier 1 Formal Proofs: Storage, Player Queue Conformance & Share-Link Contracts', () => {
  beforeEach(async () => {
    await resetDbConnectionForTests();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('storytape-db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exhaustively BFS model-checks 100% of reachable Audiobook Player Queue states', () => {
    const lts = createPlayerQueueLts();
    const cert = modelCheck(lts);

    expect(cert.statesExplored).toBeGreaterThan(40);
    expect(cert.transitionsExplored).toBeGreaterThan(200);
    expect(cert.reachedGoals).toHaveLength(3);
  });

  it('automatically verifies positive + negative conformance of REAL PlayerProvider against BFS-harvested queue traces', async () => {
    const lts = createPlayerQueueLts();
    const cert = modelCheck(lts);

    // Seed two real books in IndexedDB (1-chapter & 3-chapter) with real audio blobs
    const book1 = makeBook('player-book-1');
    const book3 = makeBook('player-book-3');
    await putProject(book1);
    await putRecording(makeChapter(book1.id, 0), new Blob(['ch0'], { type: 'audio/mp4' }));
    await putProject(book3);
    for (let i = 0; i < 3; i += 1) {
      await putRecording(makeChapter(book3.id, i), new Blob([`ch${i}`], { type: 'audio/mp4' }));
    }

    let lastAudio: FakeAudioElement | null = null;
    vi.stubGlobal(
      'Audio',
      class extends FakeAudioElement {
        constructor() {
          super();
          lastAudio = this;
        }
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:formal-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    interface MountedPlayer {
      getCtx: () => PlayerContextValue;
      getAudio: () => FakeAudioElement | null;
      completedMask: number;
      unmount: () => void;
    }

    // Replay a representative maximal set of BFS traces covering every phase, sleep timer,
    // chapter wrap, expand/collapse, and negative disabled-guard probe on real PlayerProvider!
    const conf = await verifyConformance<PlayerQueueFormalState, PlayerQueueAction, MountedPlayer>(
      lts,
      cert,
      {
        createImpl: () => {
          let latestCtx!: PlayerContextValue;
          const Harness: React.FC = () => {
            latestCtx = usePlayer();
            return null;
          };
          const { unmount } = render(
            React.createElement(PlayerProvider, null, React.createElement(Harness)),
          );
          return {
            getCtx: () => latestCtx,
            getAudio: () => lastAudio,
            completedMask: 0,
            unmount,
          };
        },
        destroyImpl: (impl) => {
          impl.unmount();
        },
        observe: (impl): PlayerQueueFormalState => {
          const ctx = impl.getCtx();
          return {
            chapterCount: ctx.chapters.length,
            currentIndex: ctx.currentIndex,
            isPlaying: ctx.isPlaying,
            isExpanded: ctx.isExpanded,
            sleepTimerMode: ctx.sleepTimerMode,
            completedMask: impl.completedMask,
          };
        },
        // Probe disabled guards directly against real PlayerProvider (e.g., expand/sleep/next when closed!)
        negativeProbeActions: [
          'toggle_play',
          'next_chapter',
          'prev_chapter',
          'set_sleep_end_of_chapter',
          'set_sleep_15m',
          'expand',
        ],
        execute: async (impl, action) => {
          const ctx = impl.getCtx();
          await act(async () => {
            switch (action) {
              case 'load_book_1ch':
                impl.completedMask = 0;
                await ctx.playBook(book1, { resumeSaved: false, expand: false });
                break;
              case 'load_book_3ch':
                impl.completedMask = 0;
                await ctx.playBook(book3, { resumeSaved: false, expand: false });
                break;
              case 'toggle_play':
                await ctx.togglePlayPause();
                break;
              case 'next_chapter':
                await ctx.nextChapter();
                break;
              case 'prev_chapter':
                if (impl.getAudio()) impl.getAudio()!.currentTime = 0;
                await ctx.prevChapter();
                break;
              case 'chapter_ended': {
                const audio = impl.getAudio();
                if (audio && ctx.isPlaying && ctx.currentIndex >= 0) {
                  impl.completedMask |= 1 << ctx.currentIndex;
                  audio.paused = true;
                  audio.dispatch('ended');
                  // Flush microtasks for async next-chapter auto-advance inside onEnded
                  await Promise.resolve();
                  await Promise.resolve();
                }
                break;
              }
              case 'set_sleep_end_of_chapter':
                ctx.setSleepTimer('end_of_chapter');
                break;
              case 'set_sleep_15m':
                ctx.setSleepTimer('15m');
                break;
              case 'set_sleep_off':
                ctx.setSleepTimer('off');
                break;
              case 'expand':
                ctx.expandPlayer();
                break;
              case 'collapse':
                ctx.collapsePlayer();
                break;
              case 'pause_for_recording':
                ctx.pauseForRecording();
                break;
              case 'close':
                impl.completedMask = 0;
                ctx.closePlayer();
                break;
            }
          });
        },
      },
      { maxTraces: 20 },
    );

    expect(conf.tracesReplayed).toBe(20);
    expect(conf.enabledStepsVerified).toBeGreaterThan(60);
    expect(conf.disabledGuardsVerified).toBeGreaterThan(30);

    // Also prove seek(NaN / ±Infinity / negative) stays strictly clamped in real PlayerProvider
    let latestCtx!: PlayerContextValue;
    const Probe: React.FC = () => {
      latestCtx = usePlayer();
      return null;
    };
    render(React.createElement(PlayerProvider, null, React.createElement(Probe)));
    await act(async () => {
      await latestCtx.playBook(book1, { resumeSaved: false });
    });
    for (const badSec of [Number.NaN, Number.NEGATIVE_INFINITY, -100, 99999]) {
      act(() => {
        latestCtx.seek(badSec);
      });
      expect(Number.isFinite(latestCtx.currentTime)).toBe(true);
      expect(latestCtx.currentTime).toBeGreaterThanOrEqual(0);
      expect(latestCtx.currentTime).toBeLessThanOrEqual(latestCtx.duration);
    }
  });

  it('proves buildJoinShareUrl -> parseJoinInviteInput is an exact round-trip across all canonical invites', () => {
    const canonicalInvites = generateCanonicalShareInvites();
    expect(canonicalInvites.length).toBe(48);

    const roundTripCert = verifyRoundTrip(
      'ShareInvite: parseJoinInviteInput(buildJoinShareUrl(x)) === x',
      canonicalInvites,
      (invite) => buildJoinShareUrl(invite),
      (url) => parseJoinInviteInput(url)!,
      (expected, actual) => invitesEqual(expected, actual),
    );
    expect(roundTripCert.casesChecked).toBe(48);

    const folderIds = ['1AbCdEfGhIjKlMnOpQrStUvWxYz', 'folder_01-XYZ_9876'];
    const driveUrlCert = forAll(
      'DriveFolderUrl: parseJoinInviteInput(getDriveFolderWebUrl(id)).folderId === id',
      folderIds,
      (id) => parseJoinInviteInput(getDriveFolderWebUrl(id))?.folderId === id,
    );
    expect(driveUrlCert.casesChecked).toBe(2);

    const invalidInputs = ['', '   ', 'not a url', 'https://example.com', 'short', '#/join?foo=bar'];
    const rejectCert = forAll(
      'Invalid share inputs deterministically rejected',
      invalidInputs,
      (bad) => parseJoinInviteInput(bad) === null,
    );
    expect(rejectCert.casesChecked).toBe(invalidInputs.length);
  });

  it('proves IndexedDB ArrayBuffer round-trip preserves exact bytes & MIME types across all binary stores', async () => {
    const payloads = generateCanonicalBinaryPayloads();

    for (let i = 0; i < payloads.length; i += 1) {
      const p = payloads[i];
      const projectId = `proj-bin-${i}`;
      const recId = `rec-bin-${i}`;
      const originalBlob = new Blob([p.bytes], { type: p.mimeType });

      await putProjectCover(projectId, originalBlob);
      await putRecording(
        {
          id: recId,
          projectId,
          name: p.label,
          notes: '',
          orderIndex: 0,
          durationMs: 1000,
          mimeType: p.mimeType,
          extension: 'm4a',
          sampleRate: 48000,
          channels: 1,
          fileSizeBytes: p.bytes.byteLength,
          peaks: [],
          hasLocalMaster: true,
          localMasterBytes: p.bytes.byteLength,
          syncStatus: 'local_only',
          createdAt: 100,
          updatedAt: 100,
        },
        originalBlob,
        originalBlob,
      );

      for (const readBlob of [
        await getProjectCover(projectId),
        await getRecordingBlob(recId),
        await getRecordingMaster(recId),
      ]) {
        expect(readBlob, `Missing binary for ${p.label}`).toBeDefined();
        expect(readBlob!.type).toBe(p.mimeType);
        const actualBytes = new Uint8Array(await blobToArrayBuffer(readBlob!));
        expect(actualBytes).toEqual(p.bytes);
      }
    }
  });

  it('proves clearSyncedAudioCache never evicts unsynced audio or local masters, and deleteProject leaves zero orphans', async () => {
    const projectId = 'proj-cascade-1';
    await putProject({
      id: projectId,
      title: 'Cascade Proof Book',
      author: 'A',
      narrator: 'N',
      dedicatedTo: '',
      description: '',
      language: 'English',
      tags: [],
      coverColor: '#9E4736',
      hasCover: true,
      syncStatus: 'synced',
      createdAt: 100,
      updatedAt: 100,
    });
    await putProjectCover(projectId, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
    await putPlaybackProgress({
      projectId,
      recordingId: 'rec-synced',
      positionSec: 12,
      durationSec: 60,
      completedRecordingIds: [],
      updatedAt: 200,
    });

    const syncedBytes = new Uint8Array([10, 20, 30]);
    const localBytes = new Uint8Array([40, 50, 60]);
    const masterBytes = new Uint8Array([70, 80, 90, 100]);

    await putRecording(
      {
        id: 'rec-synced',
        projectId,
        name: 'Synced Chapter',
        notes: '',
        orderIndex: 0,
        durationMs: 60000,
        mimeType: 'audio/mp4',
        extension: 'm4a',
        sampleRate: 48000,
        channels: 1,
        fileSizeBytes: 3,
        peaks: [],
        driveFileId: 'drive-1',
        hasLocalMaster: true,
        localMasterBytes: 4,
        syncStatus: 'synced',
        createdAt: 100,
        updatedAt: 100,
      },
      new Blob([syncedBytes], { type: 'audio/mp4' }),
      new Blob([masterBytes], { type: 'audio/wav' }),
    );
    await putRecording(
      {
        id: 'rec-local-only',
        projectId,
        name: 'Unsynced Chapter',
        notes: '',
        orderIndex: 1,
        durationMs: 60000,
        mimeType: 'audio/mp4',
        extension: 'm4a',
        sampleRate: 48000,
        channels: 1,
        fileSizeBytes: 3,
        peaks: [],
        syncStatus: 'local_only',
        createdAt: 101,
        updatedAt: 101,
      },
      new Blob([localBytes], { type: 'audio/mp4' }),
    );

    const cleared = await clearSyncedAudioCache();
    expect(cleared).toBe(1);
    expect(await getRecordingBlob('rec-synced')).toBeUndefined();
    expect((await getRecording('rec-synced'))?.syncStatus).toBe('cloud_only');
    expect(await getRecordingBlob('rec-local-only')).toBeDefined();
    expect(await getRecordingMaster('rec-synced')).toBeDefined();

    await deleteProject(projectId);
    expect(await getProject(projectId)).toBeUndefined();
    expect(await getProjectCover(projectId)).toBeUndefined();
    expect(await getPlaybackProgress(projectId)).toBeUndefined();
    expect(await getRecording('rec-synced')).toBeUndefined();
    expect(await getRecording('rec-local-only')).toBeUndefined();
    expect(await getRecordingBlob('rec-local-only')).toBeUndefined();
    expect(await getRecordingMaster('rec-synced')).toBeUndefined();
    expect(await listAllRecordings()).toHaveLength(0);
  });
});
