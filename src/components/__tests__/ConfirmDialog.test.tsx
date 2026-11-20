import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders alertdialog with title, description, cancel, and confirm actions', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmDialog
        open
        title="Delete Recording?"
        description="Permanently delete Chapter 1?"
        confirmLabel="Delete Recording"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Delete Recording?')).toBeInTheDocument();
    expect(screen.getByText('Permanently delete Chapter 1?')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape key and backdrop click, unless busy', () => {
    const onCancel = vi.fn();

    const { rerender } = render(
      <ConfirmDialog
        open
        title="Discard Draft?"
        description="This cannot be undone."
        confirmLabel="Discard Draft"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('confirm-dialog'));
    expect(onCancel).toHaveBeenCalledTimes(2);

    rerender(
      <ConfirmDialog
        open
        isBusy
        title="Discard Draft?"
        description="This cannot be undone."
        confirmLabel="Discard Draft"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('confirm-dialog'));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeDisabled();
  });
});
