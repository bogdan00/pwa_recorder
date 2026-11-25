export type SyncStatus =
  | 'local_only'
  | 'pending_upload'
  | 'uploading'
  | 'synced'
  | 'cloud_only'
  | 'error';

export type AudioFormatOption = 'auto' | 'm4a' | 'webm' | 'wav';
export type EncodedAudioExtension = 'm4a' | 'webm' | 'wav';
export type AudioExtension =
  | EncodedAudioExtension
  | 'mp3'
  | 'ogg'
  | 'flac'
  | 'aac';
export type SampleRateOption = 16000 | 24000 | 44100 | 48000 | 96000;
export type BitrateKbpsOption =
  | 32
  | 48
  | 64
  | 96
  | 128
  | 160
  | 192
  | 256
  | 320
  | 384
  | 510;
export type BitrateModeOption = 'variable' | 'constant';
export type ChannelCountOption = 1 | 2;
export type WavBitDepthOption = 16 | 24 | 32;
export type QualityPresetId =
  | 'compact'
  | 'standard'
  | 'studio'
  | 'master'
  | 'custom';

export interface AudioQualitySettings {
  preset: QualityPresetId;
  format: AudioFormatOption;
  sampleRate: SampleRateOption;
  bitrateKbps: BitrateKbpsOption;
  bitrateMode: BitrateModeOption;
  channels: ChannelCountOption;
  wavBitDepth: WavBitDepthOption;
  inputGain: number; // Linear gain multiplier (~0.5 to ~15.85, i.e. -6 dB to +24 dB)
  highPassFilter: boolean; // 80 Hz voice rumble filter
  softLimiter: boolean; // anti-clip safety limiter
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
}

export interface AudioDeviceSettings {
  deviceId: string; // 'default' or MediaDeviceInfo.deviceId
  deviceLabel: string;
}

import type { ConcreteThemeId, ThemePreference } from '../styles/themes';
export type { ConcreteThemeId, ThemePreference };
export type ShareAccessRole = 'owner' | 'writer' | 'reader';
export type DriveLibraryMode = 'personal' | 'shared';

export interface SharedBookLink {
  folderId: string;
  title: string;
  role: 'writer' | 'reader';
  addedAt: number;
}

export interface DriveCollaboratorPermission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader';
  emailAddress?: string;
  displayName?: string;
}

export interface DriveAccessProposalRoleAndView {
  role?: string;
  view?: string;
}

export interface DriveAccessProposal {
  fileId?: string;
  proposalId: string;
  requesterEmailAddress?: string;
  recipientEmailAddress?: string;
  rolesAndViews?: DriveAccessProposalRoleAndView[];
  requestMessage?: string;
  createTime?: string;
}

export interface AppSettings {
  googleClientId: string;
  googleApiKey?: string;
  driveRootFolderName: string;
  driveRootFolderId?: string;
  driveLibraryMode?: DriveLibraryMode;
  driveSharedFolderName?: string;
  driveAccessRole?: ShareAccessRole;
  sharedLibraryBannerDismissed?: boolean;
  sharedBookFolders?: SharedBookLink[];
  defaultNarrator: string;
  theme: ThemePreference;
  keepScreenAwake: boolean;
  backgroundRecordingKeepalive: boolean;
  keepLocalMaster: boolean;
  audioQuality: AudioQualitySettings;
  audioDevice: AudioDeviceSettings;
}

export interface ImportedBookSource {
  folderId: string;
  sourceTitle?: string;
  sourceProjectId?: string;
  importedByEmail?: string;
  importedAt: number;
  lastMirrorSyncAt?: number;
  sourceUnavailable?: boolean;
}

export interface BookProject {
  id: string;
  title: string;
  author: string;
  narrator: string;
  dedicatedTo: string;
  description: string;
  language: string;
  tags: string[];
  coverColor: string;
  hasCover: boolean;
  coverMimeType?: string;
  coverUpdatedAt?: number;
  driveFolderId?: string;
  driveMetadataFileId?: string;
  driveCoverFileId?: string;
  isShared?: boolean;
  accessRole?: ShareAccessRole;
  importedFrom?: ImportedBookSource;
  deletedRecordingIds?: string[];
  syncStatus: SyncStatus;
  syncError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Recording {
  id: string;
  projectId: string;
  sourceRecordingId?: string;
  name: string;
  notes: string;
  recordedBy?: string;
  orderIndex: number;
  durationMs: number;
  mimeType: string;
  extension: AudioExtension;
  sampleRate: number;
  bitrateKbps?: number;
  bitDepth?: number;
  channels: ChannelCountOption;
  deviceLabel?: string;
  fileSizeBytes: number;
  peaks: number[]; // normalized 0..1 overview peaks (max ~160 bars for compact UI preview)
  // Device-local lossless master metadata (never synced to Google Drive)
  hasLocalMaster?: boolean;
  localMasterBytes?: number;
  localMasterSampleRate?: number;
  localMasterBitDepth?: WavBitDepthOption;
  localMasterChannels?: ChannelCountOption;
  driveFileId?: string;
  driveFileName?: string;
  syncStatus: SyncStatus;
  syncError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlaybackProgress {
  projectId: string;
  recordingId: string;
  positionSec: number;
  durationSec: number;
  completedRecordingIds: string[];
  updatedAt: number;
}

export interface ActiveDraft {
  id: string;
  projectId: string;
  sampleRate: number;
  channels: ChannelCountOption;
  totalFrames: number;
  chunkCount: number;
  peaks: number[];
  updatedAt: number;
}

export interface DraftChunkRecord {
  key: string; // `${draftId}:${chunkIndex}`
  draftId: string;
  chunkIndex: number;
  data: Float32Array;
}

export interface DriveProjectMetadataFile {
  schemaVersion: 1;
  id: string;
  title: string;
  author: string;
  narrator: string;
  dedicatedTo: string;
  description: string;
  language: string;
  tags: string[];
  coverColor: string;
  coverFileName?: string;
  coverMimeType?: string;
  coverUpdatedAt?: number;
  importedFrom?: ImportedBookSource;
  deletedRecordingIds?: string[];
  createdAt: number;
  updatedAt: number;
  recordings: Array<
    Pick<
      Recording,
      | 'id'
      | 'sourceRecordingId'
      | 'name'
      | 'notes'
      | 'recordedBy'
      | 'orderIndex'
      | 'durationMs'
      | 'mimeType'
      | 'extension'
      | 'sampleRate'
      | 'bitrateKbps'
      | 'bitDepth'
      | 'channels'
      | 'deviceLabel'
      | 'fileSizeBytes'
      | 'peaks'
      | 'driveFileId'
      | 'createdAt'
      | 'updatedAt'
    > & {
      driveFileName: string;
    }
  >;
}

export const BOOK_COVER_PALETTE = [
  { id: 'terracotta', label: 'Terracotta', hex: '#9E4736' },
  { id: 'forest', label: 'Forest Sage', hex: '#3D6352' },
  { id: 'midnight', label: 'Midnight Ink', hex: '#2F4562' },
  { id: 'ochre', label: 'Warm Ochre', hex: '#A6722E' },
  { id: 'plum', label: 'Mulberry Fig', hex: '#683B54' },
  { id: 'espresso', label: 'Walnut Bark', hex: '#543D32' },
] as const;
