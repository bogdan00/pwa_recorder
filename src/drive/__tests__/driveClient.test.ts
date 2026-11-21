import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveClient } from '../driveClient';

describe('DriveClient access proposals API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists pending access proposals from Drive v3 API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessProposals: [
            {
              proposalId: 'prop-1',
              requesterEmailAddress: 'uncle@example.com',
              recipientEmailAddress: 'uncle@example.com',
              rolesAndViews: [{ role: 'reader' }],
              requestMessage: 'Please let me listen to bedtime stories!',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new DriveClient('test-token');
    const proposals = await client.listAccessProposals('folder-123');

    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalId).toBe('prop-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/folder-123/accessproposals',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('returns an empty list gracefully when listAccessProposals returns 403 or 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new DriveClient('test-token');
    await expect(client.listAccessProposals('folder-403')).resolves.toEqual([]);
    await expect(client.listAccessProposals('folder-404')).resolves.toEqual([]);
  });

  it('resolves access proposals with ACCEPT (including role array) and DENY', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new DriveClient('test-token');

    await client.resolveAccessProposal('folder-123', 'prop-accept', {
      action: 'ACCEPT',
      role: 'reader',
      sendNotification: true,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://www.googleapis.com/drive/v3/files/folder-123/accessproposals/prop-accept:resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'ACCEPT',
          sendNotification: true,
          role: ['reader'],
        }),
      }),
    );

    await client.resolveAccessProposal('folder-123', 'prop-deny', {
      action: 'DENY',
      sendNotification: false,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/drive/v3/files/folder-123/accessproposals/prop-deny:resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'DENY',
          sendNotification: false,
        }),
      }),
    );
  });
});
