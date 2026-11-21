/**
 * Formal Specification: Multi-User Google Drive Sync CRDT & Access-Role Policy
 *
 * Related ADR: adr/ADR-05-client-side-drive-oauth-and-conflict-safe-sync.md
 * Related ADR: adr/ADR-11-two-tier-formal-verification.md
 * Production implementation: src/drive/syncService.ts
 *
 * Mathematical Structure:
 * StoryTape's conflict-safe sync is a composition of two standard state-based CRDTs:
 *   1. G-Set (Grow-Only Set) of deletion tombstones `T ⊆ ChapterId`
 *      with join `T1 ∪ T2` and partial order `T1 ⊆ T2`.
 *   2. LWW-Element-Map (Last-Write-Wins Map) for chapter & book metadata
 *      with a strict total order on versions `(updatedAt, payloadRank)`:
 *        (t1, r1) ≻ (t2, r2)  ⟺  t1 > t2 ∨ (t1 = t2 ∧ r1 > r2)
 *   3. 2P-Set dominance rule: any chapter ID in `T1 ∪ T2` is permanently deleted
 *      and excluded from the live chapter map (Tombstone Permanence / No Resurrection).
 *
 * Together, `(BookReplica, ⊔)` forms a **Join-Semilattice**:
 *   - Idempotence:   A ⊔ A = A
 *   - Commutativity: A ⊔ B = B ⊔ A
 *   - Associativity: (A ⊔ B) ⊔ C = A ⊔ (B ⊔ C)
 * Which mathematically guarantees Strong Eventual Consistency (SEC): any two devices
 * that observe the same set of updates in ANY order converge to the exact same state.
 */

import type { DriveFileSummary } from '../../drive/driveClient';
import type { ShareAccessRole } from '../../types/models';

export interface LwwVersion {
  readonly updatedAt: number;
  /** Deterministic tie-breaker rank (abstracts lexicographical content key). */
  readonly payloadRank: number;
}

export interface AbstractBookReplica {
  readonly bookMeta: LwwVersion;
  /** Map from chapterId -> LWW version for live (non-tombstoned) chapters. */
  readonly chapters: Readonly<Record<string, LwwVersion>>;
  /** Sorted canonical array of tombstoned chapter IDs (G-Set). */
  readonly tombstones: readonly string[];
}

/**
 * Strict total-order comparison on LWW versions.
 * Returns true iff `remote` strictly beats `local`.
 */
export function specPreferRemoteLww(local: LwwVersion, remote: LwwVersion): boolean {
  if (remote.updatedAt !== local.updatedAt) {
    return remote.updatedAt > local.updatedAt;
  }
  return remote.payloadRank > local.payloadRank;
}

export function specJoinLww(a: LwwVersion, b: LwwVersion): LwwVersion {
  return specPreferRemoteLww(a, b) ? b : a;
}

/**
 * Normalizes a replica to canonical invariant form:
 *   - tombstones sorted & deduplicated
 *   - no tombstoned chapter appears in `chapters` (2P-Set invariant)
 */
export function normalizeReplica(replica: AbstractBookReplica): AbstractBookReplica {
  const tombstoneSet = new Set(replica.tombstones);
  const sortedTombstones = Array.from(tombstoneSet).sort();
  const liveChapters: Record<string, LwwVersion> = {};
  for (const id of Object.keys(replica.chapters).sort()) {
    if (!tombstoneSet.has(id)) {
      liveChapters[id] = replica.chapters[id];
    }
  }
  return {
    bookMeta: replica.bookMeta,
    chapters: liveChapters,
    tombstones: sortedTombstones,
  };
}

/**
 * Pure Join-Semilattice merge operator `A ⊔ B` for two book replicas.
 */
export function specMergeReplicas(
  rawA: AbstractBookReplica,
  rawB: AbstractBookReplica,
): AbstractBookReplica {
  const a = normalizeReplica(rawA);
  const b = normalizeReplica(rawB);

  const tombstoneSet = new Set<string>([...a.tombstones, ...b.tombstones]);
  const allChapterIds = Array.from(
    new Set([...Object.keys(a.chapters), ...Object.keys(b.chapters)]),
  ).sort();

  const mergedChapters: Record<string, LwwVersion> = {};
  for (const id of allChapterIds) {
    if (tombstoneSet.has(id)) continue;
    const chA = a.chapters[id];
    const chB = b.chapters[id];
    if (chA && chB) {
      mergedChapters[id] = specJoinLww(chA, chB);
    } else if (chA) {
      mergedChapters[id] = chA;
    } else if (chB) {
      mergedChapters[id] = chB;
    }
  }

  return {
    bookMeta: specJoinLww(a.bookMeta, b.bookMeta),
    chapters: mergedChapters,
    tombstones: Array.from(tombstoneSet).sort(),
  };
}

export function specReplicasEqual(
  a: AbstractBookReplica,
  b: AbstractBookReplica,
): boolean {
  const na = normalizeReplica(a);
  const nb = normalizeReplica(b);
  if (
    na.bookMeta.updatedAt !== nb.bookMeta.updatedAt ||
    na.bookMeta.payloadRank !== nb.bookMeta.payloadRank
  ) {
    return false;
  }
  if (na.tombstones.length !== nb.tombstones.length) return false;
  for (let i = 0; i < na.tombstones.length; i += 1) {
    if (na.tombstones[i] !== nb.tombstones[i]) return false;
  }
  const keysA = Object.keys(na.chapters);
  const keysB = Object.keys(nb.chapters);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    if (
      na.chapters[k].updatedAt !== nb.chapters[k].updatedAt ||
      na.chapters[k].payloadRank !== nb.chapters[k].payloadRank
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Generates a canonical small-scope domain of replicas for exhaustive Tier-1 proofs.
 * Covers: 2 chapter IDs (`c1`, `c2`), present/absent/tombstoned states, and both
 * distinct AND identical timestamps (exercising deterministic tie-breaking!).
 */
export function generateCanonicalReplicaDomain(): readonly AbstractBookReplica[] {
  const bookVersions: LwwVersion[] = [
    { updatedAt: 100, payloadRank: 1 },
    { updatedAt: 100, payloadRank: 2 },
    { updatedAt: 200, payloadRank: 1 },
  ];

  type ChapterSlot = 'absent' | 'tombstone' | LwwVersion;
  const chapterSlots: ChapterSlot[] = [
    'absent',
    'tombstone',
    { updatedAt: 100, payloadRank: 1 },
    { updatedAt: 100, payloadRank: 2 },
    { updatedAt: 200, payloadRank: 1 },
  ];

  const domain: AbstractBookReplica[] = [];
  for (const bookMeta of bookVersions) {
    for (const c1 of chapterSlots) {
      for (const c2 of chapterSlots) {
        const chapters: Record<string, LwwVersion> = {};
        const tombstones: string[] = [];

        if (c1 === 'tombstone') tombstones.push('c1');
        else if (c1 !== 'absent') chapters.c1 = c1;

        if (c2 === 'tombstone') tombstones.push('c2');
        else if (c2 !== 'absent') chapters.c2 = c2;

        domain.push(normalizeReplica({ bookMeta, chapters, tombstones }));
      }
    }
  }
  return domain;
}

// ============================================================================
// Access-Role Resolution & Read-Only Non-Interference Specification
// ============================================================================

export interface AccessRoleDecisionInput {
  readonly summaryPresent: boolean;
  readonly ownedByMe: boolean | undefined;
  readonly shared: boolean | undefined;
  readonly hasCapabilities: boolean;
  readonly canEdit: boolean | undefined;
  readonly canAddChildren: boolean | undefined;
  readonly fallback: ShareAccessRole;
}

/**
 * Declarative formal specification of StoryTape's Drive access-role resolution.
 * Mirrors `resolveAccessRole` in `src/drive/syncService.ts`.
 */
export function specResolveAccessRole(
  input: AccessRoleDecisionInput,
): ShareAccessRole {
  if (!input.summaryPresent) return input.fallback;
  if (input.ownedByMe === true) return 'owner';
  if (input.hasCapabilities) {
    const canWrite = input.canEdit === true || input.canAddChildren === true;
    return canWrite ? 'writer' : 'reader';
  }
  if (input.shared === true && input.ownedByMe === false) {
    return input.fallback === 'reader' ? 'reader' : 'writer';
  }
  return input.fallback;
}

/**
 * Read-only Listener Non-Interference Policy (ADR-05):
 * Only 'owner' and 'writer' roles are ever permitted to mutate Drive state.
 */
export function specCanWriteToDrive(role: ShareAccessRole): boolean {
  return role !== 'reader';
}

export function toDriveFileSummary(
  input: AccessRoleDecisionInput,
): DriveFileSummary | null {
  if (!input.summaryPresent) return null;
  return {
    id: 'folder-1',
    name: 'Shared Book',
    mimeType: 'application/vnd.google-apps.folder',
    ownedByMe: input.ownedByMe,
    shared: input.shared,
    capabilities: input.hasCapabilities
      ? {
          canEdit: input.canEdit,
          canAddChildren: input.canAddChildren,
        }
      : undefined,
  };
}

/**
 * Exhaustive truth-table generator covering 100% of possible combinations of
 * Drive API metadata fields and fallback roles.
 */
export function generateAllAccessRoleInputs(): readonly AccessRoleDecisionInput[] {
  const triBool: ReadonlyArray<boolean | undefined> = [undefined, false, true];
  const roles: readonly ShareAccessRole[] = ['owner', 'writer', 'reader'];
  const inputs: AccessRoleDecisionInput[] = [];

  // Case 1: summary is null/undefined
  for (const fallback of roles) {
    inputs.push({
      summaryPresent: false,
      ownedByMe: undefined,
      shared: undefined,
      hasCapabilities: false,
      canEdit: undefined,
      canAddChildren: undefined,
      fallback,
    });
  }

  // Case 2: summary present, without capabilities
  for (const ownedByMe of triBool) {
    for (const shared of triBool) {
      for (const fallback of roles) {
        inputs.push({
          summaryPresent: true,
          ownedByMe,
          shared,
          hasCapabilities: false,
          canEdit: undefined,
          canAddChildren: undefined,
          fallback,
        });
      }
    }
  }

  // Case 3: summary present, with capabilities
  for (const ownedByMe of triBool) {
    for (const shared of triBool) {
      for (const canEdit of triBool) {
        for (const canAddChildren of triBool) {
          for (const fallback of roles) {
            inputs.push({
              summaryPresent: true,
              ownedByMe,
              shared,
              hasCapabilities: true,
              canEdit,
              canAddChildren,
              fallback,
            });
          }
        }
      }
    }
  }

  return inputs;
}
