import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActiveDraft,
  BookProject,
  PlaybackProgress,
  Recording,
} from '../types/models';
import {
  listAllRecordings,
  listDrafts,
  listPlaybackProgress,
  listProjects,
} from '../storage/db';

export function useLibraryData() {
  const [projects, setProjects] = useState<BookProject[]>([]);
  const [allRecordings, setAllRecordings] = useState<Recording[]>([]);
  const [progressList, setProgressList] = useState<PlaybackProgress[]>([]);
  const [drafts, setDrafts] = useState<ActiveDraft[]>([]);

  const reloadData = useCallback(async () => {
    const [proj, recs, prog, dr] = await Promise.all([
      listProjects(),
      listAllRecordings(),
      listPlaybackProgress(),
      listDrafts(),
    ]);
    setProjects(proj);
    setAllRecordings(recs);
    setProgressList(prog);
    setDrafts(dr);
  }, []);

  useEffect(() => {
    void reloadData();
  }, [reloadData]);

  const upsertProgress = useCallback((next: PlaybackProgress) => {
    setProgressList((prev) => {
      const rest = prev.filter((p) => p.projectId !== next.projectId);
      return [next, ...rest];
    });
  }, []);

  const removeProgress = useCallback((projectId: string) => {
    setProgressList((prev) => prev.filter((p) => p.projectId !== projectId));
  }, []);

  const recordingsByProject = useMemo(() => {
    const map = new Map<string, Recording[]>();
    for (const r of allRecordings) {
      const list = map.get(r.projectId) ?? [];
      list.push(r);
      map.set(r.projectId, list);
    }
    map.forEach((list) =>
      list.sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt),
    );
    return map;
  }, [allRecordings]);

  const progressByProject = useMemo(() => {
    const map = new Map<string, PlaybackProgress>();
    for (const p of progressList) map.set(p.projectId, p);
    return map;
  }, [progressList]);

  return {
    projects,
    allRecordings,
    progressList,
    drafts,
    recordingsByProject,
    progressByProject,
    reloadData,
    upsertProgress,
    removeProgress,
  };
}
