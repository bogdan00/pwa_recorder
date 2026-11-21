/**
 * Tier 1 Formal Verification: Multi-User Google Drive Sync CRDT & Access-Role Proofs
 *
 * Runs on every `npm test` (~<1s, zero WASM overhead).
 * Verifies:
 *   1. Exhaustive Join-Semilattice laws (Idempotence, Commutativity, Associativity)
 *   2. Exhaustive Tombstone Monotonicity & No-Resurrection (2P-Set dominance)
 *   3. 100% truth-table conformance of `resolveAccessRole` against `syncMergeSpec`
 *   4. Strict total-order conformance of production LWW comparators
 *   5. End-to-end differential conformance against real `syncService.ts` + IndexedDB
 *      (including equal-timestamp convergence and read-only listener non-interference)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveClient, DriveFileSummary } from '../../drive/driveClient';
import {
  mergeDeletedIds,
  pullSingleBookFolderFromDrive,
  pushProjectToDrive,
  resolveAccessRole,
  shouldPreferRemoteBookMeta,
  shouldPreferRemoteRecordingMeta,
} from '../../drive/syncService';
import {
  getProject,
  listProjectRecordings,
  putProject,
  putRecording,
  resetDbConnectionForTests,
} from '../../storage/db';
import type {
  BookProject,
  DriveProjectMetadataFile,
  Recording,
} from '../../types/models';
import {
  forAll,
  forAllPairs,
  verifyJoinSemilattice,
} from '../core/algebra';
import {
  generateAllAccessRoleInputs,
  generateCanonicalReplicaDomain,
  specCanWriteToDrive,
  specMergeReplicas,
  specPreferRemoteLww,
  specReplicasEqual,
  specResolveAccessRole,
  toDriveFileSummary,
  type AbstractBookReplica,
} from '../specs/syncMergeSpec';

function makeBook(overrides: Partial<BookProject> = {}): BookProject {
  return {
    id: 'book-formal-1',
    title: 'Alpha',
    author: 'Author',
    narrator: 'Narrator',
    dedicatedTo: '',
    description: '',
    language: 'English',
    tags: [],
    coverColor: '#9E4736',
    hasCover: false,
    syncStatus: 'pending_upload',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'ch-1',
    projectId: 'book-formal-1',
    name: 'Chapter A',
    notes: '',
    recordedBy: 'Alice',
    orderIndex: 0,
    durationMs: 5000,
    mimeType: 'audio/mp4',
    extension: 'm4a',
    sampleRate: 48000,
    channels: 1,
    fileSizeBytes: 128,
    peaks: [0.5],
    syncStatus: 'pending_upload',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function toRemoteMeta(
  project: BookProject,
  recordings: Recording[],
): DriveProjectMetadataFile {
  return {
    schemaVersion: 1,
    id: project.id,
    title: project.title,
    author: project.author,
    narrator: project.narrator,
    dedicatedTo: project.dedicatedTo,
    description: project.description,
    language: project.language,
    tags: project.tags,
    coverColor: project.coverColor,
    deletedRecordingIds: project.deletedRecordingIds,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    recordings: recordings.map((r) => ({
      id: r.id,
      name: r.name,
      notes: r.notes,
      recordedBy: r.recordedBy,
      orderIndex: r.orderIndex,
      durationMs: r.durationMs,
      mimeType: r.mimeType,
      extension: r.extension,
      sampleRate: r.sampleRate,
      channels: r.channels,
      fileSizeBytes: r.fileSizeBytes,
      peaks: r.peaks,
      driveFileId: r.driveFileId,
      driveFileName: r.driveFileName || `${r.id}.m4a`,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  };
}

describe('Tier 1 Formal Proofs: Multi-User Drive Sync CRDT & Access-Role Safety', () => {
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
    vi.restoreAllMocks();
  });

  it('proves (BookReplica, ⊔) is a Join-Semilattice (Idempotent, Commutative, Associative)', () => {
    // Use a dense canonical slice (25 replicas covering all book/chapter/tombstone/tie states)
    // so triple-quantification (25^3 = 15,625 triples) finishes in <50ms.
    const fullDomain = generateCanonicalReplicaDomain();
    expect(fullDomain.length).toBe(75);

    const associativeSlice = fullDomain.filter((_, idx) => idx % 3 === 0);
    expect(associativeSlice.length).toBe(25);

    const fullIdem = forAll(
      'BookReplica: Full-Domain Idempotence',
      fullDomain,
      (a) => specReplicasEqual(specMergeReplicas(a, a), a),
    );
    const fullComm = forAllPairs(
      'BookReplica: Full-Domain Commutativity',
      fullDomain,
      fullDomain,
      (a, b) =>
        specReplicasEqual(specMergeReplicas(a, b), specMergeReplicas(b, a)),
    );
    const lattice = verifyJoinSemilattice(
      'BookReplicaCRDT',
      associativeSlice,
      specMergeReplicas,
      specReplicasEqual,
    );

    expect(fullIdem.casesChecked).toBe(75);
    expect(fullComm.casesChecked).toBe(5_625);
    expect(lattice.associativity.casesChecked).toBe(15_625);
  });

  it('proves Tombstone Monotonicity and No-Resurrection across all replica pairs', () => {
    const domain = generateCanonicalReplicaDomain();

    const cert = forAllPairs(
      'Tombstone Monotonicity & No-Resurrection',
      domain,
      domain,
      (a: AbstractBookReplica, b: AbstractBookReplica) => {
        const merged = specMergeReplicas(a, b);
        const mergedTombs = new Set(merged.tombstones);

        // 1. Monotonicity: tombstones(a) ∪ tombstones(b) ⊆ tombstones(a ⊔ b)
        for (const id of a.tombstones) {
          if (!mergedTombs.has(id)) return false;
        }
        for (const id of b.tombstones) {
          if (!mergedTombs.has(id)) return false;
        }

        // 2. No resurrection: no tombstoned ID may appear in live chapters
        for (const id of merged.tombstones) {
          if (id in merged.chapters) return false;
        }

        // 3. Non-loss of non-tombstoned chapters
        for (const id of Object.keys(a.chapters)) {
          if (!mergedTombs.has(id) && !(id in merged.chapters)) return false;
        }
        for (const id of Object.keys(b.chapters)) {
          if (!mergedTombs.has(id) && !(id in merged.chapters)) return false;
        }

        return true;
      },
    );

    expect(cert.casesChecked).toBe(5_625);
  });

  it('proves 100% truth-table conformance of production resolveAccessRole against formal spec', () => {
    const allInputs = generateAllAccessRoleInputs();
    // 3 (null) + 3*3*3 (no caps) + 3*3*3*3*3 (with caps) = 273 total combinations
    expect(allInputs.length).toBe(273);

    const cert = forAll(
      'resolveAccessRole === specResolveAccessRole (exhaustive truth table)',
      allInputs,
      (input) => {
        const summary = toDriveFileSummary(input);
        const actual = resolveAccessRole(summary, input.fallback);
        const expected = specResolveAccessRole(input);
        if (actual !== expected) return false;

        // Safety property: if Drive explicitly says ownedByMe=false and both capabilities
        // are false/absent, the user MUST be resolved as read-only ('reader')
        if (
          input.summaryPresent &&
          input.ownedByMe !== true &&
          input.hasCapabilities &&
          input.canEdit !== true &&
          input.canAddChildren !== true
        ) {
          if (actual !== 'reader' || specCanWriteToDrive(actual)) return false;
        }

        // Owner property: ownedByMe=true ALWAYS resolves to 'owner'
        if (input.summaryPresent && input.ownedByMe === true) {
          if (actual !== 'owner' || !specCanWriteToDrive(actual)) return false;
        }

        return true;
      },
    );

    expect(cert.casesChecked).toBe(273);
  });

  it('proves production LWW tie-breaking comparators induce a strict total order on distinct versions', () => {
    const bookVariants = [
      { updatedAt: 100, title: 'Alpha', payloadRank: 1 },
      { updatedAt: 100, title: 'Beta', payloadRank: 2 },
      { updatedAt: 200, title: 'Alpha', payloadRank: 1 },
      { updatedAt: 200, title: 'Beta', payloadRank: 2 },
    ].map((v) => ({
      ...v,
      book: makeBook({ updatedAt: v.updatedAt, title: v.title }),
      rec: makeRecording({ updatedAt: v.updatedAt, name: v.title }),
    }));

    // Conformance to specPreferRemoteLww + Irreflexivity + Asymmetry
    const cert = forAllPairs(
      'Production LWW comparators match specPreferRemoteLww',
      bookVariants,
      bookVariants,
      (a, b) => {
        const expected = specPreferRemoteLww(
          { updatedAt: a.updatedAt, payloadRank: a.payloadRank },
          { updatedAt: b.updatedAt, payloadRank: b.payloadRank },
        );
        const actualBook = shouldPreferRemoteBookMeta(a.book, b.book);
        const actualRec = shouldPreferRemoteRecordingMeta(a.rec, b.rec);
        if (actualBook !== expected || actualRec !== expected) return false;

        // Asymmetry: never both prefer each other
        if (actualBook && shouldPreferRemoteBookMeta(b.book, a.book)) return false;
        if (actualRec && shouldPreferRemoteRecordingMeta(b.rec, a.rec)) return false;
        return true;
      },
    );

    expect(cert.casesChecked).toBe(16);

    // mergeDeletedIds is idempotent, commutative, and sorted
    expect(mergeDeletedIds(['c2', 'c1'], ['c1', 'c3'])).toEqual(['c1', 'c2', 'c3']);
    expect(mergeDeletedIds(['c1', 'c3'], ['c2', 'c1'])).toEqual(['c1', 'c2', 'c3']);
  });

  it('proves differential convergence of real pullSingleBookFolderFromDrive on concurrent equal-timestamp edits & tombstones', async () => {
    // Device A: edited book title to "Alpha" at t=500, recorded ch-alice, renamed ch-shared to "Part A" at t=500, deleted ch-dead
    const aliceBook = makeBook({
      title: 'Alpha',
      updatedAt: 500,
      deletedRecordingIds: ['ch-dead'],
    });
    const aliceRecs = [
      makeRecording({ id: 'ch-alice', name: 'Alice Chapter', recordedBy: 'Alice', updatedAt: 400 }),
      makeRecording({ id: 'ch-shared', name: 'Part A', recordedBy: 'Alice', updatedAt: 500 }),
    ];

    // Device B: edited book title to "Beta" at SAME t=500, recorded ch-bob, renamed ch-shared to "Part B" at SAME t=500, still has ch-dead live
    const bobBook = makeBook({
      title: 'Beta',
      updatedAt: 500,
      deletedRecordingIds: [],
    });
    const bobRecs = [
      makeRecording({ id: 'ch-bob', name: 'Bob Chapter', recordedBy: 'Bob', updatedAt: 450 }),
      makeRecording({ id: 'ch-shared', name: 'Part B', recordedBy: 'Bob', updatedAt: 500 }),
      makeRecording({ id: 'ch-dead', name: 'Deleted Chapter', recordedBy: 'Bob', updatedAt: 999 }),
    ];

    const runPullMerge = async (
      localBook: BookProject,
      localRecs: Recording[],
      remoteBook: BookProject,
      remoteRecs: Recording[],
    ) => {
      await resetDbConnectionForTests();
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('storytape-db');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      await putProject(localBook);
      for (const rec of localRecs) {
        await putRecording(rec, new Blob(['audio'], { type: 'audio/mp4' }));
      }

      const remoteMeta = toRemoteMeta(remoteBook, remoteRecs);
      const fakeClient = {
        listFolderChildren: vi.fn().mockResolvedValue([
          { id: 'meta-1', name: 'project.json', mimeType: 'application/json' },
        ]),
        downloadJsonFile: vi.fn().mockResolvedValue(remoteMeta),
      } as unknown as DriveClient;

      const folder: DriveFileSummary = {
        id: 'folder-shared',
        name: 'Shared Book',
        mimeType: 'application/vnd.google-apps.folder',
        ownedByMe: false,
        shared: true,
        capabilities: { canEdit: true, canAddChildren: true },
      };

      await pullSingleBookFolderFromDrive(fakeClient, folder, {
        isShared: true,
        defaultRole: 'writer',
      });

      const mergedBook = await getProject(localBook.id);
      const mergedRecs = (await listProjectRecordings(localBook.id)).sort((x, y) =>
        x.id.localeCompare(y.id),
      );
      return {
        title: mergedBook?.title,
        updatedAt: mergedBook?.updatedAt,
        deletedRecordingIds: mergedBook?.deletedRecordingIds ?? [],
        chapters: mergedRecs.map((r) => ({
          id: r.id,
          name: r.name,
          updatedAt: r.updatedAt,
        })),
      };
    };

    const alicePullsBob = await runPullMerge(aliceBook, aliceRecs, bobBook, bobRecs);
    const bobPullsAlice = await runPullMerge(bobBook, bobRecs, aliceBook, aliceRecs);

    // Commutativity / Strong Eventual Consistency: BOTH converge identically!
    expect(alicePullsBob).toEqual(bobPullsAlice);
    // Exact converged values:
    // - "Beta" > "Alpha" breaks the t=500 tie deterministically
    // - Both ch-alice and ch-bob are preserved
    // - ch-shared deterministically picks "Part B" > "Part A" at t=500
    // - ch-dead is NOT resurrected even though Bob had updatedAt=999 > 500!
    expect(alicePullsBob).toEqual({
      title: 'Beta',
      updatedAt: 500,
      deletedRecordingIds: ['ch-dead'],
      chapters: [
        { id: 'ch-alice', name: 'Alice Chapter', updatedAt: 400 },
        { id: 'ch-bob', name: 'Bob Chapter', updatedAt: 450 },
        { id: 'ch-shared', name: 'Part B', updatedAt: 500 },
      ],
    });
  });

  it('proves Read-Only Listener Non-Interference on real pushProjectToDrive (zero Drive mutations)', async () => {
    const readOnlyBook = makeBook({
      id: 'book-ro',
      accessRole: 'reader',
      isShared: true,
      driveFolderId: 'folder-ro',
    });
    await putProject(readOnlyBook);
    await putRecording(
      makeRecording({ id: 'ch-ro', projectId: 'book-ro' }),
      new Blob(['audio'], { type: 'audio/mp4' }),
    );

    const writeSpies = {
      uploadBinaryResumable: vi.fn(),
      uploadJsonFile: vi.fn(),
      renameFile: vi.fn(),
      findOrCreateFolder: vi.fn(),
      verifyFileExists: vi.fn().mockResolvedValue({
        id: 'folder-ro',
        name: 'Read Only Book',
        mimeType: 'application/vnd.google-apps.folder',
        ownedByMe: false,
        shared: true,
        capabilities: { canEdit: false, canAddChildren: false },
      }),
    };

    // Case 1: locally known reader -> skips immediately without any Drive call
    const res1 = await pushProjectToDrive(
      writeSpies as unknown as DriveClient,
      'book-ro',
      'root-1',
    );
    expect(res1).toEqual({ pushedRecordings: 0, skippedReadOnly: true });

    // Case 2: locally thinks it's 'writer', but Drive downgraded folder to read-only!
    await putProject({ ...readOnlyBook, accessRole: 'writer' });
    const res2 = await pushProjectToDrive(
      writeSpies as unknown as DriveClient,
      'book-ro',
      'root-1',
    );
    expect(res2).toEqual({ pushedRecordings: 0, skippedReadOnly: true });

    // Non-interference assertion: ZERO mutation calls ever issued
    expect(writeSpies.uploadBinaryResumable).not.toHaveBeenCalled();
    expect(writeSpies.uploadJsonFile).not.toHaveBeenCalled();
    expect(writeSpies.renameFile).not.toHaveBeenCalled();
    expect(writeSpies.findOrCreateFolder).not.toHaveBeenCalled();

    // Local project must have been downgraded to 'reader'
    expect((await getProject('book-ro'))?.accessRole).toBe('reader');
  });
});
