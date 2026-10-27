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
- lucide-react in `spice-app`, `top-bar`, `market-screen`, `brief-screen`, `catalyst-stories`?,
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

## Fix log
(filled in as commits land)
