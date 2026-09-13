// HTML5 drag-and-drop for Kanban columns: reports (taskId, status, index) on drop.
export function enableColumnDnd(board, { onDrop, cardSelector = '.kcard', columnSelector = '.kcol-body' }) {
  let dragging = null;
  let placeholder = null;

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest(cardSelector);
    if (!card) return;
    dragging = card;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch { /* ignore */ }
    placeholder = document.createElement('div');
    placeholder.className = 'kcard-placeholder';
    placeholder.style.height = `${card.offsetHeight}px`;
    requestAnimationFrame(() => card.classList.add('dragging'));
  });

  board.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const col = e.target.closest(columnSelector);
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cards = [...col.querySelectorAll(cardSelector)].filter((c) => c !== dragging);
    let inserted = false;
    for (const c of cards) {
      const rect = c.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { col.insertBefore(placeholder, c); inserted = true; break; }
    }
    if (!inserted) col.appendChild(placeholder);
    board.querySelectorAll('.kcol.drop-target').forEach((k) => k.classList.remove('drop-target'));
    col.closest('.kcol')?.classList.add('drop-target');
  });

  board.addEventListener('drop', (e) => {
    if (!dragging || !placeholder?.parentNode) return;
    e.preventDefault();
    const col = placeholder.parentNode;
    const status = col.dataset.status;
    const siblings = [...col.children].filter((c) => c !== dragging);
    const index = siblings.indexOf(placeholder);
    col.insertBefore(dragging, placeholder);
    onDrop({ id: dragging.dataset.id, status, index, fromStatus: dragging.dataset.status });
    cleanup();
  });

  board.addEventListener('dragend', cleanup);

  function cleanup() {
    if (placeholder?.parentNode) placeholder.parentNode.removeChild(placeholder);
    dragging?.classList.remove('dragging');
    board.querySelectorAll('.kcol.drop-target').forEach((k) => k.classList.remove('drop-target'));
    dragging = null; placeholder = null;
  }
}
