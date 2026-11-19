import React, { useEffect, useState } from 'react';
import { getProjectCover } from '../storage/db';
import './BookCover.css';

interface BookCoverProps {
  projectId?: string;
  title: string;
  author?: string;
  coverColor: string;
  hasCover?: boolean;
  coverUpdatedAt?: number;
  previewUrl?: string | null;
  size?: 'fluid' | 'sm' | 'md' | 'lg';
  progressRatio?: number; // 0..1 optional listening progress
  className?: string;
}

export const BookCover: React.FC<BookCoverProps> = ({
  projectId,
  title,
  author,
  coverColor,
  hasCover,
  coverUpdatedAt,
  previewUrl,
  size = 'fluid',
  progressRatio,
  className = '',
}) => {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (previewUrl !== undefined) {
      setLoadedUrl(null);
      return;
    }
    if (!projectId || !hasCover) {
      setLoadedUrl(null);
      return;
    }

    let active = true;
    let objUrl: string | null = null;

    void getProjectCover(projectId).then((blob) => {
      if (!active || !blob) return;
      objUrl = URL.createObjectURL(blob);
      setLoadedUrl(objUrl);
    });

    return () => {
      active = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [projectId, hasCover, coverUpdatedAt, previewUrl]);

  const imgSrc = previewUrl !== undefined ? previewUrl : loadedUrl;
  const sizeClass = size === 'fluid' ? '' : `book-cover--${size}`;
  const monogram = (title.trim()[0] || 'S').toUpperCase();

  return (
    <div className={`book-cover ${sizeClass} ${className}`.trim()}>
      {imgSrc ? (
        <img
          src={imgSrc}
          alt={`${title} cover`}
          className="book-cover__img"
          loading="lazy"
        />
      ) : (
        <div
          className="book-cover__cloth"
          style={{ backgroundColor: coverColor || '#9E4736' }}
        >
          {size === 'sm' ? (
            <span className="book-cover__monogram">{monogram}</span>
          ) : (
            <>
              <span className="book-cover__ornament" aria-hidden="true" />
              <div className="book-cover__title">{title || 'Untitled Book'}</div>
              <div className="book-cover__author">{author || '\u00A0'}</div>
            </>
          )}
        </div>
      )}

      {typeof progressRatio === 'number' && progressRatio > 0.01 && (
        <div className="book-cover__progress-track" aria-hidden="true">
          <div
            className="book-cover__progress-fill"
            style={{ width: `${Math.min(100, Math.round(progressRatio * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
};
