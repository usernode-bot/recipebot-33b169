(function () {
  const modal = document.getElementById('feedback-modal');
  const text = document.getElementById('feedback-text');
  const status = document.getElementById('feedback-status');
  const submit = document.getElementById('feedback-submit');

  function show(visible) {
    modal.classList.toggle('hidden', !visible);
    if (visible) { text.value = ''; status.classList.add('hidden'); submit.disabled = false; text.focus(); }
  }

  document.getElementById('feedback-fab').addEventListener('click', () => show(true));
  document.getElementById('feedback-cancel').addEventListener('click', () => show(false));
  document.getElementById('feedback-backdrop').addEventListener('click', () => show(false));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit.click(); }
  });

  submit.addEventListener('click', async () => {
    const desc = text.value.trim();
    if (!desc) return;
    submit.disabled = true;
    submit.textContent = 'Sending...';
    status.classList.add('hidden');

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc }),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.error || 'Something went wrong';
        status.className = 'text-sm mt-2 text-red-400';
        status.classList.remove('hidden');
        submit.disabled = false;
        submit.textContent = 'Submit';
        return;
      }
      status.textContent = 'Thanks — feedback received!';
      status.className = 'text-sm mt-2 text-green-400';
      status.classList.remove('hidden');
      text.value = '';
      submit.textContent = 'Submit';
      setTimeout(() => show(false), 4000);
    } catch {
      status.textContent = 'Network error';
      status.className = 'text-sm mt-2 text-red-400';
      status.classList.remove('hidden');
      submit.disabled = false;
      submit.textContent = 'Submit';
    }
  });
})();
