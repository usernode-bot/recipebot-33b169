// Shared comment thread — used by the recipe panel's social section
// (published recipes) and by the collection detail view (issue #35). Both
// backends return the same row shape:
//   { id, username, body, created_at, deleted, is_mine }
// so one renderer covers both; keeping it here stops the two threads from
// drifting apart.
const CommentThread = {
  esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // opts:
  //   comments      rows in the shape above (oldest first)
  //   heading       (n) => string — section heading with the live count
  //   placeholder   input placeholder text
  //   signInReason  passed to App.promptSignIn for anonymous visitors
  //   canModerate   true when the viewer owns the thing being commented on
  //                 (recipe owner / collection owner) — they may delete any
  //                 comment, on top of everyone deleting their own
  //   onPost(body)  async; the caller reloads the thread afterwards
  //   onDelete(id)  async; same
  render(container, opts) {
    if (!container) return;
    const comments = opts.comments || [];
    const live = comments.filter((c) => !c.deleted);
    const anonymous = typeof App !== 'undefined' && App.isAnonymous;

    container.innerHTML = '';

    const heading = document.createElement('h3');
    heading.className = 'text-sm font-semibold mb-2';
    heading.textContent = opts.heading
      ? opts.heading(live.length)
      : t('social.comments', { n: live.length });
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'space-y-2';
    container.appendChild(list);

    if (!comments.length) {
      const empty = document.createElement('p');
      empty.className = 'text-xs text-zinc-400 dark:text-zinc-500';
      empty.textContent = t('social.noComments');
      list.appendChild(empty);
    }

    comments.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'p-3 rounded-lg bg-zinc-100/70 dark:bg-zinc-900/50 text-sm flex items-start justify-between gap-2 min-w-0';
      if (c.deleted) {
        row.innerHTML = `<p class="text-xs italic text-zinc-400 dark:text-zinc-600">${t('social.commentDeleted')}</p>`;
      } else {
        row.innerHTML = `<div class="min-w-0">
          <span class="font-medium">${this.esc(c.username)}</span>
          <p class="text-zinc-500 dark:text-zinc-400 mt-0.5 break-words">${this.esc(c.body)}</p>
        </div>`;
        if (c.is_mine || opts.canModerate) {
          const del = document.createElement('button');
          del.className = 'text-xs text-zinc-400 hover:text-red-500 transition-colors shrink-0';
          del.textContent = t('common.delete');
          del.addEventListener('click', () => opts.onDelete?.(c.id));
          row.appendChild(del);
        }
      }
      list.appendChild(row);
    });

    if (anonymous) {
      const signIn = document.createElement('button');
      signIn.className = 'w-full px-4 py-2 text-sm rounded-lg bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-left transition-colors mt-2';
      signIn.textContent = t('social.signInToComment');
      signIn.addEventListener('click', () => App.promptSignIn(opts.signInReason || t('signin.comment')));
      container.appendChild(signIn);
      return;
    }

    const form = document.createElement('form');
    form.className = 'flex gap-2 mt-2';
    form.innerHTML = `
      <input type="text" maxlength="1000" placeholder="${this.esc(opts.placeholder || t('social.addComment'))}"
        class="comment-input flex-1 min-w-0 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500">
      <button type="submit" class="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors shrink-0">${t('common.post')}</button>`;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('.comment-input');
      const body = input.value.trim();
      if (!body) return;
      input.value = '';
      opts.onPost?.(body);
    });
    container.appendChild(form);
  },
};
