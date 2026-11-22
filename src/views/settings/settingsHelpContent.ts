import type { InfoTipContent } from '../../components/InfoTip';

export type SettingsHelpKey =
  | 'recording-device'
  | 'quality-presets'
  | 'keep-local-master'
  | 'audio-format'
  | 'sample-rate'
  | 'bitrate'
  | 'bitrate-mode'
  | 'wav-bit-depth'
  | 'channels'
  | 'input-gain'
  | 'dsp-highpass'
  | 'dsp-limiter'
  | 'dsp-noise-suppression'
  | 'dsp-agc'
  | 'dsp-echo-cancellation'
  | 'drive-root-folder'
  | 'keep-screen-awake'
  | 'background-recording-keepalive'
  | 'local-offline-storage';

export const SETTINGS_HELP: Readonly<Record<SettingsHelpKey, InfoTipContent>> =
  {
    'recording-device': {
      id: 'recording-device',
      topic: 'Recording Device',
      title: 'Choosing a microphone',
      summary:
        'Pick which microphone StoryTape captures from when you record a chapter.',
      bullets: [
        {
          label: 'System Default (Recommended for phones)',
          text: "Uses your phone's built-in mic (or whichever wired/Bluetooth mic is currently active).",
        },
        {
          label: 'USB-C / Lightning mic',
          text: 'Delivers the cleanest studio tone and lowest room hiss if you plug in an external podcast mic.',
        },
        {
          label: 'Bluetooth earbuds',
          text: 'Convenient hands-free, though Bluetooth headset mics compress voice heavily and sound flatter than your built-in phone mic.',
        },
      ],
      tip: 'Tap Test Mic and read a sentence at your normal bedtime volume — aim for -12 dB to -6 dB without hitting CLIP.',
    },

    'quality-presets': {
      id: 'quality-presets',
      topic: 'Recording Quality',
      title: 'Picking a quality preset',
      summary:
        'Presets bundle audio format, bitrate, and microphone filters into a single tap.',
      bullets: [
        {
          label: 'Voice Compact (64k)',
          text: 'Smallest files (~0.5 MB/min) for slow internet or saving Drive space while staying crisp for speech.',
        },
        {
          label: 'Audiobook Standard (128k · Recommended)',
          text: 'Warm, natural voice quality (~1 MB/min) with balanced phone-mic cleanup. Ideal for most recordings.',
        },
        {
          label: 'Studio Raw (320k)',
          text: 'Turns off browser voice filters for rich, uncolored sound in a quiet room or with an external mic (~2.4 MB/min).',
        },
        {
          label: 'Master Archival WAV',
          text: 'Uncompressed lossless studio audio (~8.6 MB/min). Huge files — best only if editing chapters in desktop software.',
        },
      ],
      tip: 'Not sure which bitrate sounds best with your voice? Tap Test Mic → Open in A/B Lab to compare bitrates blind.',
    },

    'keep-local-master': {
      id: 'keep-local-master',
      topic: 'Save Local Lossless Master',
      title: 'Why keep a local lossless master?',
      summary:
        'Saves an uncompressed 32-bit studio copy only on this device while Google Drive still syncs your regular compact chapter.',
      bullets: [
        {
          label: 'Turn ON if',
          text: 'You want to run blind A/B Quality Lab comparisons on your recorded chapters or re-export them at different bitrates later without re-recording.',
        },
        {
          label: 'Keep OFF for everyday use',
          text: 'Saves significant phone storage (~11.5 MB/min per chapter). You can delete saved masters anytime under App → Storage & App.',
        },
      ],
    },

    'audio-format': {
      id: 'audio-format',
      topic: 'Format / Codec',
      title: "Format / Codec — what's the difference?",
      summary:
        'Controls how your voice recording is compressed and saved as an audio file.',
      bullets: [
        {
          label: 'Auto (Recommended)',
          text: 'Uses the best native hardware encoder built into your browser (M4A AAC on Safari/iOS, WebM Opus on Chrome/Android).',
        },
        {
          label: 'M4A (AAC)',
          text: 'Most universally playable format across iPhones, Apple Books, car stereos, and shared family devices.',
        },
        {
          label: 'WebM (Opus)',
          text: 'Modern speech-friendly codec that often sounds slightly crisper than AAC at lower bitrates (64k–96k).',
        },
        {
          label: 'WAV (Lossless)',
          text: 'Zero compression — 100% raw audio, but 6× to 15× larger files. Only needed for archival or external audio editing.',
        },
      ],
    },

    'sample-rate': {
      id: 'sample-rate',
      topic: 'Sample Rate',
      title: 'Sample Rate (kHz)',
      summary:
        'How many audio snapshots per second are captured. Human speech sits well below 12 kHz, so higher numbers rarely improve voice.',
      bullets: [
        {
          label: '48 kHz (Recommended)',
          text: 'Modern phone and USB microphone native standard — avoids unnecessary resampling.',
        },
        {
          label: '44.1 kHz',
          text: 'Classic CD standard; sounds virtually identical to 48 kHz for spoken voice.',
        },
        {
          label: '24 kHz',
          text: 'Voice-focused rate for smaller compact files when storage or upload speed is tight.',
        },
        {
          label: '96 kHz',
          text: 'Only useful with Lossless WAV and an external studio mic; compressed formats (AAC/Opus) cap at 48 kHz anyway.',
        },
      ],
    },

    bitrate: {
      id: 'bitrate',
      topic: 'Bitrate',
      title: 'Bitrate (kbps) — clarity vs. file size',
      summary:
        'Controls how much data per second preserves your voice detail. Higher kbps means richer tone and larger files.',
      bullets: [
        {
          label: '64k',
          text: 'Tiny files (~0.5 MB/min) that upload quickly even on weak cellular data.',
        },
        {
          label: '96k–128k (Recommended)',
          text: 'Sweet spot for spoken audiobooks — warm, natural voice with compact ~0.7–1 MB/min files.',
        },
        {
          label: '192k–320k',
          text: 'Near-transparent studio quality for expressive reading or external condenser mics (~1.5–2.4 MB/min).',
        },
        {
          label: '510k',
          text: 'Maximum ceiling; some browsers cap mono AAC/Opus lower and automatically use their highest supported rate.',
        },
      ],
    },

    'bitrate-mode': {
      id: 'bitrate-mode',
      topic: 'Bitrate Mode',
      title: 'VBR vs. CBR',
      summary:
        'Decides whether the encoder adapts to quiet pauses or spends the exact same data every second.',
      bullets: [
        {
          label: 'VBR — Variable (Recommended)',
          text: 'Saves bits during quiet pauses and spends extra detail on expressive speech, giving better quality for the same file size.',
        },
        {
          label: 'CBR — Constant',
          text: 'Locks a fixed data rate every second. Only pick this if you import audio into older players or editors that require constant bitrate.',
        },
      ],
    },

    'wav-bit-depth': {
      id: 'wav-bit-depth',
      topic: 'WAV Bit Depth',
      title: 'WAV Bit Depth',
      summary:
        'Sets the numeric precision of each uncompressed sample (only applies when Format is WAV).',
      bullets: [
        {
          label: '16-bit PCM',
          text: 'CD quality — smallest lossless WAV (~5.8 MB/min mono) and compatible with every player.',
        },
        {
          label: '24-bit PCM (Recommended for WAV)',
          text: 'Studio standard with generous quiet-to-loud dynamic range (~8.6 MB/min mono).',
        },
        {
          label: '32-bit Float',
          text: 'Archival mastering format (~11.5 MB/min mono) for heavy post-processing in desktop DAWs.',
        },
      ],
    },

    channels: {
      id: 'channels',
      topic: 'Channels',
      title: 'Mono vs. Stereo — which should I pick?',
      summary:
        'For one person reading aloud on a phone or single mic, Mono is almost always better.',
      bullets: [
        {
          label: 'Mono (1 ch · Recommended for phone & voice)',
          text: 'Phones capture voice from one mic anyway, and Mono still plays evenly in both ears on headphones! You get the exact same voice clarity at half the file size — or twice the quality per channel at the same bitrate.',
        },
        {
          label: 'Stereo (2 ch)',
          text: 'Doubles WAV size (or splits compressed bitrate across two channels). Only pick Stereo if you plugged in a 2-microphone USB/XLR stereo recorder or are recording two people on left/right mics.',
        },
      ],
    },

    'input-gain': {
      id: 'input-gain',
      topic: 'Input Gain Boost',
      title: 'When to adjust Input Gain Boost',
      summary:
        'Turns your microphone volume up or down before recording is saved.',
      bullets: [
        {
          label: '0 dB / 1× (Default)',
          text: 'Leaves your microphone untouched. Best starting point if Test Mic already reads healthy levels.',
        },
        {
          label: '+6 dB to +18 dB (Boost)',
          text: 'Helpful when recording softly at bedtime or on iPhones in Studio Raw mode where raw mic input is quiet.',
        },
        {
          label: '-6 dB (Softer)',
          text: 'Tones down very loud voices or closely held mics if the meter flashes CLIP.',
        },
      ],
      tip: 'Keep Anti-Clip Safety Limiter ON when boosting above +6 dB so sudden character voices never distort.',
    },

    'dsp-highpass': {
      id: 'dsp-highpass',
      topic: '80 Hz Rumble Filter',
      title: '80 Hz Rumble Filter',
      summary:
        'Gently trims ultra-low vibrations below the range of human voice.',
      bullets: [
        {
          label: 'ON (Recommended)',
          text: 'Removes air-conditioner hum, footsteps, and hand bumps against your phone without thinning voice warmth.',
        },
        {
          label: 'OFF',
          text: 'Leaves the full low-frequency spectrum untouched (only needed if applying your own EQ later).',
        },
      ],
    },

    'dsp-limiter': {
      id: 'dsp-limiter',
      topic: 'Anti-Clip Safety Limiter',
      title: 'Anti-Clip Safety Limiter',
      summary:
        'Softly cushions sudden loud peaks before they turn into harsh digital crackle.',
      bullets: [
        {
          label: 'ON (Recommended)',
          text: 'Invisible during normal reading, but saves your take if you suddenly do a loud character voice or laugh close to the mic.',
        },
        {
          label: 'OFF',
          text: 'Leaves peaks completely raw — only turn off if you are strictly controlling levels on an external interface.',
        },
      ],
    },

    'dsp-noise-suppression': {
      id: 'dsp-noise-suppression',
      topic: 'Browser Noise Suppression',
      title: 'Browser Noise Suppression',
      summary:
        'Runs the browser’s built-in background noise filter during capture.',
      bullets: [
        {
          label: 'ON',
          text: 'Useful if you have a noisy fan, AC unit, or street traffic in the room.',
        },
        {
          label: 'OFF (Best in quiet rooms)',
          text: 'Preserves full natural richness — browser noise filters are tuned for phone calls and can make quiet whispers sound slightly robotic.',
        },
      ],
    },

    'dsp-agc': {
      id: 'dsp-agc',
      topic: 'Browser Auto Gain Control',
      title: 'Browser Auto Gain Control (AGC)',
      summary:
        'Automatically boosts quiet speech and pulls down louder speech in real time.',
      bullets: [
        {
          label: 'ON',
          text: 'Handy if you hold your phone casually at changing distances (on iOS Safari, StoryTape engages its own studio auto-gain).',
        },
        {
          label: 'OFF (Best for steady studio tone)',
          text: 'Prevents room hiss from rising during quiet pauses; pair with manual Input Gain Boost for consistent volume.',
        },
      ],
    },

    'dsp-echo-cancellation': {
      id: 'dsp-echo-cancellation',
      topic: 'Browser Echo Cancellation',
      title: 'Browser Echo Cancellation',
      summary:
        'Built for speakerphone calls so people on the other end do not hear their own voice echo back.',
      bullets: [
        {
          label: 'OFF (Strongly Recommended)',
          text: 'Echo cancellation aggressively narrows voice frequencies and makes audiobooks sound thin and telephone-like.',
        },
        {
          label: 'ON',
          text: 'Only enable if audio is playing aloud from speakers right beside your microphone while recording.',
        },
      ],
    },

    'drive-root-folder': {
      id: 'drive-root-folder',
      topic: 'Drive Root Folder Name',
      title: 'How StoryTape organizes Google Drive',
      summary:
        'Your personal books are synced as subfolders inside this single Google Drive folder.',
      bullets: [
        {
          label: 'Privacy-first access',
          text: 'StoryTape only requests access to files it creates or folders you explicitly share or pick — it cannot read the rest of your Drive.',
        },
        {
          label: 'Renaming',
          text: 'Changing this name points future syncs to a folder with that name without deleting your existing Drive folder.',
        },
      ],
    },

    'keep-screen-awake': {
      id: 'keep-screen-awake',
      topic: 'Keep Screen Awake While Recording',
      title: 'Screen Wake Lock',
      summary:
        'Keeps your phone from auto-locking mid-chapter so the timer and waveform stay visible.',
      tip: 'Recording in a dark nursery? Tap the moon icon in Recording Studio for pure-black OLED Blackout Mode while recording continues.',
    },

    'background-recording-keepalive': {
      id: 'background-recording-keepalive',
      topic: 'iOS Lock-Screen Audio Keepalive',
      title: 'Experimental iOS lock-screen workaround',
      summary:
        'Plays an inaudible looping audio file and switches Safari AudioSession to play-and-record so iOS Safari may keep recording if you manually lock the screen.',
      bullets: [
        {
          label: 'OFF (Recommended)',
          text: 'Avoids extra OS audio-session contention and resampling so recording stays smooth and glitch-free on iPhone, Android, Bluetooth mics, and desktop.',
        },
        {
          label: 'ON (Experimental)',
          text: 'Only try this if you specifically need to lock your iPhone mid-chapter in Safari. Some iOS versions or Bluetooth devices may experience choppy audio with this enabled.',
        },
      ],
      tip: 'For dark rooms, Keep Screen Awake + Blackout screen inside Recording Studio gives zero glare without touching iOS audio sessions.',
    },

    'local-offline-storage': {
      id: 'local-offline-storage',
      topic: 'Local Offline Storage',
      title: 'Managing offline device storage',
      summary:
        'Chapters are stored locally in your browser so StoryTape works completely offline.',
      bullets: [
        {
          label: 'Free Cached Audio',
          text: 'Safe to use anytime — only clears local copies of chapters already backed up to Google Drive. Tapping Play while online re-downloads them automatically.',
        },
        {
          label: 'Delete Local Masters',
          text: 'Permanently removes optional uncompressed 32-bit masters from this device while keeping your regular chapters and Drive backups safe.',
        },
      ],
    },
  };
