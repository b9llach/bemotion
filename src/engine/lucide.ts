/**
 * Lucide icons by name. The ~1500 icons are not bundled into the engine: the server reads them from
 * the lucide-static package on disk (GET /__bemotion/icon/<name>.svg), so renders stay offline and
 * the same every time.
 */
const cache = new Map<string, Promise<string>>();

export function lucideSvg(name: string): Promise<string> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`Unknown icon "${name}": icon names are kebab-case Lucide names, like "arrow-right"`);
      const res = await fetch(`/__bemotion/icon/${name}.svg`);
      if (!res.ok) throw new Error(`Unknown icon "${name}". ${(await res.text()).trim()}`);
      return res.text();
    })();
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}
