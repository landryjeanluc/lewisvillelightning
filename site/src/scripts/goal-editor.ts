type EditableGoal = {
  id: number; title: string; scope: 'team' | 'player'; player_id: string | null;
  target: number; unit: string; starts_on: string; ends_on: string; archived: boolean;
};
type EditorContext = { admin: boolean; today: string; players: { id: string; name: string; number: number }[] };

export function initGoalEditor({ save, onSaved }: {
  save: (path: string, method: string, body: unknown) => Promise<unknown>;
  onSaved: () => void | Promise<void>;
}) {
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
  const editor = $<HTMLDialogElement>('#goal-editor');
  const goalForm = $<HTMLFormElement>('#goal-form');
  const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  let board: EditorContext;
  let editing: EditableGoal | null = null;
  function options(select: HTMLInputElement | HTMLSelectElement, values: { value: string; label: string }[]) {
    select.replaceChildren(...values.map(v => { const o = document.createElement('option'); o.textContent = v.label; o.value = v.value; return o; }));
  }
  const errorText = (e: unknown) => e instanceof Error ? e.message : 'Could not save the goal. Please try again.';
  function setWeek(offset: number) {
    const d = new Date(board.today + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7 + offset * 7);
    field(goalForm, 'starts_on').value = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6); field(goalForm, 'ends_on').value = d.toISOString().slice(0, 10);
  }
  function syncScope() {
    const personal = field(goalForm, 'scope').value === 'player';
    $('#goal-player-field').hidden = !personal; field(goalForm, 'player_id').required = personal;
  }
  function open(context: EditorContext, g: EditableGoal | null = null) {
    if (!context.admin) return;
    board = context;
    editing = g; goalForm.reset(); goalForm.querySelector('.goal-error')!.textContent = '';
    options(field(goalForm, 'player_id'), board.players.map(p => ({ value: p.id, label: `#${p.number} ${p.name}` })));
    $('#goal-editor-title').textContent = g ? 'Edit goal' : 'Set a goal';
    $('#goal-archive-field').hidden = !g;
    if (g) {
      for (const key of ['title', 'scope', 'player_id', 'target', 'unit', 'starts_on', 'ends_on'] as const) field(goalForm, key).value = String(g[key] ?? '');
      (field(goalForm, 'archived') as HTMLInputElement).checked = g.archived;
    } else { field(goalForm, 'scope').value = 'team'; setWeek(0); }
    syncScope(); editor.showModal();
  }
  goalForm.addEventListener('submit', async e => {
    e.preventDefault(); const submit = goalForm.querySelector<HTMLButtonElement>('[type=submit]')!; submit.disabled = true;
    const values = Object.fromEntries(new FormData(goalForm));
    const body = { ...values, player_id: values.scope === 'player' ? values.player_id : null,
      target: Number(values.target), archived: (field(goalForm, 'archived') as HTMLInputElement).checked };
    try {
      await save(editing ? `/${editing.id}` : '', editing ? 'PUT' : 'POST', body);
      editor.close(); await onSaved();
    } catch (err) { goalForm.querySelector('.goal-error')!.textContent = errorText(err); }
    finally { submit.disabled = false; }
  });
  field(goalForm, 'scope').addEventListener('change', syncScope);
  $('#goal-this-week').addEventListener('click', () => setWeek(0));
  $('#goal-next-week').addEventListener('click', () => setWeek(1));
  editor.querySelector('[data-close]')!.addEventListener('click', () => editor.close());
  return { open };
}
