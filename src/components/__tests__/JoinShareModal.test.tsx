import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultSettings } from '../../storage/settings';
import { JoinShareModal } from '../JoinShareModal';

describe('JoinShareModal request-access handoff', () => {
  it('shows Request Access in Google Drive link and Check Access & Retry action when joining needs unlock or permission', async () => {
    const onJoinFolder = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsPicker: true })
      .mockResolvedValueOnce({ ok: true });

    render(
      <JoinShareModal
        open
        invite={{
          folderId: 'shared-folder-xyz',
          name: 'Grandpa Stories',
          scope: 'book',
          role: 'reader',
        }}
        settings={getDefaultSettings()}
        isDriveConnected
        isJoining={false}
        onClose={vi.fn()}
        onConnectDrive={vi.fn()}
        onJoinFolder={onJoinFolder}
        onToast={vi.fn()}
      />,
    );

    // Initially neither unlock card is shown until user attempts to join
    expect(screen.queryByTestId('join-picker-card')).toBeNull();
    expect(screen.queryByTestId('join-request-access-card')).toBeNull();

    // Single-book Listener invite defaults to Import Copy mode
    expect(screen.getByTestId('join-book-mode-selector')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Import Copy to My Library/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Tap Import to My Library -> returns needsPicker: true
    fireEvent.click(screen.getByRole('button', { name: /Import to My Library/i }));

    await waitFor(() => {
      expect(screen.getByTestId('join-picker-card')).toBeInTheDocument();
      expect(screen.getByTestId('join-request-access-card')).toBeInTheDocument();
    });
    expect(onJoinFolder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        folderId: 'shared-folder-xyz',
        mode: 'import',
      }),
    );

    const requestLink = screen.getByRole('link', {
      name: /Request Access in Google Drive/i,
    });
    expect(requestLink).toHaveAttribute(
      'href',
      'https://drive.google.com/drive/folders/shared-folder-xyz',
    );
    expect(
      screen.queryByRole('button', { name: /Check Access & Retry/i }),
    ).toBeNull();

    // Clicking Request Access reveals Check Access & Retry button
    fireEvent.click(requestLink);
    const retryBtn = await screen.findByRole('button', {
      name: /Check Access & Retry/i,
    });
    expect(retryBtn).toBeInTheDocument();

    // Clicking Check Access & Retry retries joining with mode: 'import'
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(onJoinFolder).toHaveBeenCalledTimes(2);
    });
    expect(onJoinFolder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        folderId: 'shared-folder-xyz',
        mode: 'import',
      }),
    );
  });

  it('allows switching a Listener book invite to Link Live (No Copy) and defaults Co-Narrator invites to Link Live', async () => {
    const onJoinFolder = vi.fn().mockResolvedValue({ ok: true });

    const { rerender } = render(
      <JoinShareModal
        open
        invite={{
          folderId: 'colleague-book-1',
          name: 'Dragon Stories',
          scope: 'book',
          role: 'reader',
        }}
        settings={getDefaultSettings()}
        isDriveConnected
        isJoining={false}
        onClose={vi.fn()}
        onConnectDrive={vi.fn()}
        onJoinFolder={onJoinFolder}
        onToast={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: /Link Live \(No Copy\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /Join & Sync Now/i }));

    await waitFor(() => {
      expect(onJoinFolder).toHaveBeenCalledWith(
        expect.objectContaining({
          folderId: 'colleague-book-1',
          mode: 'link',
        }),
      );
    });

    // When active library is read-only (canImportToLibrary=false), mode selector is hidden and falls back to link
    rerender(
      <JoinShareModal
        open
        invite={{
          folderId: 'colleague-book-2',
          name: 'Bedtime Tales',
          scope: 'book',
          role: 'reader',
        }}
        settings={getDefaultSettings()}
        isDriveConnected
        isJoining={false}
        canImportToLibrary={false}
        onClose={vi.fn()}
        onConnectDrive={vi.fn()}
        onJoinFolder={onJoinFolder}
        onToast={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('join-book-mode-selector')).toBeNull();
    expect(screen.getByRole('button', { name: /Join & Sync Now/i })).toBeInTheDocument();
  });
});
