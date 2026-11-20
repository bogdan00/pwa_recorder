import { describe, expect, it } from 'vitest';
import {
  buildJoinShareUrl,
  getDriveFolderWebUrl,
  parseJoinInviteInput,
} from '../shareUtils';

describe('shareUtils', () => {
  describe('getDriveFolderWebUrl', () => {
    it('builds a clean Google Drive folder URL for a standard folder ID', () => {
      expect(getDriveFolderWebUrl('1AbCdEfGhIjKlMnOp')).toBe(
        'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp',
      );
    });

    it('URL-encodes special characters in folder IDs', () => {
      expect(getDriveFolderWebUrl('folder id/with?chars&more')).toBe(
        'https://drive.google.com/drive/folders/folder%20id%2Fwith%3Fchars%26more',
      );
    });
  });

  describe('buildJoinShareUrl', () => {
    it('builds a valid #/join URL with folderId, name, scope, role, and clientId', () => {
      const url = buildJoinShareUrl({
        folderId: 'folder_123-ABC',
        name: 'Family Bedtime Stories',
        scope: 'library',
        role: 'writer',
        clientId: '1234567890-abc.apps.googleusercontent.com',
      });

      const hashIndex = url.indexOf('#/join?');
      expect(hashIndex).toBeGreaterThan(-1);

      const query = url.slice(hashIndex + '#/join?'.length);
      const params = new URLSearchParams(query);
      expect(params.get('folderId')).toBe('folder_123-ABC');
      expect(params.get('name')).toBe('Family Bedtime Stories');
      expect(params.get('scope')).toBe('library');
      expect(params.get('role')).toBe('writer');
      expect(params.get('clientId')).toBe(
        '1234567890-abc.apps.googleusercontent.com',
      );
    });

    it('supports book scope, reader role, trims values, and omits empty clientId/name', () => {
      const url = buildJoinShareUrl({
        folderId: 'bookFolder99',
        name: '   ',
        scope: 'book',
        role: 'reader',
        clientId: '   ',
      });

      const hashIndex = url.indexOf('#/join?');
      expect(hashIndex).toBeGreaterThan(-1);

      const params = new URLSearchParams(url.slice(hashIndex + '#/join?'.length));
      expect(params.get('folderId')).toBe('bookFolder99');
      expect(params.has('name')).toBe(false);
      expect(params.get('scope')).toBe('book');
      expect(params.get('role')).toBe('reader');
      expect(params.has('clientId')).toBe(false);
    });
  });

  describe('parseJoinInviteInput', () => {
    it('parses full StoryTape #/join URLs for library writer with clientId', () => {
      const url =
        'https://bogdan00.github.io/pwa_recorder/#/join?folderId=libFolder_01&name=Family+Library&scope=library&role=writer&clientId=my-client.apps.googleusercontent.com';

      expect(parseJoinInviteInput(url)).toEqual({
        folderId: 'libFolder_01',
        name: 'Family Library',
        scope: 'library',
        role: 'writer',
        clientId: 'my-client.apps.googleusercontent.com',
      });
    });

    it('parses full StoryTape #/join URLs for book reader with clientId', () => {
      const url =
        'https://storytape.example.com/#/join?folderId=bookFolder_42&name=The+Gruffalo&scope=book&role=reader&clientId=cid-999';

      expect(parseJoinInviteInput(url)).toEqual({
        folderId: 'bookFolder_42',
        name: 'The Gruffalo',
        scope: 'book',
        role: 'reader',
        clientId: 'cid-999',
      });
    });

    it('round-trips URLs produced by buildJoinShareUrl', () => {
      const built = buildJoinShareUrl({
        folderId: '1AbCdEfGhIjKlMnOp',
        name: 'Grandma Tales',
        scope: 'book',
        role: 'writer',
        clientId: 'client-id-123',
      });

      expect(parseJoinInviteInput(built)).toEqual({
        folderId: '1AbCdEfGhIjKlMnOp',
        name: 'Grandma Tales',
        scope: 'book',
        role: 'writer',
        clientId: 'client-id-123',
      });
    });

    it('parses Google Drive folder URLs in standard, multi-account, and open?id formats', () => {
      expect(
        parseJoinInviteInput(
          'https://drive.google.com/drive/folders/abc123XYZ_99?usp=sharing',
        ),
      ).toEqual({
        folderId: 'abc123XYZ_99',
        name: 'Shared Audiobooks',
        scope: 'library',
        role: 'writer',
      });

      expect(
        parseJoinInviteInput(
          'https://drive.google.com/drive/u/1/folders/abc123XYZ_99',
        ),
      ).toEqual({
        folderId: 'abc123XYZ_99',
        name: 'Shared Audiobooks',
        scope: 'library',
        role: 'writer',
      });

      expect(
        parseJoinInviteInput(
          'https://drive.google.com/open?id=abc123XYZ_99',
        ),
      ).toEqual({
        folderId: 'abc123XYZ_99',
        name: 'Shared Audiobooks',
        scope: 'library',
        role: 'writer',
      });
    });

    it('parses a raw Google Drive folder ID', () => {
      expect(parseJoinInviteInput('1AbCdEfGhIjKlMnOp')).toEqual({
        folderId: '1AbCdEfGhIjKlMnOp',
        name: 'Shared Audiobooks',
        scope: 'library',
        role: 'writer',
      });
    });

    it('returns null for empty or invalid inputs', () => {
      expect(parseJoinInviteInput('')).toBeNull();
      expect(parseJoinInviteInput('    ')).toBeNull();
      expect(parseJoinInviteInput('short')).toBeNull();
      expect(parseJoinInviteInput('https://example.com/not-a-drive-link')).toBeNull();
      expect(parseJoinInviteInput('https://drive.google.com/drive/my-drive')).toBeNull();
      expect(parseJoinInviteInput('#/join?name=MissingFolderId&scope=book')).toBeNull();
      expect(parseJoinInviteInput('not a valid folder id!')).toBeNull();
    });
  });
});
