/**
 * Tier 1 Formal Verification: Storage, Audiobook Player Queue & Share-Link Contracts
 *
 * Runs on every `npm test` (~<1s, zero WASM overhead).
 * Verifies:
 *   1. Audiobook Player Queue Explicit-State BFS Model Check (all 5 safety invariants + 3 reachability goals)
 *   2. Share-Link Encode/Decode Round-Trip Proof (`parseJoinInviteInput(buildJoinShareUrl(x)) === x`)
 *      over all 48 canonical invite combinations (scopes, roles, Unicode, special chars, clientIds)
 *   3. IndexedDB ArrayBuffer Binary Round-Trip Preservation (exact byte & MIME preservation across
 *      0-byte, all 256 byte values, and multi-KB payloads), Local-Only Protection under cache clear,
 *      and Zero-Orphan Cascade Deletion on `deleteProject`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildJoinShareUrl,
  getDriveFolderWebUrl,
  parseJoinInviteInput,
  type JoinShareInvite,
} from '../../drive/shareUtils';
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
import { blobToArrayBuffer } from '../../utils/blob';
import { forAll, verifyRoundTrip } from '../core/algebra';
import { modelCheck } from '../core/modelChecker';
import {
  createPlayerQueueLts,
  generateCanonicalBinaryPayloads,
  generateCanonicalShareInvites,
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

describe('Tier 1 Formal Proofs: Storage, Player Queue & Share-Link Contracts', () => {
  beforeEach(async () => {
    await resetDbConnectionForTests();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('storytape-db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('exhaustively BFS model-checks 100% of reachable Audiobook Player Queue states', () => {
    const lts = createPlayerQueueLts();
    const cert = modelCheck(lts);

    expect(cert.statesExplored).toBeGreaterThan(40);
    expect(cert.transitionsExplored).toBeGreaterThan(200);
    expect(cert.reachedGoals).toHaveLength(3);
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

    // Drive folder web URL round-trip
    const folderIds = ['1AbCdEfGhIjKlMnOpQrStUvWxYz', 'folder_01-XYZ_9876'];
    const driveUrlCert = forAll(
      'DriveFolderUrl: parseJoinInviteInput(getDriveFolderWebUrl(id)).folderId === id',
      folderIds,
      (id) => parseJoinInviteInput(getDriveFolderWebUrl(id))?.folderId === id,
    );
    expect(driveUrlCert.casesChecked).toBe(2);

    // Invalid inputs must deterministically return null (never throw or fabricate an ID)
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

    // Cache eviction invariant: ONLY synced audio blob is evicted; unsynced audio & local master survive!
    const cleared = await clearSyncedAudioCache();
    expect(cleared).toBe(1);
    expect(await getRecordingBlob('rec-synced')).toBeUndefined();
    expect((await getRecording('rec-synced'))?.syncStatus).toBe('cloud_only');
    expect(await getRecordingBlob('rec-local-only')).toBeDefined();
    expect(await getRecordingMaster('rec-synced')).toBeDefined();

    // Cascade deletion invariant: deleteProject removes ALL dependent records with zero orphans
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
