/** Hide the editor without destroying its iframe while confirmed saves finish. */
export async function closeWorkOrderInBackground(input: {
  shell: HTMLElement | null | undefined;
  waitForWrites: () => Promise<boolean>;
  saveOrClose: () => Promise<boolean | undefined>;
  onError: () => void;
}) {
  const priorVisibility = input.shell?.style.visibility || '';
  if (input.shell) input.shell.style.visibility = 'hidden';
  try {
    const complete = await input.waitForWrites() && await input.saveOrClose();
    if (!complete && input.shell?.isConnected) input.shell.style.visibility = priorVisibility;
    return Boolean(complete);
  } catch {
    if (input.shell?.isConnected) input.shell.style.visibility = priorVisibility;
    input.onError();
    return false;
  }
}
