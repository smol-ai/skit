# Additional icon sources

Geometry is extracted without executing React by `node scripts/extract-icons.mjs <upstream-checkout>`.

- Tabler: `@tabler/icons-react` 3.41.1, MIT, `dist/esm/icons`, upstream `icons-tabler.tsx` slot mapping.
- Phosphor: `@phosphor-icons/react` 2.1.10, MIT, `dist/defs`, light and regular outlines; the right sidebar is mirrored as in upstream's adapter.
- HugeIcons: `@hugeicons/core-free-icons` 4.1.1, MIT, `dist/esm`, upstream `icons-hugeicons.tsx` slot mapping. Play and pause retain upstream's explicit Lucide fallback.

The HugeIcons npm archive declares MIT but omits its LICENSE file. The preserved notice is from the vendor's [LICENSE.md](https://github.com/hugeicons/hugeicons/blob/main/LICENSE.md); [the vendor FAQ](https://hugeicons.com/docs/faqs/license-questions) confirms the core-free-icons package is MIT.
