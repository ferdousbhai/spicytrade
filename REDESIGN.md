# spicytrade redesign: diagnosis and plan

Audit per `redesign-existing-projects`, values per `landing-page-design` (both from the
ferdousbhai.com repo's `.claude/skills/`). Written before any fix; the fix log is at the bottom.

## Scan

- TanStack Start + React 19, Tailwind v4 (`@tailwindcss/vite`, no JS config), shadcn on Base UI in
  `src/components/ui`. Most styling is hand written CSS in `src/styles.css`, heavily commented with
  deliberate layout decisions; shadcn tokens are mapped onto the app's own tokens in `.dark`.
- The CSP (`src/server/security-headers.ts`) sets only `base-uri`, `object-src` and
  `frame-ancestors`. Fonts are bundled from `@fontsource-*` by Vite and served from this origin, so
  Geist comes from `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`.
- No marketing page. `/` redirects to `/watch` on purpose (`src/routes/index.tsx`: bookmarks and
  installed shortcuts point at `/`). Surfaces: Watch, Recommendations, Connect, the OAuth
  authorize pages, and the legal pages (`SitePage`).

## Findings

### Typography
- Body face is the system stack (`-apple-system, Segoe UI`), not an approved font. **Fix:** Geist.
- JetBrains Mono styles only `<code>` on Connect (`--mono`); the earlier grep overstated it.
  **Fix:** Geist Mono, and drop the unused `wght-italic.css` import.
- Italics: `.brand em` and `.strip-verdict` already reset `font-style`. The one real italic is
  `<em>` in thesis markdown (`thesis-markdown.tsx`). **Fix:** `.thesis em` set upright, weight 500.
- Off scale sizes throughout: 11, 13, 15, 17, 22, 28px, `--type-body: 1.0625rem` (17px),
  `--type-secondary` 15px, `--type-caption` 13px, `clamp()` headings on the legal pages, and the
  shadcn `sm` button's `text-[0.8rem]`. **Fix:** snap down to the Tailwind scale, then compare
  density in screenshots.
- Weight 700 for nearly every label; 500 and 600 under used. Tabular numerals already on prices.

### Color and surfaces
- `--bg #09090b`, `--surface #171719`, `--surface-2 #222225`, `--muted #1f222b` (a navy tint) are
  outside the dark palette. **Fix:** `#000000`, `#181818`, `#272727`, `#1F1F1F`; theme color too.
- `--axis-gradient` (cheap to rich) is a data scale on the 3px IV rank bar, not a background.
  **Kept** (decision): it encodes meaning.
- Amber `--brand` is the single accent. Pepper red belongs to the logo; green, yellow and red are
  market semantics (cheap, fair, rich; up, down), not accents.
- Hero heading gradient rule does not apply: there is no hero.

### Interactivity and states
- Default curves: `.skip-link` (`.2s`), `.google-sign-in` (`.2s ease`), `runway-pulse`
  (`ease-in-out`), shadcn `transition-all` with the default curve on buttons and nav links.
  **Fix:** base curve `cubic-bezier(0.22,1,0.36,1)`, 300ms for color, 500ms for movement.
- Already good: global focus ring, reduced motion handling, layout shaped skeletons, specific empty
  and error states (no `alert()`), current page marked in the nav, smooth anchor scroll.
- `Spinner` (circular) remains for in-button pending and the token list read. Skill prefers
  skeletons; left as is for in-button pending, which has no layout to stand in for.

### Layout
- `100vh` appears only as the fallback line before `100dvh`. Already correct.
- Desktop nav is already a floating pill sized to content; phone uses a bottom tab bar
  (documented, **kept** by decision).
- Radii mostly from tokens; some ad hoc (`22px` sign-in pill, `10px`, `7px`, `5px`, `3px`). Snap to
  Tailwind steps where touched.

### Iconography
- lucide-react in `spice-app`, `top-bar`, `market-screen`, `brief-screen`,
  `ui/spinner`. **Fix:** `@phosphor-icons/react` (new dependency), one weight throughout.

### Content
- Hyphens in UI copy: "Pre-market", "Sign-in failed — try again", "Sign-out failed — try again",
  "Sign-in unavailable", em dashes in Connect copy, "Signed-in computers". **Fix:** rewrite in
  sentence case without hyphens where the label is ours (not provider data or a CLI command).
- No invented proof anywhere, and none will be added.

### Strategic omissions
- Present: skip links, favicon, meta and Open Graph tags, legal links, back navigation via brand.
- Custom 404: check `notFoundComponent`; leave to the user if missing (new route = new behavior).

## Out of scope / open questions for the user
- **Build a landing page at `/`?** Would replace the `/` to `/watch` redirect. The landing skill's
  hero, proof, tagline reveal and FAQ would all live there. Proof (testimonials, metrics,
  performance) does not exist and must not be invented for a financial product: TODO, needs real
  material from the owner.
- Risk reversal copy ("free", "cancel anytime") is a business fact the repo does not state. TODO.

## Fix log (in the skill's fix priority order)

1. **Fonts.** Geist and Geist Mono via `@fontsource-variable`, served from this origin. JetBrains
   Mono and its unused italic import removed. Markdown emphasis set upright by weight.
2. **Color.** Surfaces snapped to `#000000`, `#181818`, `#1F1F1F`, `#272727`. The browser theme
   colour and the manifest follow. IV rank axis gradient kept (decision).
3. **States.** One easing curve everywhere (300ms colour, 500ms movement). Pressed feedback on
   stories, the focus strip, sort and trade links, nav links and the Google button. The skip link
   moves by transform instead of `top`.
4. **Layout.** All 120 padding, margin and gap declarations in `styles.css` snapped to the spacing
   scale (expressions inside `calc` and `clamp` left alone). Page gutter is 24px on a phone, 32px
   wide. Runway connector offset recomputed for the 12px gap. Off-step radii snapped.
5. **Motion.** Entrance animations at 500ms on the base curve. No scroll reveals: this is a data
   app, and making price and recommendation rows fade in would delay reading them.
6. **Components.** Lucide replaced with Phosphor (regular weight; fill marks a pinned star), and
   `lucide-react` removed.
7. **States.** Branded not-found page added through the root route's `notFoundComponent`.
8. **Copy.** Hyphens and dashes removed from our own UI sentences.
9. **Type.** Sizes snapped down to the Tailwind scale. Exception: multi-line reading text (runway
   detail, empty calendar note, evidence notes, headline snippets, status lines) stays at 14px,
   because 12px was too small in the dense desktop rail (checked in screenshots). Buttons are
   semibold with 12px side padding. Page titles weight 600. Headings use balanced wrapping, body
   text pretty wrapping.

## Left as is, on purpose
- Hyphenated names still in use: "Signed-in computers" (also used by the CLI, MCP server errors
  and the token API) and "Pre-market" (a standard market term, also in server and domain code).
- Legal page copy (terms, privacy, disclosures): not rewritten.
- The `--radius` theme value (10px) is the project's own `rounded-lg` and stays.
- Column dividers and the evidence quote rule use a one-sided hairline. They are layout rules,
  not card borders.
- Spinner kept for in-button pending states, which have no layout for a skeleton to stand in for.
- Drawer swipe physics (vendored shadcn) keep their own curves.
- Default button size stays at `text-sm` instead of the skill's `text-base`. This is a dense
  trading UI, and every button there is secondary.
- Mobile top bar: the status line wraps above Sign in, as it did before.
