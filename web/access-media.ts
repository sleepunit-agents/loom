// The build's rewrite of motion and contrast media queries onto <html>'s attributes (vite.config.ts uses it).
import postcss, { type AtRule, type ChildNode, type Container, type Plugin as PostcssPlugin, type Rule } from 'postcss';

/**
 * Accessibility's media queries (src/access.ts): the person's Reduce motion and Higher contrast are attributes on <html>
 * (data-motion, data-contrast), set from their choice, the phone's own setting only while they follow it. So every
 * stylesheet's @media (prefers-reduced-motion: reduce | no-preference) and (prefers-contrast: more), 000h's own
 * included, is rewritten here into the same rules under that attribute: `@media (prefers-reduced-motion: reduce) { .x {…} }`
 * becomes `:where(:root[data-motion="reduce"]) .x {…}`, its specificity unchanged. A query in any other form fails the
 * build, so nothing can ask the phone directly and slip past the choice (src/ui/access-css.test.ts runs it, and reads the built output).
 */
export function accessMedia(): PostcssPlugin {
  const FORMS: Array<[RegExp, string]> = [
    [/^\(\s*prefers-reduced-motion\s*(:\s*reduce\s*)?\)$/, '[data-motion="reduce"]'],
    [/^\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/, '[data-motion="full"]'],
    [/^not\s+\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/, '[data-motion="full"]'],
    [/^\(\s*prefers-contrast\s*:\s*more\s*\)$/, '[data-contrast="more"]'],
  ];
  const scope = (sel: string, attr: string) => {
    const s = sel.trim();
    if (/^:root(?![\w-])/.test(s)) return `:root:where(${attr})${s.slice(5)}`;
    if (/^html(?![\w-])/.test(s)) return `html:where(${attr})${s.slice(4)}`;
    if (s.startsWith('::')) return `:where(:root${attr})${s}`;
    return `:where(:root${attr}) ${s}`;
  };
  // A rule's selectors under the attribute; at-rules inside (a layer, a supports) are walked; keyframes and font faces left.
  const under = (n: Container, attr: string) => n.each((c: ChildNode) => {
    if (c.type === 'rule') (c as Rule).selectors = (c as Rule).selectors.map((x) => scope(x, attr));
    else if (c.type === 'atrule' && !/keyframes$|^font-face$|^property$/.test((c as AtRule).name) && (c as AtRule).nodes) under(c as AtRule, attr);
  });
  return {
    postcssPlugin: 'loom-access-media',
    AtRule: {
      media(m: AtRule) {
        if (!/prefers-(reduced-motion|contrast)/.test(m.params)) return;
        const attr = FORMS.find(([re]) => re.test(m.params.trim()))?.[1];
        if (!attr) throw m.error(`loom-access-media: "@media ${m.params}" isn't a form src/access.ts routes (give it a query of its own)`);
        if (m.parent?.type === 'rule') {
          // Nested in a rule: the same declarations and rules, on that rule only while the attribute is set.
          const r = postcss.rule({ selector: `:where(:root${attr}) &` });
          r.append(m.nodes ?? []);
          m.replaceWith(r);
          return;
        }
        under(m, attr);
        m.replaceWith(m.nodes ?? []);
      },
    },
  };
}
