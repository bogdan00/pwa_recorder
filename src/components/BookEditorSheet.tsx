import React, { useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2, X } from 'lucide-react';
import { BOOK_COVER_PALETTE, type BookProject } from '../types/models';
import { getProjectCover } from '../storage/db';
import { resizeCoverImage } from '../utils/imageResize';
import { BookCover } from './BookCover';
import './BookEditorSheet.css';

export interface BookFormSubmission {
  title: string;
  author: string;
  narrator: string;
  dedicatedTo: string;
  description: string;
  language: string;
  tags: string[];
  coverColor: string;
  coverChange: 'keep' | 'replace' | 'remove';
  coverBlob?: Blob;
  coverMimeType?: string;
}

interface BookEditorSheetProps {
  open: boolean;
  initialProject?: BookProject | null;
  defaultNarrator: string;
  onClose: () => void;
  onSave: (data: BookFormSubmission) => Promise<void>;
  onDelete?: (projectId: string) => Promise<void>;
}

export const BookEditorSheet: React.FC<BookEditorSheetProps> = ({
  open,
  initialProject,
  defaultNarrator,
  onClose,
  onSave,
  onDelete,
}) => {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [narrator, setNarrator] = useState('');
  const [dedicatedTo, setDedicatedTo] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState('English');
  const [tagsText, setTagsText] = useState('');
  const [coverColor, setCoverColor] = useState<string>(BOOK_COVER_PALETTE[0].hex);

  const [coverChange, setCoverChange] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [coverBlob, setCoverBlob] = useState<Blob | undefined>(undefined);
  const [coverMimeType, setCoverMimeType] = useState<string | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processingCover, setProcessingCover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const setSafePreview = (url: string | null) => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    previewUrlRef.current = url;
    setPreviewUrl(url);
  };

  useEffect(() => {
    if (!open) return;

    setConfirmDelete(false);
    setSaving(false);
    setProcessingCover(false);
    setCoverChange('keep');
    setCoverBlob(undefined);
    setCoverMimeType(undefined);

    if (initialProject) {
      setTitle(initialProject.title);
      setAuthor(initialProject.author);
      setNarrator(initialProject.narrator);
      setDedicatedTo(initialProject.dedicatedTo);
      setDescription(initialProject.description);
      setLanguage(initialProject.language || 'English');
      setTagsText(initialProject.tags.join(', '));
      setCoverColor(initialProject.coverColor || BOOK_COVER_PALETTE[0].hex);

      if (initialProject.hasCover) {
        let active = true;
        void getProjectCover(initialProject.id).then((blob) => {
          if (!active || !blob) return;
          setSafePreview(URL.createObjectURL(blob));
        });
        return () => {
          active = false;
        };
      }
      setSafePreview(null);
    } else {
      setTitle('');
      setAuthor('');
      setNarrator(defaultNarrator);
      setDedicatedTo('');
      setDescription('');
      setLanguage('English');
      setTagsText('');
      const randomColor =
        BOOK_COVER_PALETTE[Math.floor(Math.random() * BOOK_COVER_PALETTE.length)].hex;
      setCoverColor(randomColor);
      setSafePreview(null);
    }
  }, [open, initialProject, defaultNarrator]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  if (!open) return null;

  const handleImagePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setProcessingCover(true);
    try {
      const resized = await resizeCoverImage(file);
      setCoverBlob(resized.blob);
      setCoverMimeType(resized.mimeType);
      setCoverChange('replace');
      setSafePreview(URL.createObjectURL(resized.blob));
    } finally {
      setProcessingCover(false);
    }
  };

  const handleRemoveCover = () => {
    setCoverBlob(undefined);
    setCoverMimeType(undefined);
    setCoverChange('remove');
    setSafePreview(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || saving || processingCover) return;
    setSaving(true);
    try {
      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter((t, i, arr) => t.length > 0 && arr.indexOf(t) === i);

      await onSave({
        title: title.trim(),
        author: author.trim(),
        narrator: narrator.trim(),
        dedicatedTo: dedicatedTo.trim(),
        description: description.trim(),
        language: language.trim(),
        tags,
        coverColor,
        coverChange,
        coverBlob,
        coverMimeType,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!initialProject || !onDelete || saving) return;
    setSaving(true);
    try {
      await onDelete(initialProject.id);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="book-editor-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <form className="sheet-panel" onSubmit={handleSubmit}>
        <div className="sheet-header">
          <h2 id="book-editor-title" className="sheet-title">
            {initialProject ? 'Edit Book Details' : 'New Audiobook Project'}
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="sheet-body">
          {/* Cover art picker */}
          <div className="book-editor-cover-row">
            <BookCover
              title={title || 'New Book'}
              author={author}
              coverColor={coverColor}
              previewUrl={previewUrl}
              size="md"
            />
            <div className="book-editor-cover-controls">
              <span className="field-label">Book Cover</span>
              <div className="book-editor-cover-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => libraryInputRef.current?.click()}
                >
                  <ImageIcon size={15} />
                  Photo
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera size={15} />
                  Camera
                </button>
                {previewUrl && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={handleRemoveCover}
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={libraryInputRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={handleImagePicked}
                aria-label="Choose cover photo from library"
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={handleImagePicked}
                aria-label="Take cover photo with camera"
              />

              {!previewUrl && (
                <div className="swatch-row" role="radiogroup" aria-label="Cloth cover color">
                  {BOOK_COVER_PALETTE.map((swatch) => (
                    <button
                      key={swatch.id}
                      type="button"
                      role="radio"
                      aria-checked={coverColor === swatch.hex}
                      aria-label={swatch.label}
                      className={`swatch-btn ${coverColor === swatch.hex ? 'swatch-btn--active' : ''}`}
                      style={{ backgroundColor: swatch.hex }}
                      onClick={() => setCoverColor(swatch.hex)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor="book-title-input" className="field-label">
              Book Title *
            </label>
            <input
              id="book-title-input"
              type="text"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. The Gruffalo"
              required
              autoFocus={!initialProject}
            />
          </div>

          <div className="book-editor-grid book-editor-grid--two">
            <div className="field">
              <label htmlFor="book-author-input" className="field-label">
                Author
              </label>
              <input
                id="book-author-input"
                type="text"
                className="input"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="e.g. Julia Donaldson"
              />
            </div>

            <div className="field">
              <label htmlFor="book-narrator-input" className="field-label">
                Read By (Narrator)
              </label>
              <input
                id="book-narrator-input"
                type="text"
                className="input"
                value={narrator}
                onChange={(e) => setNarrator(e.target.value)}
                placeholder="e.g. Dad"
              />
            </div>
          </div>

          <div className="book-editor-grid book-editor-grid--two">
            <div className="field">
              <label htmlFor="book-dedicated-input" className="field-label">
                Recorded For
              </label>
              <input
                id="book-dedicated-input"
                type="text"
                className="input"
                value={dedicatedTo}
                onChange={(e) => setDedicatedTo(e.target.value)}
                placeholder="e.g. My sweet girl"
              />
            </div>

            <div className="field">
              <label htmlFor="book-language-input" className="field-label">
                Language
              </label>
              <input
                id="book-language-input"
                type="text"
                className="input"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="English"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="book-tags-input" className="field-label">
              Tags
            </label>
            <input
              id="book-tags-input"
              type="text"
              className="input"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="Bedtime, Favorites, Age 4–6 (comma-separated)"
            />
          </div>

          <div className="field">
            <label htmlFor="book-desc-input" className="field-label">
              Notes / Dedication
            </label>
            <textarea
              id="book-desc-input"
              className="textarea"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A note to keep alongside the book metadata in Google Drive..."
            />
          </div>

          {initialProject && onDelete && (
            <div className="book-editor-danger">
              {confirmDelete ? (
                <>
                  <span className="field-hint">
                    Delete this book and all local recordings?
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={handleDelete}
                      disabled={saving}
                    >
                      Confirm Delete
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="field-hint">Remove this book from local library</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} />
                    Delete Book
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="sheet-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || processingCover || !title.trim()}
            id="save-book-btn"
          >
            {processingCover
              ? 'Processing cover…'
              : saving
                ? 'Saving…'
                : initialProject
                  ? 'Save Changes'
                  : 'Create Book'}
          </button>
        </div>
      </form>
    </div>
  );
};
