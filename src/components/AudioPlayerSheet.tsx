import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ListMusic,
  Loader2,
  Moon,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import {
  type SleepTimerMode,
  usePlayer,
} from '../player/PlayerContext';
import { useOptionalAppNavigation } from '../navigation/AppNavigationContext';
import {
  formatBookNarrators,
  formatDurationMs,
  formatDurationSec,
} from '../utils/format';
import { BookCover } from './BookCover';
import './AudioPlayerSheet.css';

const SLEEP_OPTIONS: Array<{ mode: SleepTimerMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: '10m', label: '10 minutes' },
  { mode: '15m', label: '15 minutes' },
  { mode: '30m', label: '30 minutes' },
  { mode: 'end_of_chapter', label: 'End of current chapter' },
];

export const AudioPlayerSheet: React.FC = () => {
  const nav = useOptionalAppNavigation();
  const {
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
    playChapter,
    togglePlayPause,
    seek,
    skipBy,
    nextChapter,
    prevChapter,
    cyclePlaybackRate,
    setSleepTimer,
    collapsePlayer,
  } = usePlayer();

  const [localDrawer, setLocalDrawer] = useState<'none' | 'chapters' | 'sleep'>(
    'none',
  );

  const navDrawerOverlay = nav?.overlays.find(
    (o): o is { kind: 'player-drawer'; drawer: 'chapters' | 'sleep' } =>
      o.kind === 'player-drawer',
  );
  const drawer: 'none' | 'chapters' | 'sleep' = nav
    ? (navDrawerOverlay?.drawer ?? 'none')
    : localDrawer;

  const setDrawer = (
    next:
      | 'none'
      | 'chapters'
      | 'sleep'
      | ((prev: 'none' | 'chapters' | 'sleep') => 'none' | 'chapters' | 'sleep'),
  ) => {
    const resolved = typeof next === 'function' ? next(drawer) : next;
    if (!nav) {
      setLocalDrawer(resolved);
      return;
    }
    if (resolved === 'none') {
      nav.closeOverlay('player-drawer');
    } else {
      nav.openOverlay({ kind: 'player-drawer', drawer: resolved });
    }
  };

  const displayPeaks = useMemo(() => {
    const raw = currentRecording?.peaks ?? [];
    const target = 56;
    if (raw.length === 0) {
      return Array.from({ length: target }, () => 0.25);
    }
    if (raw.length <= target) return raw;
    const out: number[] = [];
    const step = raw.length / target;
    for (let i = 0; i < target; i += 1) {
      out.push(raw[Math.floor(i * step)] ?? 0.2);
    }
    return out;
  }, [currentRecording]);

  if (!isExpanded || !project || !currentRecording) {
    return null;
  }

  const safeDuration = Math.max(duration, currentRecording.durationMs / 1000, 0.1);
  const progressRatio = Math.min(1, Math.max(0, currentTime / safeDuration));
  const remainingSec = Math.max(0, safeDuration - currentTime);

  const sleepLabel =
    sleepTimerMode === 'off'
      ? 'Sleep'
      : sleepTimerMode === 'end_of_chapter'
        ? 'End of Ch.'
        : sleepSecondsLeft !== null
          ? formatDurationSec(sleepSecondsLeft)
          : sleepTimerMode;

  return (
    <div
      className="player-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Audiobook Player"
      data-testid="audio-player-sheet"
    >
      <div className="player-sheet__inner">
        {/* Top bar */}
        <div className="player-sheet__topbar">
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              if (!nav) setLocalDrawer('none');
              collapsePlayer();
            }}
            aria-label="Minimize player"
          >
            <ChevronDown size={24} />
          </button>

          <span className="player-sheet__counter">
            Chapter {currentIndex + 1} of {chapters.length}
          </span>

          <button
            type="button"
            className="icon-btn"
            onClick={() =>
              setDrawer((d) => (d === 'chapters' ? 'none' : 'chapters'))
            }
            aria-label="Chapters list"
          >
            <ListMusic size={20} />
          </button>
        </div>

        {/* Cover artwork */}
        <div className="player-sheet__artwork-wrap">
          <BookCover
            title={project.title}
            author={project.author}
            coverColor={project.coverColor}
            previewUrl={coverUrl}
            size="lg"
            className="player-sheet__cover"
          />
        </div>

        {/* Titles */}
        <div className="player-sheet__titles">
          <span className="player-sheet__book">{project.title}</span>
          <h2 className="player-sheet__chapter">{currentRecording.name}</h2>
          {(() => {
            const narratorLabel =
              currentRecording.recordedBy?.trim() || formatBookNarrators(chapters);
            if (!narratorLabel && !project.author) return null;
            return (
              <span className="player-sheet__narrator">
                {narratorLabel ? `Read by ${narratorLabel}` : project.author}
              </span>
            );
          })()}
        </div>

        {error && (
          <div className="player-sheet__error" role="alert">
            {error}
          </div>
        )}

        {/* Minimalistic scrub bar */}
        <div className="player-scrub">
          <div className="player-scrub__wave-box">
            <div className="player-scrub__peaks" aria-hidden="true">
              {displayPeaks.map((p, idx) => {
                const barRatio = (idx + 0.5) / displayPeaks.length;
                const played = barRatio <= progressRatio;
                const pctH = Math.max(12, Math.round(Math.pow(p, 0.7) * 100));
                return (
                  <span
                    key={idx}
                    className={`player-scrub__peak-bar ${played ? 'player-scrub__peak-bar--played' : ''}`}
                    style={{ height: `${pctH}%` }}
                  />
                );
              })}
            </div>
            <input
              type="range"
              className="player-scrub__range"
              min={0}
              max={safeDuration}
              step={0.25}
              value={Math.min(currentTime, safeDuration)}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Seek audiobook position"
            />
          </div>

          <div className="player-scrub__times">
            <span>{formatDurationSec(currentTime)}</span>
            <span>-{formatDurationSec(remainingSec)}</span>
          </div>
        </div>

        {/* Main transport controls */}
        <div className="player-transport">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void prevChapter()}
            aria-label="Previous chapter"
          >
            <SkipBack size={22} />
          </button>

          <button
            type="button"
            className="player-skip-btn"
            onClick={() => skipBy(-15)}
            aria-label="Rewind 15 seconds"
          >
            <RotateCcw size={20} />
            <span className="player-skip-btn__label">15s</span>
          </button>

          <button
            type="button"
            className="player-play-btn"
            onClick={() => void togglePlayPause()}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            id="player-sheet-play-btn"
          >
            {isLoading ? (
              <Loader2 size={30} className="spin" />
            ) : isPlaying ? (
              <Pause size={30} />
            ) : (
              <Play size={30} style={{ marginLeft: 3 }} />
            )}
          </button>

          <button
            type="button"
            className="player-skip-btn"
            onClick={() => skipBy(15)}
            aria-label="Forward 15 seconds"
          >
            <RotateCw size={20} />
            <span className="player-skip-btn__label">15s</span>
          </button>

          <button
            type="button"
            className="icon-btn"
            onClick={() => void nextChapter()}
            disabled={currentIndex >= chapters.length - 1}
            aria-label="Next chapter"
          >
            <SkipForward size={22} />
          </button>
        </div>

        {/* Minimal utility strip */}
        <div className="player-utilities">
          <button
            type="button"
            className={`player-util-btn font-mono ${playbackRate !== 1 ? 'player-util-btn--active' : ''}`}
            onClick={cyclePlaybackRate}
            aria-label={`Playback speed ${playbackRate}x`}
          >
            {playbackRate}×
          </button>

          <button
            type="button"
            className={`player-util-btn ${sleepTimerMode !== 'off' ? 'player-util-btn--active' : ''}`}
            onClick={() => setDrawer((d) => (d === 'sleep' ? 'none' : 'sleep'))}
            aria-label="Sleep timer"
          >
            <Moon size={15} />
            <span className={sleepSecondsLeft !== null ? 'font-mono' : ''}>
              {sleepLabel}
            </span>
          </button>

          <button
            type="button"
            className="player-util-btn"
            onClick={() =>
              setDrawer((d) => (d === 'chapters' ? 'none' : 'chapters'))
            }
          >
            <ListMusic size={15} />
            Chapters
          </button>
        </div>
      </div>

      {/* Sub-drawer: Chapters */}
      {drawer === 'chapters' && (
        <div className="player-subdrawer" role="region" aria-label="Chapters">
          <div className="sheet-header">
            <h3 className="sheet-title">Chapters</h3>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setDrawer('none')}
              aria-label="Close chapters"
            >
              <X size={18} />
            </button>
          </div>
          <div className="player-subdrawer__list">
            {chapters.map((ch, i) => (
              <button
                key={ch.id}
                type="button"
                className={`player-chapter-opt ${i === currentIndex ? 'player-chapter-opt--active' : ''}`}
                onClick={() => {
                  void playChapter(project, chapters, ch.id, true);
                  setDrawer('none');
                }}
              >
                <span>
                  {String(i + 1).padStart(2, '0')}. {ch.name}
                </span>
                <span className="font-mono" style={{ fontSize: 12 }}>
                  {formatDurationMs(ch.durationMs)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sub-drawer: Bedtime Sleep Timer */}
      {drawer === 'sleep' && (
        <div className="player-subdrawer" role="region" aria-label="Sleep Timer">
          <div className="sheet-header">
            <h3 className="sheet-title">Bedtime Sleep Timer</h3>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setDrawer('none')}
              aria-label="Close sleep timer"
            >
              <X size={18} />
            </button>
          </div>
          <div className="player-subdrawer__list">
            {SLEEP_OPTIONS.map((opt) => (
              <button
                key={opt.mode}
                type="button"
                className={`player-chapter-opt ${sleepTimerMode === opt.mode ? 'player-chapter-opt--active' : ''}`}
                onClick={() => {
                  setSleepTimer(opt.mode);
                  setDrawer('none');
                }}
              >
                <span>{opt.label}</span>
                {sleepTimerMode === opt.mode && <span>Active</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
