// Live feed of incidents and of reports reaching the district office. Plain DOM, same dark-glass look as the other panels.
import type { ReportReceived, ThreatEvent } from '../contracts/types';

const CSS = `
.tf { position:absolute; right:16px; bottom:16px; width:380px; max-height:42vh; display:flex; flex-direction:column;
  background:rgba(14,20,18,.82); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,.08); border-radius:12px;
  color:#e8ece9; font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; box-shadow:0 8px 30px rgba(0,0,0,.35); }
.tf h3 { margin:0; padding:12px 14px 6px; font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:#9fb3aa; }
.tf .counts { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; padding:0 14px 10px; }
.tf .c { background:rgba(255,255,255,.04); border-radius:8px; padding:6px 8px; }
.tf .c b { display:block; font-size:18px; } .tf .c span { font-size:11px; color:#9fb3aa; }
.tf ul { list-style:none; margin:0; padding:0 8px 10px; overflow:auto; }
.tf li { padding:6px 8px; border-radius:8px; margin:2px 0; border-left:3px solid #6b7c75; background:rgba(255,255,255,.02); }
.tf li.succeeded { border-color:#d9534f; } .tf li.detected { border-color:#f0ad4e; }
.tf li.contained, .tf li.blocked { border-color:#4fb39a; } .tf li.report { border-color:#5aa7e0; }
.tf li time { color:#9fb3aa; margin-right:6px; font-variant-numeric:tabular-nums; }
`;

const clock = (t: number) => {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

export interface ThreatFeed {
  update(threats: ThreatEvent[], reports: ReportReceived[], pendingReports: number): void;
  el: HTMLElement;
}

export function createThreatFeed(root: HTMLElement): ThreatFeed {
  if (!document.getElementById('tf-css')) {
    const st = document.createElement('style');
    st.id = 'tf-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const el = document.createElement('div');
  el.className = 'tf';
  el.innerHTML = `<h3>Incidents and reports</h3>
    <div class="counts">
      <div class="c"><b data-k="attempted">0</b><span>incidents</span></div>
      <div class="c"><b data-k="caught">0</b><span>caught or contained</span></div>
      <div class="c"><b data-k="reports">0</b><span>reports home</span></div>
    </div><ul></ul>`;
  root.appendChild(el);
  const list = el.querySelector('ul')!;
  const set = (k: string, v: string) => { el.querySelector(`[data-k="${k}"]`)!.textContent = v; };
  let attempted = 0, caught = 0, received = 0;

  const add = (cls: string, t: number, text: string) => {
    const li = document.createElement('li');
    li.className = cls;
    li.innerHTML = `<time>${clock(t)}</time>`;
    li.append(text);
    list.prepend(li);
    while (list.children.length > 60) list.lastChild!.remove();
  };

  return {
    el,
    update(threats, reports, pendingReports) {
      for (const th of threats) {
        if (th.outcome === 'succeeded') attempted++;
        else caught++;
        add(th.outcome, th.t, th.text);
      }
      for (const r of reports) {
        received++;
        const mins = Math.round((r.receivedAt - r.alert.t) / 60);
        add('report', r.receivedAt, `Report from ${r.alert.reportedBy} reached the district office after ${r.hops} hop${r.hops === 1 ? '' : 's'}${mins > 0 ? ` (${mins} min)` : ''}: ${r.alert.text}`);
      }
      set('attempted', String(attempted + caught));
      set('caught', String(caught));
      set('reports', `${received}${pendingReports ? ` (+${pendingReports} on the way)` : ''}`);
    },
  };
}
