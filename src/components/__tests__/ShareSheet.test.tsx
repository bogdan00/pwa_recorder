import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../ConfirmDialogContext';
import { ShareSheet } from '../ShareSheet';

const listDriveFolderPermissionsMock = vi.fn();
const listDriveFolderAccessProposalsMock = vi.fn();
const resolveDriveFolderAccessProposalMock = vi.fn();

vi.mock('../../drive/syncService', () => ({
  listDriveFolderPermissions: (...args: unknown[]) =>
    listDriveFolderPermissionsMock(...args),
  listDriveFolderAccessProposals: (...args: unknown[]) =>
    listDriveFolderAccessProposalsMock(...args),
  resolveDriveFolderAccessProposal: (...args: unknown[]) =>
    resolveDriveFolderAccessProposalMock(...args),
  removeDriveFolderPermission: vi.fn(),
  setDriveFolderAnyoneLinkAccess: vi.fn(),
  shareDriveFolderWithEmail: vi.fn(),
}));

describe('ShareSheet', () => {
  beforeEach(() => {
    listDriveFolderPermissionsMock.mockReset();
    listDriveFolderPermissionsMock.mockResolvedValue([]);
    listDriveFolderAccessProposalsMock.mockReset();
    listDriveFolderAccessProposalsMock.mockResolvedValue([]);
    resolveDriveFolderAccessProposalMock.mockReset();
    resolveDriveFolderAccessProposalMock.mockResolvedValue(undefined);
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

  it('shows pending Drive access requests for approvers and supports approving or denying them', async () => {
    const onToast = vi.fn();
    listDriveFolderAccessProposalsMock
      .mockResolvedValueOnce([
        {
          proposalId: 'prop-1',
          requesterEmailAddress: 'uncle@example.com',
          recipientEmailAddress: 'uncle@example.com',
          rolesAndViews: [{ role: 'reader' }],
          requestMessage: 'Would love to listen!',
        },
        {
          proposalId: 'prop-2',
          requesterEmailAddress: 'stranger@example.com',
          recipientEmailAddress: 'stranger@example.com',
          rolesAndViews: [{ role: 'writer' }],
        },
      ])
      .mockResolvedValueOnce([
        {
          proposalId: 'prop-2',
          requesterEmailAddress: 'stranger@example.com',
          recipientEmailAddress: 'stranger@example.com',
          rolesAndViews: [{ role: 'writer' }],
        },
      ]);

    listDriveFolderPermissionsMock
      .mockResolvedValueOnce([
        { id: 'owner-1', type: 'user', role: 'owner', emailAddress: 'dad@example.com' },
      ])
      .mockResolvedValueOnce([
        { id: 'owner-1', type: 'user', role: 'owner', emailAddress: 'dad@example.com' },
        { id: 'perm-uncle', type: 'user', role: 'reader', emailAddress: 'uncle@example.com' },
      ]);

    render(
      <ConfirmProvider>
        <ShareSheet
          open
          scope="book"
          targetTitle="Bedtime Stories"
          folderId="folder-abc"
          accessRole="owner"
          isDriveConnected
          onClose={vi.fn()}
          onConnectDrive={vi.fn()}
          onPrepareFolder={vi.fn()}
          onToast={onToast}
        />
      </ConfirmProvider>,
    );

    const section = await screen.findByTestId('share-access-requests-section');
    expect(section).toHaveTextContent('uncle@example.com');
    expect(section).toHaveTextContent('Would love to listen!');
    expect(section).toHaveTextContent('stranger@example.com');

    // Approve first proposal as Listener
    const approveBtn = screen
      .getByTestId('access-proposal-prop-1')
      .querySelector('button')!;
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(resolveDriveFolderAccessProposalMock).toHaveBeenCalledWith(
        'folder-abc',
        'prop-1',
        { action: 'ACCEPT', role: 'reader', sendNotification: true },
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('access-proposal-prop-1')).toBeNull();
    });
    expect(onToast).toHaveBeenCalledWith(
      'Approved uncle@example.com as Listener',
    );
    expect(screen.getByText('uncle@example.com')).toBeInTheDocument();

    // Deny second proposal
    const denyBtn = screen
      .getByTestId('access-proposal-prop-2')
      .querySelectorAll('button')[2];
    fireEvent.click(denyBtn);

    await waitFor(() => {
      expect(resolveDriveFolderAccessProposalMock).toHaveBeenCalledWith(
        'folder-abc',
        'prop-2',
        { action: 'DENY', role: undefined, sendNotification: true },
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('share-access-requests-section')).toBeNull();
    });
    expect(onToast).toHaveBeenCalledWith(
      'Denied access request from stranger@example.com',
    );
  });

  it('does not fetch or show pending access requests for read-only Listeners', async () => {
    render(
      <ConfirmProvider>
        <ShareSheet
          open
          scope="book"
          targetTitle="Bedtime Stories"
          folderId="folder-readonly"
          accessRole="reader"
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
        'folder-readonly',
      );
    });
    expect(listDriveFolderAccessProposalsMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('share-access-requests-section')).toBeNull();
  });
});
