/**
 * Client-side cover image resizing & compression so book covers load fast on mobile
 * and stay lean in IndexedDB and Google Drive (~60-150 KB).
 */
export async function resizeCoverImage(
  file: Blob,
  maxWidth = 900,
  maxHeight = 1350,
  quality = 0.86,
): Promise<{ blob: Blob; mimeType: string }> {
  // Fallback cleanly in non-canvas environments (e.g. jsdom unit tests)
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { blob: file, mimeType: file.type || 'image/jpeg' };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { blob: file, mimeType: file.type || 'image/jpeg' };
    }

    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close();

    const outputBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
    );
    if (!outputBlob) {
      return { blob: file, mimeType: file.type || 'image/jpeg' };
    }
    return { blob: outputBlob, mimeType: 'image/jpeg' };
  } catch {
    return { blob: file, mimeType: file.type || 'image/jpeg' };
  }
}
