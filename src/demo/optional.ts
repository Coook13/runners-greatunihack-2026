// Optional modules other parts of the team build: the intro fly-in (src/intro/), the black box driver
// screen (src/ui/blackbox.ts) and the glass box auditor view (src/ui/glassbox.ts).
// import.meta.glob returns an empty map for files that don't exist, so the demo builds and runs
// with or without them. main.ts can also hand the director these directly (DirectorOptions).

type Mod = Record<string, unknown>;
export type AnyFn = (...args: unknown[]) => unknown;
export type Loaders = Record<string, () => Promise<unknown>>;

const MODULES: Loaders = import.meta.glob(['../intro/*.ts', '../ui/blackbox.ts', '../ui/glassbox.ts']);

const WHERE = {
  intro: /\/intro\/[^/]+\.ts$/,
  blackbox: /\/ui\/blackbox\.ts$/,
  glassbox: /\/ui\/glassbox\.ts$/,
} as const;

/** Names we look for, best first: a view factory `create...(root)` returning { show(info) }, or a plain function. */
export const OPTIONAL_FNS = {
  intro: { factory: [], fns: ['playIntro'] },
  blackbox: { factory: ['createBlackBoxView'], fns: ['showBlackBox', 'openBlackBox', 'renderBlackBox'] },
  glassbox: { factory: ['createGlassBoxView', 'createGlassBox'], fns: ['showGlassBox', 'openGlassBox', 'renderGlassBox'] },
} as const;

export type OptionalKind = keyof typeof WHERE;

/** A panel the director can show and hide. */
export interface ViewLike { show(info: unknown): void; hide(): void }

async function modulesFor(kind: OptionalKind, modules: Loaders): Promise<Mod[]> {
  const out: Mod[] = [];
  for (const p of Object.keys(modules).filter((x) => WHERE[kind].test(x)).sort()) {
    try {
      out.push((await modules[p]()) as Mod);
    } catch (e) {
      console.warn(`[demo] could not load ${p}`, e);
    }
  }
  return out;
}

/** The first plain function from OPTIONAL_FNS[kind].fns, or null if no module exports one. */
export async function findOptional(kind: OptionalKind, modules: Loaders = MODULES): Promise<AnyFn | null> {
  for (const mod of await modulesFor(kind, modules)) {
    for (const name of OPTIONAL_FNS[kind].fns) if (typeof mod[name] === 'function') return mod[name] as AnyFn;
  }
  return null;
}

/** A view for the black box or glass box: built once from the module's factory, or wrapping its show function. */
export async function findView(kind: 'blackbox' | 'glassbox', parent: HTMLElement | null, modules: Loaders = MODULES): Promise<ViewLike | null> {
  for (const mod of await modulesFor(kind, modules)) {
    for (const name of OPTIONAL_FNS[kind].factory) {
      if (typeof mod[name] !== 'function' || !parent) continue;
      const view = (mod[name] as AnyFn)(parent) as { show?: (x: unknown) => void } | null;
      if (view && typeof view.show === 'function') return { show: (i) => view.show!(i), hide: () => view.show!(null) };
    }
    for (const name of OPTIONAL_FNS[kind].fns) {
      const fn = mod[name];
      if (typeof fn === 'function') return { show: (i) => (fn as AnyFn)(i), hide: () => {} };
    }
  }
  return null;
}
