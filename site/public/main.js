// Copy buttons. If Glass is installed on this page, copies are tracked as events.
for (const button of document.querySelectorAll('button[data-copy], button[data-copy-from]')) {
  button.addEventListener('click', async () => {
    const text =
      button.dataset.copy ??
      document.getElementById(button.dataset.copyFrom)?.textContent?.trim() ??
      '';
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      window.glass?.capture(button.dataset.event ?? 'copied', { text: text.slice(0, 80) });
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => {
      button.textContent = label;
    }, 1600);
  });
}
