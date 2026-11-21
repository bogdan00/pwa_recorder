import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../ConfirmDialogContext';
import { ShareSheet } from '../ShareSheet';

const listDriveFolderPermissionsMock = vi.fn();

vi.mock('../../drive/syncService', () => ({
  listDriveFolderPermissions: (...args: unknown[]) =>
    listDriveFolderPermissionsMock(...args),
  removeDriveFolderPermission: vi.fn(),
  setDriveFolderAnyoneLinkAccess: vi.fn(),
  shareDriveFolderWithEmail: vi.fn(),
}));

describe('ShareSheet invite link preview', () => {
  beforeEach(() => {
    listDriveFolderPermissionsMock.mockReset();
    listDriveFolderPermissionsMock.mockResolvedValue([]);
  });

  it('renders a wrapped read-only textarea with a matching mirror and resets scroll offsets on focus', async () => {
    const { container } = render(
      <ConfirmProvider>
        <ShareSheet
          open
          scope="book"
          targetTitle="Bedtime Stories for the Whole Family Extended Edition"
          folderId="folder-1234567890-abcdef"
          accessRole="writer"
          isDriveConnected
          onClose={vi.fn()}
          onConnectDrive={vi.fn()}
          onPrepareFolder={vi.fn()}
          onToast={vi.fn()}
        />
      </ConfirmProvider>,
    );

    await waitFor(() => {
      expect(listDriveFolderPermissionsMock).toHaveBeenCalledWith(
        'folder-1234567890-abcdef',
      );
    });

    const linkBox = screen.getByRole('textbox', {
      name: 'StoryTape invite link',
    }) as HTMLTextAreaElement;

    expect(linkBox.tagName).toBe('TEXTAREA');
    expect(linkBox.readOnly).toBe(true);
    expect(linkBox.value).toContain('#/join?folderId=folder-1234567890-abcdef');
    expect(linkBox.value).toContain('scope=book');
    expect(linkBox.value).toContain('role=writer');

    const mirror = container.querySelector('.share-link-mirror');
    expect(mirror).not.toBeNull();
    expect(mirror?.getAttribute('aria-hidden')).toBe('true');
    expect(mirror?.textContent).toBe(linkBox.value);

    // Switching role updates both the textarea value and mirror text in lockstep
    fireEvent.click(screen.getByRole('radio', { name: /Listener/i }));
    expect(linkBox.value).toContain('role=reader');
    expect(mirror?.textContent).toBe(linkBox.value);

    // Focus selects the full link and clamps any scroll offset back to 0
    const selectSpy = vi.spyOn(linkBox, 'select');
    linkBox.scrollLeft = 42;
    linkBox.scrollTop = 18;
    fireEvent.focus(linkBox);

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(linkBox.scrollLeft).toBe(0);
    expect(linkBox.scrollTop).toBe(0);
  });
});
