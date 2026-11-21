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

    // Tap Join & Sync Now -> returns needsPicker: true
    fireEvent.click(screen.getByRole('button', { name: /Join & Sync Now/i }));

    await waitFor(() => {
      expect(screen.getByTestId('join-picker-card')).toBeInTheDocument();
      expect(screen.getByTestId('join-request-access-card')).toBeInTheDocument();
    });

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

    // Clicking Check Access & Retry retries joining
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(onJoinFolder).toHaveBeenCalledTimes(2);
    });
  });
});
