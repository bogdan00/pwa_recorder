import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { BookProject, Recording } from '../types/models';
import {
  getPlaybackProgress,
  getProjectCover,
  getRecordingBlob,
  listProjectRecordings,
  putPlaybackProgress,
} from '../storage/db';
import { downloadCloudRecording } from '../drive/syncService';

export type PlaybackSpeed = 0.75 | 1 | 1.15 | 1.25 | 1.5;
export const PLAYBACK_SPEEDS: PlaybackSpeed[] = [0.75, 1, 1.15, 1.25, 1.5];

export type SleepTimerMode = 'off' | '10m' | '15m' | '30m' | 'end_of_chapter';

export interface PlayBookOptions {
  startRecordingId?: string;
  resumeSaved?: boolean;
  expand?: boolean;
}

export interface PlayerContextValue {
  project: BookProject | null;
  chapters: Recording[];
  currentIndex: number;
  currentRecording: Recording | null;
  coverUrl: string | null;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  playbackRate: PlaybackSpeed;
  sleepTimerMode: SleepTimerMode;
  sleepSecondsLeft: number | null;
  isExpanded: boolean;
  error: string | null;

  playBook: (project: BookProject, options?: PlayBookOptions) => Promise<void>;
  playChapter: (
    project: BookProject,
    chapters: Recording[],
    recordingId: string,
    expand?: boolean,
  ) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  seek: (seconds: number) => void;
  skipBy: (deltaSeconds: number) => void;
  nextChapter: () => Promise<void>;
  prevChapter: () => Promise<void>;
  setPlaybackRate: (rate: PlaybackSpeed) => void;
  cyclePlaybackRate: () => void;
  setSleepTimer: (mode: SleepTimerMode) => void;
  expandPlayer: () => void;
  collapsePlayer: () => void;
  closePlayer: () => void;
  pauseForRecording: () => void;
  refreshChaptersForProject: (projectId: string) => Promise<void>;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error('usePlayer must be used within PlayerProvider');
  }
  return ctx;
}

interface PlayerProviderProps {
  children: React.ReactNode;
  onProgressUpdated?: (progress: import('../types/models').PlaybackProgress) => void;
}

export const PlayerProvider: React.FC<PlayerProviderProps> = ({
  children,
  onProgressUpdated,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const coverUrlRef = useRef<string | null>(null);
  const sleepIntervalRef = useRef<number | null>(null);
  const lastSavedSecRef = useRef<number>(-10);
  const onProgressUpdatedRef = useRef(onProgressUpdated);
  onProgressUpdatedRef.current = onProgressUpdated;

  const [project, setProject] = useState<BookProject | null>(null);
  const [chapters, setChapters] = useState<Recording[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState<PlaybackSpeed>(1);
  const [sleepTimerMode, setSleepTimerModeState] =
    useState<SleepTimerMode>('off');
  const [sleepSecondsLeft, setSleepSecondsLeft] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for latest state inside DOM audio event callbacks
  const projectRef = useRef<BookProject | null>(null);
  const chaptersRef = useRef<Recording[]>([]);
  const currentIndexRef = useRef<number>(-1);
  const sleepModeRef = useRef<SleepTimerMode>('off');
  const rateRef = useRef<PlaybackSpeed>(1);

  projectRef.current = project;
  chaptersRef.current = chapters;
  currentIndexRef.current = currentIndex;
  sleepModeRef.current = sleepTimerMode;
  rateRef.current = playbackRate;

  const ensureAudioElement = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'metadata';
      audioRef.current = el;
    }
    return audioRef.current;
  }, []);

  const persistProgress = useCallback(
    async (
      projId: string,
      rec: Recording,
      posSec: number,
      durSec: number,
      markCompleted = false,
    ) => {
      try {
        const existing = await getPlaybackProgress(projId);
        const completedSet = new Set(existing?.completedRecordingIds ?? []);
        if (markCompleted) completedSet.add(rec.id);

        const nextProgress = {
          projectId: projId,
          recordingId: rec.id,
          positionSec: Math.max(0, posSec),
          durationSec: Math.max(durSec, rec.durationMs / 1000),
          completedRecordingIds: Array.from(completedSet),
          updatedAt: Date.now(),
        };
        await putPlaybackProgress(nextProgress);
        onProgressUpdatedRef.current?.(nextProgress);
      } catch {
        // Non-fatal
      }
    },
    [],
  );

  const updateMediaSession = useCallback(
    (proj: BookProject | null, rec: Recording | null, artUrl: string | null) => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
        return;
      }
      if (!proj || !rec) {
        navigator.mediaSession.metadata = null;
        return;
      }
      try {
        if (typeof MediaMetadata !== 'undefined') {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: rec.name,
            artist: proj.narrator || proj.author || 'StoryTape',
            album: proj.title,
            artwork: artUrl
              ? [{ src: artUrl, sizes: '512x512', type: 'image/jpeg' }]
              : undefined,
          });
        }
      } catch {
        // Ignore browser quirks
      }
    },
    [],
  );

  const loadCoverForProject = useCallback(async (proj: BookProject) => {
    if (coverUrlRef.current) {
      URL.revokeObjectURL(coverUrlRef.current);
      coverUrlRef.current = null;
    }
    if (!proj.hasCover) {
      setCoverUrl(null);
      return null;
    }
    try {
      const blob = await getProjectCover(proj.id);
      if (!blob) {
        setCoverUrl(null);
        return null;
      }
      const url = URL.createObjectURL(blob);
      coverUrlRef.current = url;
      setCoverUrl(url);
      return url;
    } catch {
      setCoverUrl(null);
      return null;
    }
  }, []);

  const loadAndPlayIndex = useCallback(
    async (
      proj: BookProject,
      list: Recording[],
      index: number,
      startOffsetSec = 0,
      autoPlay = true,
    ) => {
      if (index < 0 || index >= list.length) return;
      const rec = list[index];
      const audio = ensureAudioElement();

      setError(null);
      setIsLoading(true);
      setProject(proj);
      setChapters(list);
      setCurrentIndex(index);
      setDuration(rec.durationMs / 1000);
      setCurrentTime(startOffsetSec);

      let artUrl = coverUrlRef.current;
      if (projectRef.current?.id !== proj.id) {
        artUrl = await loadCoverForProject(proj);
      }
      updateMediaSession(proj, rec, artUrl);

      try {
        let blob = await getRecordingBlob(rec.id);
        if (!blob && rec.syncStatus === 'cloud_only') {
          blob = await downloadCloudRecording(rec.id);
        }
        if (!blob) {
          throw new Error(
            'Audio file is missing locally. Connect Google Drive to download it.',
          );
        }

        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        audio.volume = 1;
        audio.src = url;
        audio.playbackRate = rateRef.current;
        audio.load();

        if (startOffsetSec > 0.2) {
          const applySeek = () => {
            try {
              audio.currentTime = Math.min(
                startOffsetSec,
                Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.5) : startOffsetSec,
              );
            } catch {
              // Ignore seek before metadata
            }
          };
          if (audio.readyState >= 1) {
            applySeek();
          } else {
            audio.addEventListener('loadedmetadata', applySeek, { once: true });
          }
        }

        lastSavedSecRef.current = startOffsetSec;
        if (autoPlay) {
          try {
            await audio.play();
            setIsPlaying(true);
          } catch (playErr) {
            setIsPlaying(false);
            if (!(playErr instanceof Error && playErr.name === 'NotAllowedError')) {
              throw playErr;
            }
          }
        } else {
          setIsPlaying(false);
        }
        await persistProgress(proj.id, rec, startOffsetSec, rec.durationMs / 1000);
      } catch (err) {
        setIsPlaying(false);
        setError(
          err instanceof Error ? err.message : 'Unable to play audio file.',
        );
      } finally {
        setIsLoading(false);
      }
    },
    [ensureAudioElement, loadCoverForProject, persistProgress, updateMediaSession],
  );

  const playBook = useCallback(
    async (proj: BookProject, options: PlayBookOptions = {}) => {
      const list = await listProjectRecordings(proj.id);
      if (list.length === 0) return;

      let targetIndex = 0;
      let startSec = 0;

      if (options.startRecordingId) {
        const idx = list.findIndex((r) => r.id === options.startRecordingId);
        if (idx >= 0) targetIndex = idx;
      } else if (options.resumeSaved !== false) {
        const saved = await getPlaybackProgress(proj.id);
        if (saved) {
          const idx = list.findIndex((r) => r.id === saved.recordingId);
          if (idx >= 0) {
            targetIndex = idx;
            const recDur = list[idx].durationMs / 1000;
            startSec =
              saved.positionSec < Math.max(0, recDur - 2)
                ? saved.positionSec
                : 0;
          }
        }
      }

      if (options.expand) setIsExpanded(true);
      await loadAndPlayIndex(proj, list, targetIndex, startSec, true);
    },
    [loadAndPlayIndex],
  );

  const playChapter = useCallback(
    async (
      proj: BookProject,
      list: Recording[],
      recordingId: string,
      expand = false,
    ) => {
      const idx = list.findIndex((r) => r.id === recordingId);
      if (idx < 0) return;
      if (expand) setIsExpanded(true);

      // If tapping currently loaded chapter, just toggle play/pause
      if (
        projectRef.current?.id === proj.id &&
        chaptersRef.current[currentIndexRef.current]?.id === recordingId &&
        audioRef.current?.src
      ) {
        if (audioRef.current.paused) {
          await audioRef.current.play().catch(() => {});
          setIsPlaying(true);
        } else {
          audioRef.current.pause();
          setIsPlaying(false);
        }
        return;
      }

      await loadAndPlayIndex(proj, list, idx, 0, true);
    },
    [loadAndPlayIndex],
  );

  const togglePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    audio.volume = 1;
    if (audio.paused) {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Playback failed');
      }
    } else {
      audio.pause();
      setIsPlaying(false);
      const proj = projectRef.current;
      const rec = chaptersRef.current[currentIndexRef.current];
      if (proj && rec) {
        void persistProgress(proj.id, rec, audio.currentTime, audio.duration || rec.durationMs / 1000);
      }
    }
  }, [persistProgress]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const safeSec = Number.isFinite(seconds) ? seconds : 0;
    const maxDur = Number.isFinite(audio.duration) ? audio.duration : duration;
    const clamped = Math.max(0, Math.min(safeSec, Math.max(0, maxDur)));
    try {
      audio.currentTime = clamped;
    } catch {
      // Ignore if media not ready
    }
    setCurrentTime(clamped);
  }, [duration]);

  const skipBy = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current;
      const now = audio ? audio.currentTime : currentTime;
      seek(now + deltaSeconds);
    },
    [currentTime, seek],
  );

  const nextChapter = useCallback(async () => {
    const proj = projectRef.current;
    const list = chaptersRef.current;
    const idx = currentIndexRef.current;
    if (!proj || idx < 0 || idx + 1 >= list.length) return;
    await loadAndPlayIndex(proj, list, idx + 1, 0, true);
  }, [loadAndPlayIndex]);

  const prevChapter = useCallback(async () => {
    const proj = projectRef.current;
    const list = chaptersRef.current;
    const idx = currentIndexRef.current;
    const audio = audioRef.current;
    if (!proj || idx < 0) return;
    // Standard audiobook behavior: if > 3s into chapter, restart chapter; otherwise go previous
    if (audio && audio.currentTime > 3) {
      seek(0);
      return;
    }
    if (idx > 0) {
      await loadAndPlayIndex(proj, list, idx - 1, 0, true);
    } else {
      seek(0);
    }
  }, [loadAndPlayIndex, seek]);

  const setPlaybackRate = useCallback((rate: PlaybackSpeed) => {
    setPlaybackRateState(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, []);

  const cyclePlaybackRate = useCallback(() => {
    const idx = PLAYBACK_SPEEDS.indexOf(rateRef.current);
    const next = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
    setPlaybackRate(next);
  }, [setPlaybackRate]);

  const clearSleepInterval = useCallback(() => {
    if (sleepIntervalRef.current !== null) {
      window.clearInterval(sleepIntervalRef.current);
      sleepIntervalRef.current = null;
    }
  }, []);

  const setSleepTimer = useCallback(
    (mode: SleepTimerMode) => {
      if (mode !== 'off' && chaptersRef.current.length === 0) return;
      clearSleepInterval();
      setSleepTimerModeState(mode);
      if (audioRef.current) audioRef.current.volume = 1;

      if (mode === 'off' || mode === 'end_of_chapter') {
        setSleepSecondsLeft(null);
        return;
      }

      const minutes = mode === '10m' ? 10 : mode === '15m' ? 15 : 30;
      let remaining = minutes * 60;
      setSleepSecondsLeft(remaining);

      sleepIntervalRef.current = window.setInterval(() => {
        remaining -= 1;
        setSleepSecondsLeft(Math.max(0, remaining));

        // Gentle 3-second volume fade-out for bedtime stories
        if (audioRef.current && remaining <= 3 && remaining > 0) {
          audioRef.current.volume = Math.max(0.05, remaining / 3);
        }

        if (remaining <= 0) {
          clearSleepInterval();
          setSleepTimerModeState('off');
          setSleepSecondsLeft(null);
          if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.volume = 1;
          }
          setIsPlaying(false);
        }
      }, 1000);
    },
    [clearSleepInterval],
  );

  const pauseForRecording = useCallback(() => {
    const audio = audioRef.current;
    if (audio && !audio.paused) {
      audio.pause();
      setIsPlaying(false);
    }
    setIsExpanded(false);
  }, []);

  const closePlayer = useCallback(() => {
    clearSleepInterval();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setProject(null);
    setChapters([]);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setIsExpanded(false);
    setSleepTimerModeState('off');
    setSleepSecondsLeft(null);
    setError(null);
    updateMediaSession(null, null, null);
  }, [clearSleepInterval, updateMediaSession]);

  const refreshChaptersForProject = useCallback(async (projId: string) => {
    if (projectRef.current?.id !== projId) return;
    const currentRecId = chaptersRef.current[currentIndexRef.current]?.id;
    const updated = await listProjectRecordings(projId);
    setChapters(updated);
    if (currentRecId) {
      const nextIdx = updated.findIndex((r) => r.id === currentRecId);
      if (nextIdx >= 0) {
        setCurrentIndex(nextIdx);
      } else {
        closePlayer();
      }
    }
  }, [closePlayer]);

  // Attach persistent HTMLAudioElement listeners
  useEffect(() => {
    const audio = ensureAudioElement();

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      const proj = projectRef.current;
      const rec = chaptersRef.current[currentIndexRef.current];
      if (proj && rec && Math.abs(audio.currentTime - lastSavedSecRef.current) >= 3) {
        lastSavedSecRef.current = audio.currentTime;
        void persistProgress(
          proj.id,
          rec,
          audio.currentTime,
          Number.isFinite(audio.duration) ? audio.duration : rec.durationMs / 1000,
        );
      }
    };

    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    const onEnded = () => {
      const proj = projectRef.current;
      const list = chaptersRef.current;
      const idx = currentIndexRef.current;
      const finishedRec = list[idx];

      if (proj && finishedRec) {
        void persistProgress(
          proj.id,
          finishedRec,
          finishedRec.durationMs / 1000,
          finishedRec.durationMs / 1000,
          true,
        );
      }

      if (sleepModeRef.current === 'end_of_chapter') {
        setSleepTimerModeState('off');
        setSleepSecondsLeft(null);
        setIsPlaying(false);
        return;
      }

      if (proj && idx >= 0 && idx + 1 < list.length) {
        void loadAndPlayIndex(proj, list, idx + 1, 0, true);
      } else {
        setIsPlaying(false);
      }
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, [ensureAudioElement, loadAndPlayIndex, persistProgress]);

  // Wire OS Lock Screen / Headphone Media Session controls
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => {
        void togglePlayPause();
      });
      ms.setActionHandler('pause', () => {
        void togglePlayPause();
      });
      ms.setActionHandler('seekbackward', () => skipBy(-15));
      ms.setActionHandler('seekforward', () => skipBy(15));
      ms.setActionHandler('previoustrack', () => {
        void prevChapter();
      });
      ms.setActionHandler('nexttrack', () => {
        void nextChapter();
      });
    } catch {
      // Some browsers restrict specific action handlers
    }
  }, [nextChapter, prevChapter, skipBy, togglePlayPause]);

  // Cleanup URLs & timers on unmount
  useEffect(() => {
    return () => {
      clearSleepInterval();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
    };
  }, [clearSleepInterval]);

  const currentRecording =
    currentIndex >= 0 && currentIndex < chapters.length
      ? chapters[currentIndex]
      : null;

  const value = useMemo<PlayerContextValue>(
    () => ({
      project,
      chapters,
      currentIndex,
      currentRecording,
      coverUrl,
      isPlaying,
      isLoading,
      currentTime,
      duration,
      playbackRate,
      sleepTimerMode,
      sleepSecondsLeft,
      isExpanded,
      error,
      playBook,
      playChapter,
      togglePlayPause,
      seek,
      skipBy,
      nextChapter,
      prevChapter,
      setPlaybackRate,
      cyclePlaybackRate,
      setSleepTimer,
      expandPlayer: () => {
        if (chaptersRef.current.length > 0) setIsExpanded(true);
      },
      collapsePlayer: () => setIsExpanded(false),
      closePlayer,
      pauseForRecording,
      refreshChaptersForProject,
    }),
    [
      project,
      chapters,
      currentIndex,
      currentRecording,
      coverUrl,
      isPlaying,
      isLoading,
      currentTime,
      duration,
      playbackRate,
      sleepTimerMode,
      sleepSecondsLeft,
      isExpanded,
      error,
      playBook,
      playChapter,
      togglePlayPause,
      seek,
      skipBy,
      nextChapter,
      prevChapter,
      setPlaybackRate,
      cyclePlaybackRate,
      setSleepTimer,
      closePlayer,
      pauseForRecording,
      refreshChaptersForProject,
    ],
  );

  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
};
