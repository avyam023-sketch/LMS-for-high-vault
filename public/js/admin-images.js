// Admin → Site images: uploads the chosen file as the raw request body, then reloads to show it.
document.addEventListener('DOMContentLoaded', () => {
  const root = document.querySelector('[data-site-images]');
  if (!root) return;
  const csrf = root.dataset.csrf;
  root.addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-upload]');
    if (!input || !input.files.length) return;
    const slot = input.dataset.upload;
    const file = input.files[0];
    const status = root.querySelector(`[data-status="${slot}"]`);
    const alt = root.querySelector(`[data-alt-for="${slot}"]`)?.value ?? '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      status.textContent = 'Choose a JPEG, PNG or WebP image.';
      return;
    }
    status.textContent = 'Uploading…';
    input.disabled = true;
    try {
      const res = await fetch(`/admin/site-images/${slot}?alt=${encodeURIComponent(alt)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type, 'x-csrf-token': csrf, Accept: 'application/json' },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed. Try again.');
      status.textContent = 'Saved.';
      window.location.hash = slot;
      window.location.reload();
    } catch (err) {
      status.textContent = err.message;
      input.disabled = false;
      input.value = '';
    }
  });
});
