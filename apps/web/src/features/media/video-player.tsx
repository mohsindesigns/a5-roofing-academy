import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Captions,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuTrigger, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { WatchTracker, type WatchReport } from './watch-tracker';

export interface PlayerCaption {
  language: string;
  label: string;
  url: string;
  isDefault?: boolean;
}

export interface PlayerChapter {
  startSeconds: number;
  title: string;
}

export interface PlayerSource {
  kind: 'hls' | 'progressive';
  url: string;
  posterUrl?: string | null;
  durationSeconds?: number | null;
  captions: PlayerCaption[];
  chapters: PlayerChapter[];
  resume?: { positionSeconds: number; watchedPercent: number; completed: boolean } | null;
}

export interface PlayerPolicy {
  allowSkipping: boolean;
  maxCreditedPlaybackRate: number;
}

export interface VideoPlayerHandle {
  seekTo(seconds: number): void;
}

interface VideoPlayerProps {
  source: PlayerSource;
  policy: PlayerPolicy;
  title: string;
  onReport?: (report: WatchReport, opts: { beacon: boolean }) => void;
  onEnded?: () => void;
  onTimeChange?: (seconds: number) => void;
  className?: string;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Training video player: HLS (hls.js loaded on demand where native HLS is missing), custom
 * accessible controls, captions, chapters, resume, optional no-skip, and watched-interval
 * telemetry. Video bytes stream from storage/CDN; this component never proxies media.
 */
export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  { source, policy, title, onReport, onEnded, onTimeChange, className },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef<WatchTracker | null>(null);
  const maxWatchedRef = useRef(source.resume?.positionSeconds ?? 0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(source.durationSeconds ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      const v = videoRef.current;
      if (!v) return;
      if (!policy.allowSkipping && seconds > maxWatchedRef.current + 1) {
        setNotice('Skipping ahead is turned off for this lesson.');
        return;
      }
      v.currentTime = seconds;
      void v.play();
    },
  }));

  // Source setup (HLS or progressive) and telemetry lifecycle.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let destroyed = false;
    let hls: { destroy(): void } | null = null;
    setError(null);
    setWaiting(true);
    if (source.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) {
          setError('This browser cannot play training videos. Update your browser and try again.');
          return;
        }
        const instance = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 30 });
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal)
            setError('The video could not be loaded. Check your connection and retry.');
        });
        instance.loadSource(source.url);
        instance.attachMedia(video);
        hls = instance;
      });
    } else {
      video.src = source.url;
    }
    trackerRef.current = onReport ? new WatchTracker({ send: onReport }) : null;
    const onHide = () => {
      if (document.visibilityState === 'hidden') trackerRef.current?.flush(true);
    };
    const onUnload = () => trackerRef.current?.flush(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onUnload);
    return () => {
      destroyed = true;
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onUnload);
      trackerRef.current?.dispose();
      trackerRef.current = null;
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
    // onReport is stable per lesson; re-create only when the media changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.url, source.kind]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    for (const track of Array.from(v.textTracks)) track.mode = captionsOn ? 'showing' : 'hidden';
  }, [captionsOn]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setControlsVisible(false);
    }, 2800);
  }, []);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => setError('Playback was blocked. Press play again.'));
    else v.pause();
  };

  const seekBy = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(v.duration || duration, v.currentTime + delta));
    if (!policy.allowSkipping && target > maxWatchedRef.current + 1) {
      setNotice('Skipping ahead is turned off for this lesson.');
      return;
    }
    v.currentTime = target;
  };

  const setSpeed = (next: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = next;
    setRate(next);
    if (next > policy.maxCreditedPlaybackRate) {
      setNotice(
        `Time watched above ${policy.maxCreditedPlaybackRate}× doesn't count toward completion.`,
      );
    }
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const key = e.key.toLowerCase();
    const handled: Record<string, () => void> = {
      ' ': toggle,
      k: toggle,
      j: () => seekBy(-10),
      arrowleft: () => seekBy(-5),
      l: () => seekBy(10),
      arrowright: () => seekBy(5),
      f: toggleFullscreen,
      m: () => {
        if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
      },
      c: () => setCaptionsOn((c) => !c),
    };
    if (
      handled[key] &&
      !(e.target instanceof HTMLButtonElement && (key === ' ' || key === 'enter'))
    ) {
      e.preventDefault();
      handled[key]();
      showControls();
    }
  };

  const progress = duration ? (time / duration) * 100 : 0;
  const watchedLimit = duration ? (Math.max(maxWatchedRef.current, time) / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label={`Video: ${title}`}
      onKeyDown={onKeyDown}
      onMouseMove={showControls}
      onFocus={showControls}
      className={cn(
        'group relative overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-focus',
        fullscreen ? 'h-full w-full' : 'aspect-video w-full sm:rounded-lg',
        className,
      )}
    >
      <video
        ref={videoRef}
        className="h-full w-full"
        poster={source.posterUrl ?? undefined}
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
        onClick={toggle}
        onPlay={() => {
          setPlaying(true);
          showControls();
        }}
        onPause={() => {
          setPlaying(false);
          setControlsVisible(true);
          trackerRef.current?.pause();
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDuration(v.duration);
          const resumeAt = source.resume?.positionSeconds ?? 0;
          if (resumeAt > 5 && resumeAt < v.duration - 10 && !source.resume?.completed) {
            v.currentTime = resumeAt;
            setNotice(`Resumed at ${formatClock(resumeAt)}`);
          }
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setTime(v.currentTime);
          onTimeChange?.(v.currentTime);
          if (!v.paused && v.currentTime <= maxWatchedRef.current + 2)
            maxWatchedRef.current = Math.max(maxWatchedRef.current, v.currentTime);
          trackerRef.current?.update(v.currentTime, !v.paused && !v.seeking, v.playbackRate);
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
        }}
        onSeeking={(e) => {
          const v = e.currentTarget;
          if (!policy.allowSkipping && v.currentTime > maxWatchedRef.current + 1) {
            v.currentTime = maxWatchedRef.current;
            setNotice('Skipping ahead is turned off for this lesson.');
          }
          trackerRef.current?.seek(v.currentTime);
        }}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onEnded={(e) => {
          trackerRef.current?.ended(e.currentTarget.duration);
          onEnded?.();
        }}
        onError={() => setError('The video could not be loaded. Check your connection and retry.')}
      >
        {source.captions.map((c) => (
          <track
            key={c.url}
            kind="captions"
            src={c.url}
            srcLang={c.language}
            label={c.label}
            default={c.isDefault}
          />
        ))}
      </video>

      {waiting && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/80">
          <Spinner size={28} label="Loading video" />
        </div>
      )}

      {!playing && !waiting && !error && (
        <button
          type="button"
          onClick={toggle}
          aria-label="Play"
          className="absolute top-1/2 left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
        >
          <Play className="ml-1 size-7" fill="currentColor" />
        </button>
      )}

      {error && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center text-white"
        >
          <p className="text-base">{error}</p>
          <button
            type="button"
            className="rounded border border-white/40 px-3 py-1.5 text-sm hover:bg-white/10"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      )}

      {notice && (
        <p
          role="status"
          className="absolute top-3 left-1/2 -translate-x-1/2 rounded bg-black/75 px-3 py-1.5 text-sm text-white"
        >
          {notice}
        </p>
      )}

      <div
        className={cn(
          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pt-10 pb-2 text-white transition-opacity',
          controlsVisible || !playing ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {/* Scrubber */}
        <div className="group/scrub relative mb-1.5 h-4">
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/25">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }}
            />
            {!policy.allowSkipping && (
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-white/20"
                style={{ width: `${watchedLimit}%` }}
              />
            )}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[#d98a54]"
              style={{ width: `${progress}%` }}
            />
          </div>
          {source.chapters.map((c) => (
            <span
              key={c.startSeconds}
              aria-hidden
              className="absolute top-1/2 h-2 w-0.5 -translate-y-1/2 bg-black/60"
              style={{ left: `${duration ? (c.startSeconds / duration) * 100 : 0}%` }}
            />
          ))}
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            aria-label="Seek"
            aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
            onChange={(e) => {
              const v = videoRef.current;
              if (v) v.currentTime = Number(e.target.value);
            }}
            className="absolute inset-0 w-full cursor-pointer opacity-0"
          />
        </div>
        <div className="flex items-center gap-1">
          <ControlButton label={playing ? 'Pause' : 'Play'} onClick={toggle}>
            {playing ? (
              <Pause className="size-5" fill="currentColor" />
            ) : (
              <Play className="size-5" fill="currentColor" />
            )}
          </ControlButton>
          <ControlButton label="Back 10 seconds" onClick={() => seekBy(-10)}>
            <RotateCcw className="size-[18px]" />
          </ControlButton>
          <ControlButton label="Forward 10 seconds" onClick={() => seekBy(10)}>
            <RotateCw className="size-[18px]" />
          </ControlButton>
          <ControlButton
            label={muted ? 'Unmute' : 'Mute'}
            onClick={() => {
              if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
            }}
          >
            {muted ? <VolumeX className="size-[18px]" /> : <Volume2 className="size-[18px]" />}
          </ControlButton>
          <span className="tabular ml-1 text-xs text-white/90 sm:text-sm">
            {formatClock(time)} / {formatClock(duration)}
          </span>
          <span className="flex-1" />
          <MenuRoot>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={`Playback speed ${rate}×`}
                className="flex h-9 items-center gap-1 rounded px-2 text-sm hover:bg-white/15"
              >
                <Gauge className="size-[18px]" />
                <span className="tabular">{rate}×</span>
              </button>
            </MenuTrigger>
            <MenuContent align="end" className="min-w-[160px]">
              <MenuLabel>Playback speed</MenuLabel>
              {SPEEDS.map((s) => (
                <MenuItem key={s} onSelect={() => setSpeed(s)}>
                  <span className={cn('tabular', s === rate && 'font-semibold')}>
                    {s}× {s === 1 && <span className="text-text-tertiary">Normal</span>}
                    {s > policy.maxCreditedPlaybackRate && (
                      <span className="text-text-tertiary"> · not credited</span>
                    )}
                  </span>
                </MenuItem>
              ))}
            </MenuContent>
          </MenuRoot>
          {source.captions.length > 0 && (
            <ControlButton
              label={captionsOn ? 'Turn captions off' : 'Turn captions on'}
              pressed={captionsOn}
              onClick={() => setCaptionsOn((c) => !c)}
            >
              <Captions className="size-[18px]" />
            </ControlButton>
          )}
          <ControlButton
            label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? (
              <Minimize className="size-[18px]" />
            ) : (
              <Maximize className="size-[18px]" />
            )}
          </ControlButton>
        </div>
      </div>
    </div>
  );
});

function ControlButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex size-9 items-center justify-center rounded hover:bg-white/15',
        pressed && 'bg-white/20',
      )}
    >
      {children}
    </button>
  );
}
